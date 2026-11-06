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

// 6. Consultar gastos activos del viaje en curso
router.get('/', async (req, res) => {
  try {
    const { conductor, empresa } = req.query;
    const whereClause = {
      ...(conductor ? { conductor: String(conductor) } : {})
    };

    const gastos = await prisma.gasto.findMany({
      where: whereClause,
      orderBy: { id: 'desc' }
    });

    return res.json(gastos);
  } catch (error) {
    console.error('Error listando gastos:', error);
    return res.status(500).json({ error: 'Error obteniendo los gastos' });
  }
});

// 7. Guardar gasto (POST / y alias POST /gastos)
const guardarGastoHandler = async (req, res) => {
  try {
    const {
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
      observacion
    } = req.body;

    let cta = cuenta_contable;
    if (!cta && categoria) {
      const pucMatch = await prisma.puc.findFirst({
        where: { categoria: { contains: categoria, mode: 'insensitive' } }
      });
      if (pucMatch) cta = pucMatch.codigo;
    }

    const nuevoGasto = await prisma.gasto.create({
      data: {
        viajeId: viajeId ? Number(viajeId) : null,
        fecha: fecha ? new Date(fecha) : new Date(),
        establecimiento: establecimiento || 'Sin nombre',
        nit: nit || 'Sin NIT',
        consecutivo: consecutivo || 'S/N',
        categoria: categoria || 'Otros',
        cuenta_contable: cta || '519595',
        total: Number(total) || 0,
        placa: placa || '',
        conductor: conductor || ''
      }
    });

    return res.status(201).json(nuevoGasto);
  } catch (error) {
    console.error('Error guardando gasto:', error);
    return res.status(500).json({ error: 'No se pudo registrar el gasto' });
  }
};

router.post('/', guardarGastoHandler);
router.post('/gastos', guardarGastoHandler);

// 8. Finalizar liquidación de viaje y reiniciar anticipo
router.post('/finalizar-liquidacion', async (req, res) => {
  try {
    const { conductorId, conductor, placa, empresa } = req.body;

    let targetConductor;
    if (conductorId) {
      targetConductor = await prisma.conductor.findUnique({
        where: { id: Number(conductorId) }
      });
    } else if (conductor) {
      targetConductor = await prisma.conductor.findFirst({
        where: { nombre: conductor }
      });
    }

    if (!targetConductor) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    // Buscar gastos activos asociados
    const gastosActivos = await prisma.gasto.findMany({
      where: {
        conductor: targetConductor.nombre
      }
    });

    const totalGastos = gastosActivos.reduce((acc, curr) => acc + (Number(curr.total) || 0), 0);
    const anticipoInicial = Number(targetConductor.anticipo) || 0;
    const saldo = anticipoInicial - totalGastos;

    // Crear registro en ViajeLiquidado
    const viajeLiquidado = await prisma.viajeLiquidado.create({
      data: {
        conductor: targetConductor.nombre,
        vehiculo: placa || targetConductor.placa || 'FLOTA',
        anticipo: anticipoInicial,
        totalGastos: totalGastos,
        saldo: saldo
      }
    });

    // Resetear anticipo a 0
    await prisma.conductor.update({
      where: { id: targetConductor.id },
      data: { anticipo: 0 }
    });

    return res.json({
      success: true,
      mensaje: 'Viaje liquidado exitosamente',
      liquidacion: viajeLiquidado
    });
  } catch (error) {
    console.error('Error finalizando liquidacion:', error);
    return res.status(500).json({ error: 'Error al procesar la liquidación' });
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