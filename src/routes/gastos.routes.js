import { Router } from 'express';
import multer from 'multer';
import { PrismaClient } from '@prisma/client';
import { analizarComprobanteConGemini } from '../services/gemini.service.js';
import { generarExportacionContable } from '../services/excel.service.js';

const router = Router();
const prisma = new PrismaClient();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// 1. Obtener lista de conductores (por empresa)
router.get('/conductores', async (req, res) => {
  try {
    const { empresa } = req.query;
    const whereClause = empresa ? { empresa: { nombre: empresa } } : {};
    
    // Consulta los conductores creados en la base de datos
    let conductores = await prisma.conductor.findMany({
      where: whereClause
    });

    // Si la relación no filtra por nombre directo, devolver todos los conductores
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
    const { conductorId, password, empresa } = req.body;

    const conductor = await prisma.conductor.findFirst({
      where: conductorId ? { id: Number(conductorId) } : {}
    });

    if (!conductor) {
      return res.status(401).json({ error: 'Conductor o perfil no válido' });
    }

    // Retornar datos de sesión esperados por el frontend
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

// 4. Analizar comprobante con Gemini OCR
router.post('/analizar', upload.single('imagen'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió ninguna imagen' });
    }

    const datosExtraidos = await analizarComprobanteConGemini(
      req.file.buffer,
      req.file.mimetype
    );

    return res.json(datosExtraidos);
  } catch (error) {
    console.error('Error en /analizar:', error);
    return res.status(500).json({ error: 'Error analizando la imagen.' });
  }
});

// 5. Guardar gasto
router.post('/gastos', async (req, res) => {
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
      conductor
    } = req.body;

    const nuevoGasto = await prisma.gasto.create({
      data: {
        viajeId: viajeId ? Number(viajeId) : null,
        fecha: fecha ? new Date(fecha) : new Date(),
        establecimiento: establecimiento || 'Sin nombre',
        nit: nit || 'Sin NIT',
        consecutivo: consecutivo || 'S/N',
        categoria: categoria || 'Otros',
        cuenta_contable: cuenta_contable || '519595',
        total: Number(total) || 0,
        placa: placa || '',
        conductor: conductor || ''
      }
    });

    return res.status(201).json(nuevoGasto);
  } catch (error) {
    console.error('Error guardando gasto:', error);
    return res.status(500).json({ error: 'No se pudo registrar el gasto en la base de datos.' });
  }
});

// 6. Exportar liquidación contable a Excel
router.get('/viajes/:id/exportar-contable', async (req, res) => {
  try {
    const viajeId = Number(req.params.id);

    const viaje = await prisma.viajeLiquidado.findUnique({
      where: { id: viajeId },
      include: { gastos: true }
    }).catch(async () => {
      return await prisma.viaje.findUnique({
        where: { id: viajeId },
        include: { gastos: true }
      });
    });

    if (!viaje) {
      return res.status(404).json({ error: 'Viaje no encontrado' });
    }

    const software = req.query.software || 'SIIGO';
    const bufferExcel = await generarExportacionContable(
      viaje,
      viaje.gastos || [],
      software,
      '133015'
    );

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=migracion_${software.toLowerCase()}_${viaje.vehiculo || viajeId}.xlsx`
    );

    return res.send(bufferExcel);
  } catch (error) {
    console.error('Error generando archivo contable:', error);
    return res.status(500).json({ error: 'Error al exportar los datos contables' });
  }
});

export default router;