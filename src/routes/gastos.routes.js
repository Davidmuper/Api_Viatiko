import { Router } from 'express';
import multer from 'multer';
import { PrismaClient } from '@prisma/client';
import { analizarComprobanteConGemini } from '../services/gemini.service.js';
import { generarExportacionContable } from '../services/excel.service.js';

const router = Router();
const prisma = new PrismaClient();

// Configuración de multer en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const EMPRESA_POR_DEFECTO = 'Petroquímicos S.A.';

/**
 * Determina el empresaId obligatorio para Gasto y ViajeLiquidado.
 * Prioridad: empresa recibida (ID o nombre) → empresa del conductor → empresa de la placa
 * → empresa por defecto → primera empresa registrada.
 */
async function resolverEmpresaId({ empresa, conductor, placa } = {}) {
  if (empresa !== undefined && empresa !== null && String(empresa).trim() !== '') {
    const valor = String(empresa).trim();
    const registro = /^\d+$/.test(valor)
      ? await prisma.empresa.findUnique({ where: { id: Number(valor) } })
      : await prisma.empresa.findFirst({ where: { nombre: { equals: valor, mode: 'insensitive' } } });
    if (registro) return registro.id;
  }

  if (conductor) {
    const c = await prisma.conductor.findFirst({ where: { nombre: String(conductor) } });
    if (c) return c.empresaId;
  }

  if (placa) {
    const c = await prisma.conductor.findFirst({ where: { placa: String(placa) } });
    if (c) return c.empresaId;
  }

  const porDefecto = await prisma.empresa.findFirst({ where: { nombre: EMPRESA_POR_DEFECTO } })
    || await prisma.empresa.findFirst({ orderBy: { id: 'asc' } });
  return porDefecto ? porDefecto.id : null;
}

// El esquema guarda la fecha como String 'YYYY-MM-DD'
function fechaComoTexto(valor) {
  const fecha = valor ? new Date(valor) : new Date();
  return Number.isNaN(fecha.getTime())
    ? new Date().toISOString().slice(0, 10)
    : fecha.toISOString().slice(0, 10);
}

// Acepta el archivo tanto si el frontend envía 'comprobante' como si envía 'imagen'
const uploadAnalisis = upload.fields([
  { name: 'comprobante', maxCount: 1 },
  { name: 'imagen', maxCount: 1 }
]);

// 1. Obtener lista de conductores (por empresa)
router.get('/conductores', async (req, res) => {
  try {
    const { empresa } = req.query;
    const whereClause = empresa ? { empresa: { nombre: empresa } } : {};
    
    let conductores = await prisma.conductor.findMany({
      where: whereClause
    });

    if (conductores.length === 0) {
      conductores = await prisma.conductor.findMany();
    }

    return res.json(conductores);
  } catch (error) {
    console.error('Error obteniendo conductores:', error);
    return res.status(500).json({ error: 'Error cargando conductores' });
  }
});

// 2. Obtener cuentas PUC
router.get('/puc', async (req, res) => {
  try {
    const cuentas = await prisma.puc.findMany();
    return res.json(cuentas);
  } catch (error) {
    console.error('Error obteniendo PUC:', error);
    return res.status(500).json({ error: 'Error cargando cuentas PUC' });
  }
});

// 3. Inicio de sesión
router.post('/login', async (req, res) => {
  try {
    const { conductorId, usuario, password, empresa } = req.body;

    let conductor;
    if (conductorId) {
      conductor = await prisma.conductor.findUnique({
        where: { id: Number(conductorId) }
      });
    } else if (usuario) {
      conductor = await prisma.conductor.findFirst({
        where: { nombre: usuario }
      });
    } else {
      conductor = await prisma.conductor.findFirst();
    }

    if (!conductor) {
      return res.status(401).json({ error: 'Conductor o perfil no válido' });
    }

    return res.json({
      success: true,
      conductor: conductor,
      token: 'jwt-session-token'
    });
  } catch (error) {
    console.error('Error en login:', error);
    return res.status(500).json({ error: 'Fallo al autenticar' });
  }
});

