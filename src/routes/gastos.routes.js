import { Router } from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
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

const CAMPOS_PUBLICOS_CONDUCTOR = {
  id: true, empresaId: true, nombre: true, placa: true, anticipo: true, rol: true
};

function sinPassword(conductor) {
  if (!conductor) return conductor;
  const { password, ...resto } = conductor;
  return resto;
}

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
    
    // Nunca se envía el hash de la contraseña al navegador
    let conductores = await prisma.conductor.findMany({
      where: whereClause,
      select: CAMPOS_PUBLICOS_CONDUCTOR
    });

    if (conductores.length === 0) {
      conductores = await prisma.conductor.findMany({ select: CAMPOS_PUBLICOS_CONDUCTOR });
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

// 3. Inicio de sesión: valida la contraseña contra el hash bcrypt de la empresa solicitada
const ERROR_CREDENCIALES = {
  error: 'Usuario o contraseña incorrectos',
  codigo: 'CREDENCIALES_INVALIDAS'
};
// Hash de relleno para que un usuario inexistente tarde lo mismo que uno real (evita enumerar usuarios)
const HASH_RELLENO = bcrypt.hashSync('viatiko-relleno', 10);

router.post('/login', async (req, res) => {
  try {
    const { conductorId, usuario, password, empresa } = req.body;

    if (!password || (!usuario && !conductorId)) {
      return res.status(400).json({
        error: 'Debe indicar usuario y contraseña',
        codigo: 'DATOS_INCOMPLETOS'
      });
    }

    const empresaRecord = await prisma.empresa.findFirst({
      where: { nombre: { equals: String(empresa || EMPRESA_POR_DEFECTO).trim(), mode: 'insensitive' } }
    });

    const conductor = empresaRecord
      ? await prisma.conductor.findFirst({
          where: conductorId
            ? { id: Number(conductorId), empresaId: empresaRecord.id }
            : { nombre: String(usuario), empresaId: empresaRecord.id }
        })
      : null;

    const guardado = conductor ? conductor.password : HASH_RELLENO;
    const esHash = /^\$2[aby]\$/.test(guardado);
    // Compatibilidad: claves antiguas en texto plano se aceptan una vez y se migran a bcrypt
    const valida = esHash
      ? await bcrypt.compare(String(password), guardado)
      : String(password) === guardado;

    if (!conductor || !valida) {
      return res.status(401).json(ERROR_CREDENCIALES);
    }

    if (!esHash) {
      await prisma.conductor.update({
        where: { id: conductor.id },
        data: { password: await bcrypt.hash(String(password), 10) }
      });
    }

    return res.json({
      success: true,
      rol: conductor.rol,
      conductor: sinPassword(conductor),
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

    const pucs = await prisma.puc.findMany({ select: { nombre: true } });
    const categorias = [...new Set(pucs.map(p => p.nombre))];

    const datosExtraidos = await analizarComprobanteConGemini(
      archivo.buffer,
      archivo.mimetype,
      categorias
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
      // Primero la cuenta configurada en la tabla PUC de la empresa
      const puc = await prisma.puc.findFirst({ where: { empresaId, nombre: String(categoria) } });
      if (puc) cta = puc.codigo;
    }
    if (!cta && categoria) {
      const cat = String(categoria).toLowerCase();
      if (cat.includes('combustible')) cta = '519525';
      else if (cat.includes('peaje')) cta = '519530';
      else if (cat.includes('parqueadero') || cat.includes('lavado')) cta = '519535';
      else if (cat.includes('mantenimiento') || cat.includes('taller')) cta = '514510';
      else if (cat.includes('alimentacion') || cat.includes('viatico')) cta = '519565';
      else if (cat.includes('bascula') || cat.includes('báscula') || cat.includes('pesaje')) cta = '519595';
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
      orderBy: { id: 'desc' },
      include: { pagos: { orderBy: { id: 'asc' } } }
    });

    return res.json(historial.map(conSaldoPendiente));
  } catch (error) {
    console.error('Error obteniendo historial:', error);
    return res.status(500).json({ error: 'Error cargando historial' });
  }
});

// ---------- Administración de planillas ----------

// saldoFinal < 0: la empresa le debe al conductor; > 0: el conductor debe reintegrar
function conSaldoPendiente(viaje) {
  const ajustes = (viaje.pagos || []).reduce(
    (acc, p) => acc + (p.tipo === 'pago_conductor' ? p.valor : -p.valor),
    0
  );
  const saldoPendiente = Math.round((Number(viaje.saldoFinal) + ajustes) * 100) / 100;
  return { ...viaje, totalAjustes: ajustes, saldoPendiente };
}

// 9b. Registrar pago al conductor (saldo negativo) o reintegro del conductor (saldo positivo)
router.post('/viajes/:id/pagos', async (req, res) => {
  try {
    const viajeId = Number(req.params.id);
    if (!Number.isInteger(viajeId)) {
      return res.status(400).json({ error: 'ID de planilla inválido' });
    }

    const viaje = await prisma.viajeLiquidado.findUnique({
      where: { id: viajeId },
      include: { pagos: true }
    });
    if (!viaje) {
      return res.status(404).json({ error: 'Planilla no encontrada' });
    }

    const { saldoPendiente } = conSaldoPendiente(viaje);
    if (Math.abs(saldoPendiente) < 0.01) {
      return res.status(400).json({ error: 'La planilla ya está saldada' });
    }

    const pendienteAbs = Math.abs(saldoPendiente);
    const valor = req.body.valor === undefined || req.body.valor === '' ? pendienteAbs : Number(req.body.valor);
    if (!Number.isFinite(valor) || valor <= 0) {
      return res.status(400).json({ error: 'El valor del pago debe ser mayor a cero' });
    }
    if (valor > pendienteAbs + 0.01) {
      return res.status(400).json({ error: `El valor supera el saldo pendiente ($${pendienteAbs.toLocaleString('es-CO')})` });
    }

    await prisma.pagoPlanilla.create({
      data: {
        viajeId,
        fecha: fechaComoTexto(req.body.fecha),
        tipo: saldoPendiente < 0 ? 'pago_conductor' : 'reintegro_conductor',
        valor,
        observacion: String(req.body.observacion || '').trim()
      }
    });

    const actualizado = await prisma.viajeLiquidado.findUnique({
      where: { id: viajeId },
      include: { pagos: { orderBy: { id: 'asc' } } }
    });
    return res.status(201).json({ success: true, planilla: conSaldoPendiente(actualizado) });
  } catch (error) {
    console.error('Error registrando pago de planilla:', error);
    return res.status(500).json({ error: 'Error al registrar el pago', detalle: error.message });
  }
});

// 9c. Anular un pago registrado por error
router.delete('/viajes/:id/pagos/:pagoId', async (req, res) => {
  try {
    const resultado = await prisma.pagoPlanilla.deleteMany({
      where: { id: Number(req.params.pagoId), viajeId: Number(req.params.id) }
    });
    if (resultado.count === 0) {
      return res.status(404).json({ error: 'Pago no encontrado en esta planilla' });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('Error anulando pago:', error);
    return res.status(500).json({ error: 'Error al anular el pago' });
  }
});

// 9d. Eliminar planilla (p. ej. de prueba) junto con sus gastos y pagos
router.delete('/viajes/:id', async (req, res) => {
  try {
    const viajeId = Number(req.params.id);
    if (!Number.isInteger(viajeId)) {
      return res.status(400).json({ error: 'ID de planilla inválido' });
    }

    const [gastos, , viaje] = await prisma.$transaction([
      prisma.gasto.deleteMany({ where: { viajeId } }),
      prisma.pagoPlanilla.deleteMany({ where: { viajeId } }),
      prisma.viajeLiquidado.deleteMany({ where: { id: viajeId } })
    ]);

    if (viaje.count === 0) {
      return res.status(404).json({ error: 'Planilla no encontrada' });
    }
    return res.json({ success: true, gastosEliminados: gastos.count });
  } catch (error) {
    console.error('Error eliminando planilla:', error);
    return res.status(500).json({ error: 'Error al eliminar la planilla' });
  }
});

// ---------- Administración de conductores ----------

async function obtenerConductorEditable(id, res) {
  const conductor = await prisma.conductor.findUnique({ where: { id } });
  if (!conductor) {
    res.status(404).json({ error: 'Conductor no encontrado' });
    return null;
  }
  if (conductor.rol === 'admin') {
    res.status(403).json({ error: 'El usuario administrador no se puede modificar desde aquí' });
    return null;
  }
  return conductor;
}

function contarGastosActivos(nombre) {
  return prisma.gasto.count({ where: { conductor: nombre, viajeId: null } });
}

// 9e. Cambiar el conductor asignado a un vehículo (nombre) y/o la placa
router.patch('/conductores/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'ID de conductor inválido' });
    }
    const conductor = await obtenerConductorEditable(id, res);
    if (!conductor) return;

    const nombre = req.body.nombre !== undefined ? String(req.body.nombre).trim() : conductor.nombre;
    const placa = req.body.placa !== undefined ? String(req.body.placa).trim().toUpperCase() : conductor.placa;
    if (!nombre || !placa) {
      return res.status(400).json({ error: 'El nombre y la placa no pueden quedar vacíos' });
    }

    // Los gastos se asocian por nombre: cambiar de conductor con un viaje abierto los dejaría huérfanos
    if (nombre !== conductor.nombre && await contarGastosActivos(conductor.nombre) > 0) {
      return res.status(409).json({
        error: `${conductor.nombre} tiene gastos sin liquidar. Liquide su viaje antes de cambiar el conductor.`
      });
    }

    const actualizado = await prisma.conductor.update({
      where: { id },
      data: { nombre, placa }
    });
    return res.json({ success: true, conductor: sinPassword(actualizado) });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Ya existe un conductor con ese nombre en la empresa' });
    }
    console.error('Error actualizando conductor:', error);
    return res.status(500).json({ error: 'Error al actualizar el conductor' });
  }
});

