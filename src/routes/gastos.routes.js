import { Router } from 'express';
import multer from 'multer';
import { PrismaClient } from '@prisma/client';
import { analizarComprobanteConGemini } from '../services/gemini.service.js';
import { generarExportacionContable } from '../services/excel.service.js';

const router = Router();
const prisma = new PrismaClient();

// Configuración de multer en memoria para procesar la imagen sin guardarla en disco
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // Límite de 10MB
});

// 1. Ruta para analizar el comprobante con Google Gemini
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

// 2. Ruta para registrar un gasto en la base de datos
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

// 3. Ruta para exportar a Excel (compatible con Siigo y Loggro)
router.get('/viajes/:id/exportar-contable', async (req, res) => {
  try {
    const viajeId = Number(req.params.id);

    // Consulta el viaje junto a todos los gastos asociados
    const viaje = await prisma.viaje.findUnique({
      where: { id: viajeId },
      include: {
        gastos: true
      }
    });

    if (!viaje) {
      return res.status(404).json({ error: 'El viaje especificado no existe.' });
    }

    // Lee el software por parámetro (?software=LOGGRO o por defecto SIIGO)
    const software = req.query.software || 'SIIGO';
    const cuentaAnticipo = '133015'; // Cuenta contable estándar de anticipos

    const bufferExcel = await generarExportacionContable(
      viaje,
      viaje.gastos,
      software,
      cuentaAnticipo
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
    return res.status(500).json({ error: 'Error al exportar los datos contables a Excel.' });
  }
});

export default router;