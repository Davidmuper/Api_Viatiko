import { Router } from 'express';
import multer from 'multer';
import prisma from '../services/db.service.js';
import { analizarComprobanteConGemini } from '../services/gemini.service.js';
import { generarExportacionContable } from '../services/excel.service.js';

const router = Router();

const EMPRESA_POR_DEFECTO = 'Petroquímicos S.A.';
const CUENTA_ANTICIPO = '133015';
const SOFTWARES_CONTABLES = ['SIIGO', 'LOGGRO', 'GENERICO'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ---------- Utilidades ----------

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

async function buscarEmpresa(nombre) {
  return prisma.empresa.findFirst({ where: { nombre: nombre || EMPRESA_POR_DEFECTO } });
}

function nombreArchivoSeguro(texto) {
  return String(texto || 'empresa')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function enviarExcel(res, buffer, nombreArchivo) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
  return res.send(Buffer.from(buffer));
}

// ---------- Conductores ----------

// Obtener lista de conductores (por empresa)
router.get('/conductores', async (req, res) => {
  try {
    const { empresa } = req.query;
    const whereClause = empresa ? { empresa: { nombre: empresa } } : {};

    let conductores = await prisma.conductor.findMany({ where: whereClause });

    // Si la empresa no coincide con ninguna, devolver todos los conductores
    if (conductores.length === 0) {
      conductores = await prisma.conductor.findMany();
    }

    return res.json(conductores);
  } catch (error) {
    console.error('Error obteniendo conductores:', error);
    return res.status(500).json({ error: 'Error cargando conductores' });
  }
});

// Actualizar el anticipo de un conductor por ID
router.patch('/conductores/:id/anticipo', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const anticipo = Number(req.body.anticipo);

    if (!Number.isInteger(id) || !Number.isFinite(anticipo) || anticipo < 0) {
      return res.status(400).json({ error: 'ID de conductor o valor de anticipo inválido' });
    }

    const conductor = await prisma.conductor.update({
      where: { id },
      data: { anticipo }
    });

    return res.json({
      status: 'success',
      mensaje: 'Anticipo actualizado correctamente',
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

// ---------- PUC y sesión ----------

router.get('/puc', async (req, res) => {
  try {
    const cuentas = await prisma.puc.findMany();
    return res.json(cuentas);
  } catch (error) {
    console.error('Error obteniendo PUC:', error);
    return res.status(500).json({ error: 'Error cargando cuentas PUC' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { conductorId } = req.body;

    const conductor = await prisma.conductor.findFirst({
      where: conductorId ? { id: Number(conductorId) } : {}
    });

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

// ---------- Gastos ----------

router.post('/analizar', upload.single('imagen'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió ninguna imagen' });
    }

    const datosExtraidos = await analizarComprobanteConGemini(req.file.buffer, req.file.mimetype);
    return res.json(datosExtraidos);
  } catch (error) {
    console.error('Error en /analizar:', error);
    return res.status(500).json({ error: 'Error analizando la imagen.' });
  }
});

// Listar gastos (por defecto, los activos del viaje en curso)
router.get('/', async (req, res) => {
  try {
    const { empresa, conductor, estado } = req.query;
    const where = { estado: estado || 'activo' };
    if (empresa) where.empresa = { nombre: empresa };
    if (conductor) where.conductor = conductor;

    const gastos = await prisma.gasto.findMany({ where, orderBy: { id: 'desc' } });
    return res.json(gastos);
  } catch (error) {
    console.error('Error listando gastos:', error);
    return res.status(500).json({ error: 'Error cargando los gastos' });
  }
});

// Registrar gasto ('/gastos' se conserva por compatibilidad)
async function crearGasto(req, res) {
  try {
    const {
      empresa, viajeId, fecha, establecimiento, nit, consecutivo, categoria,
      cuenta_contable, centro_costos, total, placa, conductor, metodo,
      tipo_registro, observacion
    } = req.body;

    const monto = Number(total);
    if (!Number.isFinite(monto) || monto <= 0) {
      return res.status(400).json({ error: 'El total del gasto debe ser mayor a cero' });
    }

    const empresaRecord = await buscarEmpresa(empresa);
    if (!empresaRecord) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }

    // Si no llega cuenta contable, se toma la del PUC según la categoría
    let cuenta = cuenta_contable;
    if (!cuenta && categoria) {
      const puc = await prisma.puc.findFirst({
        where: { empresaId: empresaRecord.id, nombre: categoria }
      });
      cuenta = puc?.codigo;
    }

    const nuevoGasto = await prisma.gasto.create({
      data: {
        empresaId: empresaRecord.id,
        viajeId: viajeId ? Number(viajeId) : null,
        fecha: fecha ? String(fecha).slice(0, 10) : hoyISO(),
        establecimiento: establecimiento || 'Sin nombre',
        nit: nit || 'Sin NIT',
        consecutivo: consecutivo || 'S/N',
        categoria: categoria || 'Otros',
        cuenta_contable: cuenta || '519595',
        centro_costos: centro_costos || placa || '',
        total: monto,
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
    return res.status(500).json({ error: 'No se pudo registrar el gasto en la base de datos.' });
  }
}

router.post('/', crearGasto);
router.post('/gastos', crearGasto);

// ---------- Liquidación de viajes ----------

// Cierra el viaje: consolida gastos activos, crea la planilla y deja el anticipo en 0
router.post('/finalizar-liquidacion', async (req, res) => {
  try {
    const { empresa, conductor, conductorId, placa } = req.body;

    if (!conductor && !conductorId) {
      return res.status(400).json({ error: 'Debe indicar el conductor o conductorId' });
    }

    const empresaRecord = await buscarEmpresa(empresa);
    if (!empresaRecord) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }

    const conductorRecord = await prisma.conductor.findFirst({
      where: conductorId
        ? { id: Number(conductorId), empresaId: empresaRecord.id }
        : { nombre: conductor, empresaId: empresaRecord.id }
    });
    if (!conductorRecord) {
      return res.status(404).json({ error: 'Conductor no registrado en la empresa' });
    }

    const liquidacion = await prisma.$transaction(async (tx) => {
      const gastos = await tx.gasto.findMany({
        where: {
          empresaId: empresaRecord.id,
          conductor: conductorRecord.nombre,
          estado: 'activo'
        },
        orderBy: { id: 'asc' }
      });

      const anticipo = Number(conductorRecord.anticipo) || 0;
      if (gastos.length === 0 && anticipo === 0) {
        return null;
      }

      const totalGastos = gastos.reduce((suma, g) => suma + (Number(g.total) || 0), 0);
      const resumen = gastos.map((g) => ({
        id: g.id,
        fecha: g.fecha,
        establecimiento: g.establecimiento,
        nit: g.nit,
        consecutivo: g.consecutivo,
        categoria: g.categoria,
        cuenta_contable: g.cuenta_contable,
        total: g.total,
        observacion: g.observacion,
        tipo_registro: g.tipo_registro
      }));

      const viaje = await tx.viajeLiquidado.create({
        data: {
          empresaId: empresaRecord.id,
          fechaCierre: hoyISO(),
          conductor: conductorRecord.nombre,
          placa: placa || conductorRecord.placa,
          anticipoTotal: anticipo,
          gastosTotal: totalGastos,
          saldoFinal: anticipo - totalGastos,
          resumenGastos: JSON.stringify(resumen)
        }
      });

      if (gastos.length > 0) {
        await tx.gasto.updateMany({
          where: { id: { in: gastos.map((g) => g.id) } },
          data: { estado: 'liquidado', viajeId: viaje.id }
        });
      }

      await tx.conductor.update({
        where: { id: conductorRecord.id },
        data: { anticipo: 0 }
      });

      return viaje;
    });

    if (!liquidacion) {
      return res.status(400).json({ error: 'No hay gastos ni anticipo pendientes por liquidar' });
    }

    return res.json({ success: true, liquidacion });
  } catch (error) {
    console.error('Error finalizando liquidación:', error);
    return res.status(500).json({ error: 'Error al liquidar el viaje' });
  }
});

// Historial de viajes liquidados (filtrable por empresa y/o conductor)
router.get('/viajes-historial', async (req, res) => {
  try {
    const { empresa, conductor } = req.query;
    const where = {};
    if (empresa) where.empresa = { nombre: empresa };
    if (conductor) where.conductor = conductor;

    const viajes = await prisma.viajeLiquidado.findMany({
      where,
      orderBy: { id: 'desc' }
    });

    return res.json(viajes);
  } catch (error) {
    console.error('Error obteniendo historial de viajes:', error);
    return res.status(500).json({ error: 'Error cargando el historial de viajes' });
  }
});

// ---------- Exportación contable (Siigo / Loggro / Genérico) ----------

function leerSoftware(req) {
  const software = String(req.query.software || 'SIIGO').toUpperCase();
  return SOFTWARES_CONTABLES.includes(software) ? software : null;
}

// Plano contable de la empresa: gastos liquidados pendientes de contabilizar
router.get('/exportar-contable', async (req, res) => {
  try {
    const software = leerSoftware(req);
    if (!software) {
      return res.status(400).json({ error: `Software no soportado. Use: ${SOFTWARES_CONTABLES.join(', ')}` });
    }

    const empresaRecord = await buscarEmpresa(req.query.empresa);
    if (!empresaRecord) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }

    const gastos = await prisma.gasto.findMany({
      where: {
        empresaId: empresaRecord.id,
        estado: 'liquidado',
        estado_contable: 'pendiente'
      },
      orderBy: [{ viajeId: 'asc' }, { id: 'asc' }]
    });

    const buffer = await generarExportacionContable(
      { empresa: empresaRecord.nombre },
      gastos,
      software,
      CUENTA_ANTICIPO
    );

    const archivo = `plano_${software.toLowerCase()}_${nombreArchivoSeguro(empresaRecord.nombre)}_${hoyISO()}.xlsx`;
    return enviarExcel(res, buffer, archivo);
  } catch (error) {
    console.error('Error generando plano contable:', error);
    return res.status(500).json({ error: 'Error al exportar los datos contables' });
  }
});

// Plano contable de un viaje liquidado específico
router.get('/viajes/:id/exportar-contable', async (req, res) => {
  try {
    const software = leerSoftware(req);
    if (!software) {
      return res.status(400).json({ error: `Software no soportado. Use: ${SOFTWARES_CONTABLES.join(', ')}` });
    }

    const viajeId = Number(req.params.id);
    if (!Number.isInteger(viajeId)) {
      return res.status(400).json({ error: 'ID de viaje inválido' });
    }

    const viaje = await prisma.viajeLiquidado.findUnique({ where: { id: viajeId } });
    if (!viaje) {
      return res.status(404).json({ error: 'Viaje no encontrado' });
    }

    const gastos = await prisma.gasto.findMany({
      where: { viajeId },
      orderBy: { id: 'asc' }
    });

    const buffer = await generarExportacionContable(viaje, gastos, software, CUENTA_ANTICIPO);
    const archivo = `plano_${software.toLowerCase()}_viaje_${viajeId}_${nombreArchivoSeguro(viaje.placa)}.xlsx`;
    return enviarExcel(res, buffer, archivo);
  } catch (error) {
    console.error('Error generando archivo contable:', error);
    return res.status(500).json({ error: 'Error al exportar los datos contables' });
  }
});

export default router;
