import ExcelJS from 'exceljs';

export async function generarExportacionContable(viaje, gastos, software = 'SIIGO', cuentaAnticipo = '133015') {
  const workbook = new ExcelJS.Workbook();
  const softwareNormalizado = (software || 'SIIGO').toUpperCase();

  if (softwareNormalizado === 'LOGGRO') {
    construirHojaLoggro(workbook, viaje, gastos, cuentaAnticipo);
  } else {
    // Siigo o formato genérico
    construirHojaSiigo(workbook, viaje, gastos, cuentaAnticipo);
  }

  return await workbook.xlsx.writeBuffer();
}

// Estructura adaptada para importación en Siigo Nube
function construirHojaSiigo(workbook, viaje, gastos, cuentaAnticipo) {
  const ws = workbook.addWorksheet('Siigo_Comprobantes');

  ws.columns = [
    { header: 'Comprobante', key: 'comprobante', width: 15 },
    { header: 'Fecha (AAAA-MM-DD)', key: 'fecha', width: 18 },
    { header: 'Cuenta Contable', key: 'cuenta', width: 18 },
    { header: 'NIT Tercero', key: 'nit', width: 16 },
    { header: 'Centro Costo', key: 'centro_costo', width: 15 },
    { header: 'Descripción / Concepto', key: 'descripcion', width: 32 },
    { header: 'Débito', key: 'debito', width: 16 },
    { header: 'Crédito', key: 'credito', width: 16 }
  ];

  gastos.forEach((g) => {
    const valor = Number(g.total) || 0;
    const fecha = g.fecha ? new Date(g.fecha).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);

    // Registro Débito: Gasto según cuenta PUC escaneada por Gemini
    ws.addRow({
      comprobante: 'CC-1',
      fecha: fecha,
      cuenta: g.cuenta_contable || '519595',
      nit: g.nit || '222222222',
      centro_costo: viaje.vehiculo || 'GENERAL',
      descripcion: `${g.establecimiento || 'Gasto'} - Fact ${g.consecutivo || 'S/N'}`,
      debito: valor,
      credito: 0
    });

    // Registro Crédito: Legalización/Descargo de anticipo
    ws.addRow({
      comprobante: 'CC-1',
      fecha: fecha,
      cuenta: cuentaAnticipo,
      nit: viaje.conductorNit || g.nit || '222222222',
      centro_costo: viaje.vehiculo || 'GENERAL',
      descripcion: `Legalización anticipo placa ${viaje.vehiculo || ''}`,
      debito: 0,
      credito: valor
    });
  });

  ws.getColumn('debito').numFmt = '#,##0';
  ws.getColumn('credito').numFmt = '#,##0';
}

// Estructura adaptada para Loggro
function construirHojaLoggro(workbook, viaje, gastos, cuentaAnticipo) {
  const ws = workbook.addWorksheet('Loggro_Movimientos');

  ws.columns = [
    { header: 'Fecha', key: 'fecha', width: 14 },
    { header: 'Identificación', key: 'nit', width: 16 },
    { header: 'Código Cuenta', key: 'cuenta', width: 16 },
    { header: 'Centro Costo / Placa', key: 'placa', width: 18 },
    { header: 'Nota', key: 'nota', width: 32 },
    { header: 'Débito', key: 'debito', width: 16 },
    { header: 'Crédito', key: 'credito', width: 16 }
  ];

  gastos.forEach((g) => {
    const valor = Number(g.total) || 0;
    const fecha = g.fecha ? new Date(g.fecha).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);

    ws.addRow({
      fecha: fecha,
      nit: g.nit || '222222222',
      cuenta: g.cuenta_contable || '519595',
      placa: viaje.vehiculo || 'GENERAL',
      nota: `Compra ${g.categoria || 'Gasto'} - ${g.establecimiento || ''}`,
      debito: valor,
      credito: 0
    });

    ws.addRow({
      fecha: fecha,
      nit: viaje.conductorNit || g.nit || '222222222',
      cuenta: cuentaAnticipo,
      placa: viaje.vehiculo || 'GENERAL',
      nota: `Descargo anticipo placa ${viaje.vehiculo || ''}`,
      debito: 0,
      credito: valor
    });
  });

  ws.getColumn('debito').numFmt = '#,##0';
  ws.getColumn('credito').numFmt = '#,##0';
}