// 4. Actualizar anticipo de conductor (PATCH)
router.patch('/conductores/:id/anticipo', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const anticipo = Number(req.body.anticipo);

    if (!Number.isFinite(id) || !Number.isFinite(anticipo) || anticipo < 0) {
      return res.status(400).json({ error: 'ID o anticipo inválido' });
    }

    const conductor = await prisma.conductor.update({
      where: { id },
      data: { anticipo }
    });

    return res.json({
      status: 'success',
      conductor: conductor.nombre,
      nuevoAnticipo: conductor.anticipo
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }
    console.error('Error al actualizar anticipo:', error);
    return res.status(500).json({ error: 'Error interno al actualizar el anticipo' });
  }
});

// 5. Analizar comprobante con Gemini OCR
router.post('/analizar', uploadAnalisis, async (req, res) => {
  try {
    const archivo = req.files?.['comprobante']?.[0] || req.files?.['imagen']?.[0] || req.file;

    if (!archivo) {
      return res.status(400).json({ error: 'No se subió ninguna imagen o comprobante' });
    }

    const datosExtraidos = await analizarComprobanteConGemini(
      archivo.buffer,
      archivo.mimetype
    );

    return res.json(datosExtraidos);
  } catch (error) {
    console.error('Error en /analizar:', error);
    return res.status(500).json({ error: 'Error analizando la imagen.' });
  }
});

// 6. Consultar gastos activos del viaje en curso (solo sin liquidar)
router.get('/', async (req, res) => {
  try {
    const { conductor } = req.query;
    const whereClause = {
      ...(conductor ? { conductor: String(conductor) } : {}),
      viajeId: null
    };

    const gastos = await prisma.gasto.findMany({
      where: whereClause,
      orderBy: { id: 'desc' }
    });

    return res.json(gastos);
  } catch (error) {
    console.error('Error listando gastos activos:', error);
    return res.status(500).json({ error: 'Error obteniendo los gastos' });
  }
});

// 7. Guardar gasto (POST / y alias POST /gastos)
const guardarGastoHandler = async (req, res) => {
  try {
    const {
      empresa,
      empresaId: empresaIdBody,
      viajeId,
      fecha,
      establecimiento,
      nit,
      consecutivo,
      categoria,
      cuenta_contable,
      total,
      placa,
      conductor,
      metodo,
      tipo_registro,
      observacion
    } = req.body;

    const empresaId = await resolverEmpresaId({ empresa: empresaIdBody ?? empresa, conductor, placa });
    if (!empresaId) {
      return res.status(400).json({ error: 'No hay ninguna empresa registrada para asociar el gasto' });
    }

    // Asignación directa y segura de código PUC sin consultar campos inexistentes
    let cta = cuenta_contable;
    if (!cta && categoria) {
      const cat = String(categoria).toLowerCase();
      if (cat.includes('combustible')) cta = '519525';
      else if (cat.includes('peaje')) cta = '519530';
      else if (cat.includes('parqueadero') || cat.includes('lavado')) cta = '519535';
      else if (cat.includes('mantenimiento') || cat.includes('taller')) cta = '514510';
      else if (cat.includes('alimentacion') || cat.includes('viatico')) cta = '519565';
      else cta = '519595';
    }

    const nuevoGasto = await prisma.gasto.create({
      data: {
        empresaId,
        viajeId: viajeId ? Number(viajeId) : null,
        fecha: fechaComoTexto(fecha),
        establecimiento: establecimiento || 'Sin nombre',
        nit: nit || 'Sin NIT',
        consecutivo: consecutivo || 'S/N',
        categoria: categoria || 'Otros',
        cuenta_contable: cta || '519595',
        total: Number(total) || 0,
        placa: placa || '',
        conductor: conductor || '',
        metodo: metodo || 'Efectivo',
        tipo_registro: tipo_registro || 'comprobante',
        observacion: observacion || ''
      }
    });

    return res.status(201).json(nuevoGasto);
  } catch (error) {
    console.error('Error guardando gasto:', error);
    return res.status(500).json({ error: 'No se pudo registrar el gasto', detalle: error.message });
  }
};

router.post('/', guardarGastoHandler);
router.post('/gastos', guardarGastoHandler);

