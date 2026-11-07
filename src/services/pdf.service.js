import PDFDocument from 'pdfkit';

const AZUL = '#1e3a8a';
const GRIS = '#475569';
const GRIS_CLARO = '#e2e8f0';
const VERDE = '#047857';
const ROJO = '#b91c1c';

export const numeroAnticipo = (consecutivo) => `ANT-${String(consecutivo).padStart(4, '0')}`;

const pesos = (n) => {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('es-CO');
};

function textoSaldo(saldo) {
  if (Math.abs(saldo) < 0.01) return { texto: 'Planilla saldada', color: VERDE };
  if (saldo < 0) return { texto: `Pendiente por pagar al conductor: ${pesos(Math.abs(saldo))}`, color: ROJO };
  return { texto: `Pendiente de reintegro del conductor: ${pesos(saldo)}`, color: ROJO };
}

/**
 * Dibuja una tabla simple con encabezado y salto de página automático.
 * columnas: [{ titulo, ancho, alinear?, valor: (fila) => string }]
 */
function tabla(doc, columnas, filas, vacio) {
  const izquierda = doc.page.margins.left;
  const anchoTotal = columnas.reduce((s, c) => s + c.ancho, 0);

  const encabezado = () => {
    const y = doc.y;
    doc.rect(izquierda, y, anchoTotal, 18).fill(AZUL);
    let x = izquierda;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
    for (const c of columnas) {
      doc.text(c.titulo, x + 4, y + 5, { width: c.ancho - 8, align: c.alinear || 'left' });
      x += c.ancho;
    }
    doc.y = y + 18;
  };

  encabezado();
  if (filas.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(GRIS)
      .text(vacio, izquierda + 4, doc.y + 5, { width: anchoTotal - 8 });
    doc.y += 6;
    return;
  }

  doc.font('Helvetica').fontSize(8);
  filas.forEach((fila, i) => {
    const textos = columnas.map(c => String(c.valor(fila) ?? ''));
    const alto = Math.max(16, ...textos.map((t, k) => doc.heightOfString(t, { width: columnas[k].ancho - 8 }) + 8));

    if (doc.y + alto > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      encabezado();
      doc.font('Helvetica').fontSize(8);
    }

    const y = doc.y;
    if (i % 2 === 1) doc.rect(izquierda, y, anchoTotal, alto).fill('#f8fafc');
    let x = izquierda;
    doc.fillColor('#0f172a');
    textos.forEach((t, k) => {
      doc.text(t, x + 4, y + 4, { width: columnas[k].ancho - 8, align: columnas[k].alinear || 'left' });
      x += columnas[k].ancho;
    });
    doc.moveTo(izquierda, y + alto).lineTo(izquierda + anchoTotal, y + alto).strokeColor(GRIS_CLARO).lineWidth(0.5).stroke();
    doc.y = y + alto;
  });
}

function titulo(doc, texto) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - 80) doc.addPage();
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(AZUL).text(texto, doc.page.margins.left);
  doc.moveDown(0.3);
}

/**
 * Genera el PDF de una planilla de liquidación y lo devuelve como Buffer.
 * viaje: ViajeLiquidado con { pagos, anticipos, saldoPendiente } y resumenGastos (JSON).
 */