// 9f. Eliminar conductor (solo si no tiene anticipo ni gastos pendientes)
router.delete('/conductores/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'ID de conductor inválido' });
    }
    const conductor = await obtenerConductorEditable(id, res);
    if (!conductor) return;

    if (Number(conductor.anticipo) !== 0 || await contarGastosActivos(conductor.nombre) > 0) {
      return res.status(409).json({
        error: `${conductor.nombre} tiene anticipo o gastos sin liquidar. Liquide el viaje antes de eliminarlo.`
      });
    }

    await prisma.conductor.delete({ where: { id } });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando conductor:', error);
    return res.status(500).json({ error: 'Error al eliminar el conductor' });
  }
});

// ---------- Control contable ----------

function marcarComoExportados(ids, empresaId) {
  return prisma.gasto.updateMany({
    where: {
      id: { in: ids },
      viajeId: { not: null },
      estado_contable: 'pendiente',
      ...(empresaId ? { empresaId } : {})
    },
    data: { estado_contable: 'exportado' }
  });
}

// 9g. Marcar como contabilizados los gastos ya descargados en el plano contable
router.post('/marcar-contabilizado', async (req, res) => {
  try {
    const { ids, empresa } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Debe enviar la lista de IDs de gastos (ids)' });
    }
    if (ids.length > 10000) {
      return res.status(400).json({ error: 'Máximo 10.000 gastos por corte' });
    }
    const idsNumericos = ids.map(Number);
    if (!idsNumericos.every(Number.isInteger)) {
      return res.status(400).json({ error: 'Todos los IDs deben ser números enteros' });
    }

    const empresaId = empresa ? await resolverEmpresaId({ empresa }) : null;
    const resultado = await marcarComoExportados(idsNumericos, empresaId);

    return res.json({
      success: true,
      marcados: resultado.count,
      omitidos: idsNumericos.length - resultado.count
    });
  } catch (error) {
    console.error('Error marcando gastos contabilizados:', error);
    return res.status(500).json({ error: 'Error al marcar los gastos como contabilizados' });
  }
});