// 8. Finalizar liquidación de viaje y reiniciar anticipo
router.post('/finalizar-liquidacion', async (req, res) => {
  try {
    const { conductorId, conductor, usuario, placa } = req.body;

    const nombreBuscado = conductor || usuario;

    let targetConductor = null;
    if (conductorId) {
      targetConductor = await prisma.conductor.findUnique({
        where: { id: Number(conductorId) }
      });
    } else if (nombreBuscado) {
      targetConductor = await prisma.conductor.findFirst({
        where: { nombre: { contains: nombreBuscado, mode: 'insensitive' } }
      });
    }

    if (!targetConductor && placa) {
      targetConductor = await prisma.conductor.findFirst({
        where: { placa: placa }
      });
    }

    if (!targetConductor) {
      return res.status(404).json({ error: 'Conductor no encontrado para liquidar' });
    }

    // Buscar gastos activos pendientes de este conductor
    const gastosActivos = await prisma.gasto.findMany({
      where: {
        conductor: targetConductor.nombre,
        viajeId: null
      }
    });

    const totalGastos = gastosActivos.reduce((acc, curr) => acc + (Number(curr.total) || 0), 0);
    const anticipoInicial = Number(targetConductor.anticipo) || 0;
    const saldo = anticipoInicial - totalGastos;

    // Crear registro en ViajeLiquidado (campos según prisma/schema.prisma)
    const resumenGastos = gastosActivos.map(g => ({
      id: g.id,
      fecha: g.fecha,
      establecimiento: g.establecimiento,
      nit: g.nit,
      consecutivo: g.consecutivo,
      categoria: g.categoria,
      cuenta_contable: g.cuenta_contable,
      total: g.total,
      observacion: g.observacion
    }));

    const viajeLiquidado = await prisma.viajeLiquidado.create({
      data: {
        empresaId: targetConductor.empresaId,
        fechaCierre: fechaComoTexto(),
        conductor: targetConductor.nombre,
        placa: placa || targetConductor.placa || 'FLOTA',
        anticipoTotal: anticipoInicial,
        gastosTotal: totalGastos,
        saldoFinal: saldo,
        resumenGastos: JSON.stringify(resumenGastos)
      }
    });

    // Vincular los gastos activos a la liquidación para que salgan del viaje en curso
    if (gastosActivos.length > 0) {
      await prisma.gasto.updateMany({
        where: {
          id: { in: gastosActivos.map(g => g.id) }
        },
        data: {
          viajeId: viajeLiquidado.id
        }
      });
    }

    // Restablecer anticipo del conductor a 0
    await prisma.conductor.update({
      where: { id: targetConductor.id },
      data: { anticipo: 0 }
    });

    return res.json({
      success: true,
      mensaje: 'Viaje liquidado con éxito',
      liquidacion: viajeLiquidado
    });
  } catch (error) {
    console.error('Error detallado finalizando liquidacion:', error);
    return res.status(500).json({ 
      error: 'Error al procesar la liquidación',
      detalle: error.message 
    });
  }
});

// 9. Historial de viajes liquidados
router.get('/viajes-historial', async (req, res) => {
  try {
    const { conductor } = req.query;
    const whereClause = conductor ? { conductor: String(conductor) } : {};

    const historial = await prisma.viajeLiquidado.findMany({
      where: whereClause,
      orderBy: { id: 'desc' }
    });

    return res.json(historial);
  } catch (error) {
    console.error('Error obteniendo historial:', error);
    return res.status(500).json({ error: 'Error cargando historial' });
  }
});

// 10. Exportar liquidación contable a Excel
router.get('/exportar-contable', async (req, res) => {
  try {
    const { empresa, software = 'SIIGO' } = req.query;

    const gastos = await prisma.gasto.findMany({
      orderBy: { id: 'desc' }
    });

    const bufferExcel = await generarExportacionContable(
      { empresa: empresa || 'VIATIKO', vehiculo: 'CONSOLIDADO' },
      gastos,
      String(software).toUpperCase(),
      '133015'
    );

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=plano_${software.toLowerCase()}_${Date.now()}.xlsx`
    );

    return res.send(bufferExcel);
  } catch (error) {
    console.error('Error generando plano contable:', error);
    return res.status(500).json({ error: 'Error al exportar los datos contables' });
  }
});

export default router;