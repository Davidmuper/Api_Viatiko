import ExcelJS from 'exceljs';

const NIT_GENERICO = '222222222';
const CUENTA_GASTO_DEFECTO = '519595';

/**
 * Genera el plano contable en partida doble:
 *  - Débito a la cuenta PUC del gasto
 *  - Crédito a la cuenta de anticipo (por defecto 133015)
 *
 * @param {object} contexto Viaje liquidado ({ id, placa, ... }) o datos de empresa para exportes masivos
 * @param {Array}  gastos   Registros del modelo Gasto
 * @param {string} software SIIGO | LOGGRO | GENERICO
 */
export async function generarExportacionContable(contexto, gastos, software = 'SIIGO', cuentaAnticipo = '133015') {
  const workbook = new ExcelJS.Workbook();
  const movimientos = construirMovimientos(contexto || {}, gastos || [], cuentaAnticipo);

  switch ((software || 'SIIGO').toUpperCase()) {
    case 'LOGGRO':
      construirHojaLoggro(workbook, movimientos);
      break;
    case 'GENERICO':
      construirHojaGenerica(workbook, movimientos);
      break;
    default:
      construirHojaSiigo(workbook, movimientos);
  }

  return workbook.xlsx.writeBuffer();
}

function fechaISO(valor) {
  const fecha = valor ? new Date(valor) : new Date();
  return Number.isNaN(fecha.getTime()) ? new Date().toISOString().slice(0, 10) : fecha.toISOString().slice(0, 10);
}

// Convierte cada gasto en su par débito/crédito, independiente del software destino
function construirMovimientos(contexto, gastos, cuentaAnticipo) {
  const movimientos = [];

  gastos.forEach((g) => {
    const valor = Number(g.total) || 0;
    const placa = g.placa || contexto.placa || 'GENERAL';
    const viajeId = g.viajeId || contexto.id;
    const base = {
      comprobante: viajeId ? `CC-${viajeId}` : 'CC-1',
      fecha: fechaISO(g.fecha),
      placa,
      centroCosto: g.centro_costos || placa,
      conductor: g.conductor || contexto.conductor || ''
    };

    movimientos.push({
      ...base,
      cuenta: g.cuenta_contable || CUENTA_GASTO_DEFECTO,
      nit: g.nit && g.nit !== 'Sin NIT' ? g.nit : NIT_GENERICO,
      descripcion: `${g.establecimiento || 'Gasto'} - Fact ${g.consecutivo || 'S/N'}`,
      debito: valor,
      credito: 0
    });

    movimientos.push({
      ...base,
      cuenta: cuentaAnticipo,
      nit: contexto.conductorNit || NIT_GENERICO,
      descripcion: `Legalización anticipo placa ${placa}`,
      debito: 0,
      credito: valor
    });
  });

  return movimientos;
}

function formatoMoneda(ws) {
  ws.getColumn('debito').numFmt = '#,##0';
  ws.getColumn('credito').numFmt = '#,##0';
  ws.getRow(1).font = { bold: true };
}

// Estructura adaptada para importación en Siigo Nube
function construirHojaSiigo(workbook, movimientos) {
  const ws = workbook.addWorksheet('Siigo_Comprobantes');
  ws.columns = [
    { header: 'Comprobante', key: 'comprobante', width: 15 },
    { header: 'Fecha (AAAA-MM-DD)', key: 'fecha', width: 18 },
    { header: 'Cuenta Contable', key: 'cuenta', width: 18 },
    { header: 'NIT Tercero', key: 'nit', width: 16 },
    { header: 'Centro Costo', key: 'centroCosto', width: 15 },
    { header: 'Descripción / Concepto', key: 'descripcion', width: 36 },
    { header: 'Débito', key: 'debito', width: 16 },
    { header: 'Crédito', key: 'credito', width: 16 }
  ];
  ws.addRows(movimientos);
  formatoMoneda(ws);
}

// Estructura adaptada para Loggro
function construirHojaLoggro(workbook, movimientos) {
  const ws = workbook.addWorksheet('Loggro_Movimientos');
  ws.columns = [
    { header: 'Fecha', key: 'fecha', width: 14 },
    { header: 'Identificación', key: 'nit', width: 16 },
    { header: 'Código Cuenta', key: 'cuenta', width: 16 },
    { header: 'Centro Costo / Placa', key: 'centroCosto', width: 18 },
    { header: 'Nota', key: 'descripcion', width: 36 },
    { header: 'Débito', key: 'debito', width: 16 },
    { header: 'Crédito', key: 'credito', width: 16 }
  ];
  ws.addRows(movimientos);
  formatoMoneda(ws);
}

// Formato genérico para cualquier ERP
function construirHojaGenerica(workbook, movimientos) {
  const ws = workbook.addWorksheet('Plano_Contable');
  ws.columns = [
    { header: 'Comprobante', key: 'comprobante', width: 14 },
    { header: 'Fecha', key: 'fecha', width: 14 },
    { header: 'Cuenta', key: 'cuenta', width: 14 },
    { header: 'Tercero (NIT)', key: 'nit', width: 16 },
    { header: 'Conductor', key: 'conductor', width: 22 },
    { header: 'Placa', key: 'placa', width: 12 },
    { header: 'Centro Costo', key: 'centroCosto', width: 14 },
    { header: 'Descripción', key: 'descripcion', width: 36 },
    { header: 'Débito', key: 'debito', width: 16 },
    { header: 'Crédito', key: 'credito', width: 16 }
  ];
  ws.addRows(movimientos);
  formatoMoneda(ws);
}