// 10. Exportar liquidación contable a Excel
router.get('/exportar-contable', async (req, res) => {
  try {
    const { empresa, software = 'SIIGO', incluirExportados, marcar } = req.query;

    const empresaId = await resolverEmpresaId({ empresa });
    if (!empresaId) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }

    // Solo gastos de viajes liquidados; por defecto los que aún no se han contabilizado
    const where = { empresaId, viajeId: { not: null } };
    if (incluirExportados !== 'true') where.estado_contable = 'pendiente';

    const gastos = await prisma.gasto.findMany({
      where,
      orderBy: [{ viajeId: 'asc' }, { id: 'asc' }]
    });

    if (gastos.length === 0) {
      return res.status(404).json({
        error: 'No hay gastos liquidados pendientes por contabilizar',
        codigo: 'SIN_PENDIENTES'
      });
    }

    const bufferExcel = await generarExportacionContable(
      { empresa: empresa || EMPRESA_POR_DEFECTO },
      gastos,
      String(software).toUpperCase(),
      '133015'
    );

    const ids = gastos.map(g => g.id);
    // Marcado en un solo paso (opcional): ?marcar=true
    if (marcar === 'true') {
      await marcarComoExportados(ids, empresaId);
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="plano_${String(software).toLowerCase()}_${fechaComoTexto()}_${ids.length}gastos.xlsx"`
    );
    res.setHeader('X-Gastos-Ids', ids.join(','));
    res.setHeader('Access-Control-Expose-Headers', 'X-Gastos-Ids, Content-Disposition');

    return res.send(Buffer.from(bufferExcel));
  } catch (error) {
    console.error('Error generando plano contable:', error);
    return res.status(500).json({ error: 'Error al exportar los datos contables' });
  }
});

export default router;