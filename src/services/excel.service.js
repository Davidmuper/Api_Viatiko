export function generarExcelPlanoUniversal(gastos, formato = 'ESTANDAR') {
  const encabezados = [
    'FECHA_COMPROBANTE',
    'CUENTA_PUC',
    'NIT_TERCERO',
    'RAZON_SOCIAL_TERCERO',
    'NUMERO_FACTURA',
    'CENTRO_COSTOS',
    'CATEGORIA',
    'OBSERVACIONES_OPERATIVAS',
    'DEBITO',
    'CREDITO',
    'CONDUCTOR',
    'FORMA_PAGO',
    'ESTADO_LIQUIDACION'
  ];

  const filas = gastos.map(g => {
    const valor = Number(g.total) || 0;
    const centroCostos = g.placa ? `VEH-${g.placa.trim().toUpperCase()}` : 'FLOTA-GENERAL';
    const nit = (g.nit || '222222222').replace(/[^0-9kK]/g, '');
    const cta = g.cuenta_contable || '519595';
    const razonSocial = (g.establecimiento || 'PROVEEDOR GENERAL').replace(/;/g, ' ').trim();
    const factura = (g.consecutivo || 'S/N').replace(/;/g, ' ').trim();
    const conductor = (g.conductor || 'N/A').replace(/;/g, ' ').trim();
    const obs = (g.observacion || '').replace(/;/g, ' ').replace(/[\r\n]+/g, ' ').trim();

    return [
      g.fecha || '',
      cta,
      nit,
      `"${razonSocial}"`,
      `"${factura}"`,
      centroCostos,
      `"${g.categoria || 'Varios'}"`,
      `"${obs}"`,
      valor,
      0,
      `"${conductor}"`,
      g.metodo || 'Efectivo',
      g.estado || 'activo'
    ].join(';');
  });

  const contenidoCsv = '\uFEFF' + [encabezados.join(';'), ...filas].join('\r\n');
  return Buffer.from(contenidoCsv, 'utf-8');
}

export const generarExcelPlanoLoggro = generarExcelPlanoUniversal;
