import { Router } from 'express';
import prisma from '../services/db.service.js';

const router = Router();

// Registrar o actualizar un anticipo entregado
router.post('/guardar', async (req, res) => {
  try {
    const { empresa, conductor, placa, monto, observacion, fecha } = req.body;

    if (!conductor || !monto) {
      return res.status(400).json({ error: 'Conductor y monto son obligatorios' });
    }

    const nombreEmpresa = empresa || 'Petroquímicos S.A.';
    
    // 1. Obtener la empresa asociada
    const empresaRecord = await prisma.empresa.findFirst({
      where: { nombre: nombreEmpresa }
    });

    if (!empresaRecord) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }

    // 2. Localizar al conductor dentro de la empresa
    const conductorRecord = await prisma.conductor.findFirst({
      where: {
        empresaId: empresaRecord.id,
        nombre: conductor
      }
    });

    if (!conductorRecord) {
      return res.status(404).json({ error: 'Conductor no registrado en el sistema' });
    }

    // 3. Actualizar el anticipo del conductor
    const conductorActualizado = await prisma.conductor.update({
      where: { id: conductorRecord.id },
      data: {
        anticipo: Number(monto),
        placa: placa || conductorRecord.placa
      }
    });

    return res.status(200).json({
      status: 'success',
      mensaje: 'Anticipo actualizado correctamente',
      conductor: conductorActualizado.nombre,
      nuevoAnticipo: conductorActualizado.anticipo
    });
  } catch (error) {
    console.error('Error al guardar anticipo:', error);
    return res.status(500).json({ error: 'Error interno al registrar el anticipo' });
  }
});

export default router;