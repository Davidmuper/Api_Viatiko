import { GoogleGenerativeAI } from '@google/generative-ai';

const CUENTAS_PUC = {
  'Combustible': '519525',
  'Peajes': '519530',
  'Mantenimiento / Taller': '514510',
  'Hospedaje / Alimentación': '519595',
  'Cargue / Descargue': '519535',
  'Parqueadero / Lavado': '519540',
  'Pesaje': '519595',
  'Otros': '519595'
};

const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

export async function analizarComprobanteConGemini(buffer, mimeType = 'image/jpeg') {
  if (!genAI) {
    console.warn('GEMINI_API_KEY no configurada. Retornando valores predeterminados.');
    return {
      fecha: new Date().toISOString().slice(0, 10),
      establecimiento: 'Comprobante Digitalizado',
      nit: 'Sin NIT',
      consecutivo: 'S/N',
      categoria: 'Otros',
      cuenta_contable: '519595',
      total: 0,
      placa: '',
      conductor: ''
    };
  }

  try {
    // Usar el alias latest que garantiza disponibilidad en v1beta
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

    const prompt = `Analiza este comprobante de gasto de transporte en Colombia y responde ÚNICAMENTE con un objeto JSON sin bloques markdown ni texto adicional. Formato estricto:
{
  "fecha": "YYYY-MM-DD",
  "establecimiento": "Nombre del establecimiento",
  "nit": "Número de NIT o Sin NIT",
  "consecutivo": "Número de factura o ticket",
  "categoria": "Combustible | Peajes | Mantenimiento / Taller | Hospedaje / Alimentación | Cargue / Descargue | Parqueadero / Lavado | Pesaje | Otros",
  "total": 0,
  "placa": "Placa del vehículo o vacío",
  "conductor": "Nombre o vacío"
}`;

    const partes = [
      prompt,
      {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType: mimeType || 'image/jpeg'
        }
      }
    ];

    const result = await model.generateContent(partes);
    let textoRespuesta = result.response.text();

    // Limpieza de formato Markdown si la respuesta incluye ```json
    textoRespuesta = textoRespuesta.replace(/```json/gi, '').replace(/```/g, '').trim();

    const datos = JSON.parse(textoRespuesta);

    const categoriaFinal = datos.categoria || 'Otros';
    const cuentaFinal = CUENTAS_PUC[categoriaFinal] || '519595';

    return {
      fecha: datos.fecha || new Date().toISOString().slice(0, 10),
      establecimiento: (datos.establecimiento || 'Comprobante').trim(),
      nit: (datos.nit || 'Sin NIT').trim(),
      consecutivo: (datos.consecutivo || '').trim(),
      categoria: categoriaFinal,
      cuenta_contable: cuentaFinal,
      total: Number(datos.total) || 0,
      placa: (datos.placa || '').toUpperCase().trim(),
      conductor: (datos.conductor || '').trim()
    };
  } catch (error) {
    console.error('Error procesando imagen con Gemini:', error);
    throw new Error('No fue posible procesar la imagen con Inteligencia Artificial.');
  }
}