export function generarPdfPlanilla(viaje, nombreEmpresa) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      bufferPages: true,
      margins: { top: 45, bottom: 45, left: 45, right: 45 },
      info: { Title: `Planilla de liquidación No. ${viaje.id}`, Author: 'VIÁTIKO' }
    });
    const partes = [];
    doc.on('data', (p) => partes.push(p));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    const izq = doc.page.margins.left;
    const ancho = doc.page.width - izq - doc.page.margins.right;

    let gastos = [];
    try { gastos = JSON.parse(viaje.resumenGastos || '[]'); } catch { gastos = []; }
    const anticipos = viaje.anticipos || [];
    const pagos = viaje.pagos || [];

    // Encabezado
    doc.rect(0, 0, doc.page.width, 80).fill(AZUL);
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text('VIÁTIKO', izq, 22);
    doc.font('Helvetica').fontSize(9).fillColor('#cbd5e1').text('Control de viáticos y gastos de ruta', izq, 46);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff')
      .text(`Planilla de Liquidación No. ${viaje.id}`, izq, 24, { width: ancho, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#cbd5e1')
      .text(nombreEmpresa || '', izq, 44, { width: ancho, align: 'right' });

    // Datos del viaje
    doc.y = 100;
    const fila = (etiqueta, valor, x, y) => {
      doc.font('Helvetica').fontSize(8).fillColor(GRIS).text(etiqueta, x, y);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text(valor, x, y + 11);
    };
    const y0 = doc.y;
    fila('Conductor', viaje.conductor, izq, y0);
    fila('Vehículo (placa)', viaje.placa, izq + ancho * 0.4, y0);
    fila('Fecha de cierre', viaje.fechaCierre, izq + ancho * 0.7, y0);
    doc.y = y0 + 36;

    // Resumen financiero
    const saldo = textoSaldo(Number(viaje.saldoPendiente ?? viaje.saldoFinal));
    const yR = doc.y;
    doc.rect(izq, yR, ancho, 62).fillAndStroke('#f1f5f9', GRIS_CLARO);
    const celda = (etiqueta, valor, x, color) => {
      doc.font('Helvetica').fontSize(8).fillColor(GRIS).text(etiqueta, x, yR + 10, { width: ancho / 4 - 10 });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(color).text(valor, x, yR + 22, { width: ancho / 4 - 10 });
    };
    celda('Anticipos entregados', pesos(viaje.anticipoTotal), izq + 10, AZUL);
    celda('Gastos legalizados', pesos(viaje.gastosTotal), izq + 10 + ancho / 4, ROJO);
    celda('Saldo liquidado', pesos(viaje.saldoFinal), izq + 10 + ancho / 2, '#0f172a');
    celda('Pagos / reintegros', pesos(viaje.totalAjustes || 0), izq + 10 + (3 * ancho) / 4, '#0f172a');
    doc.font('Helvetica-Bold').fontSize(9).fillColor(saldo.color).text(saldo.texto, izq + 10, yR + 45, { width: ancho - 20 });
    doc.y = yR + 62;

    // Anticipos
    titulo(doc, 'Anticipos entregados');
    tabla(doc, [
      { titulo: 'Número', ancho: 80, valor: a => numeroAnticipo(a.consecutivo) },
      { titulo: 'Fecha', ancho: 75, valor: a => a.fecha },
      { titulo: 'Observación', ancho: ancho - 255, valor: a => a.observacion || '-' },
      { titulo: 'Valor', ancho: 100, alinear: 'right', valor: a => pesos(a.valor) }
    ], anticipos, Number(viaje.anticipoTotal) > 0
      ? `Anticipo registrado sin consecutivo: ${pesos(viaje.anticipoTotal)}`
      : 'No se entregaron anticipos en este viaje.');

    // Gastos
    titulo(doc, `Gastos y comprobantes (${gastos.length})`);
    tabla(doc, [
      { titulo: 'Fecha', ancho: 58, valor: g => g.fecha },
      { titulo: 'Establecimiento / Observación', ancho: ancho - 340, valor: g => g.establecimiento + (g.observacion ? `\n${g.observacion}` : '') },
      { titulo: 'NIT', ancho: 72, valor: g => g.nit || 'Sin NIT' },
      { titulo: 'Factura', ancho: 58, valor: g => g.consecutivo || 'S/N' },
      { titulo: 'Categoría', ancho: 72, valor: g => `${g.categoria}${g.cuenta_contable ? `\n${g.cuenta_contable}` : ''}` },
      { titulo: 'Valor', ancho: 80, alinear: 'right', valor: g => pesos(g.total) }
    ], gastos, 'No se registraron gastos en este viaje.');

    // Pagos y reintegros
    if (pagos.length > 0) {
      titulo(doc, 'Pagos y reintegros del administrador');
      tabla(doc, [
        { titulo: 'Fecha', ancho: 75, valor: p => p.fecha },
        { titulo: 'Tipo', ancho: 140, valor: p => (p.tipo === 'pago_conductor' ? 'Pago al conductor' : 'Reintegro del conductor') },
        { titulo: 'Observación', ancho: ancho - 315, valor: p => p.observacion || '-' },
        { titulo: 'Valor', ancho: 100, alinear: 'right', valor: p => pesos(p.valor) }
      ], pagos, '');
    }

    // Firmas
    if (doc.y > doc.page.height - doc.page.margins.bottom - 110) doc.addPage();
    const yF = Math.max(doc.y + 60, doc.page.height - doc.page.margins.bottom - 70);
    const anchoFirma = (ancho - 60) / 2;
    [['Firma del conductor', viaje.conductor], ['Firma del administrador', 'Revisó y aprobó']].forEach(([t, sub], i) => {
      const x = izq + i * (anchoFirma + 60);
      doc.moveTo(x, yF).lineTo(x + anchoFirma, yF).strokeColor(GRIS).lineWidth(0.8).stroke();
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text(t, x, yF + 5, { width: anchoFirma, align: 'center' });
      doc.font('Helvetica').fontSize(8).fillColor(GRIS).text(sub, x, yF + 17, { width: anchoFirma, align: 'center' });
    });

    // Pie de página en todas las hojas
    const rango = doc.bufferedPageRange();
    const generado = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    for (let i = rango.start; i < rango.start + rango.count; i++) {
      doc.switchToPage(i);
      const margenInferior = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7).fillColor(GRIS).text(
        `Generado por VIÁTIKO el ${generado}  ·  Página ${i - rango.start + 1} de ${rango.count}`,
        izq, doc.page.height - 28, { width: ancho, align: 'center' }
      );
      doc.page.margins.bottom = margenInferior;
    }

    doc.end();
  });
}
