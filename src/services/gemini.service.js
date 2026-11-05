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
  const respuestaBase = {
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

  if (!genAI) {
    console.warn('GEMINI_API_KEY no configurada. Retornando plantilla base.');
    return respuestaBase;
  }

  const prompt = `Analiza este comprobante de gasto de transporte en Colombia y responde ÚNICAMENTE con un JSON plano sin bloques markdown ni texto adicional. Formato estricto:
{
  "fecha": "YYYY-MM-DD",
  "establecimiento": "Nombre del negocio",
  "nit": "Número de NIT o Sin NIT",
  "consecutivo": "Número de factura o ticket",
  "categoria": "Combustible",
  "total": 0,
  "placa": "",
  "conductor": ""
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

  // Modelos compatibles en orden de prioridad
  const modelos = ['gemini-2.0-flash', 'gemini-1.5-flash-8b', 'gemini-1.5-pro'];

  for (const nombreModelo of modelos) {
    try {
      const model = genAI.getGenerativeModel({ model: nombreModelo });
      const result = await model.generateContent(partes);
      let texto = result.response.text();
      texto = texto.replace(/```json/gi, '').replace(/```/g, '').trim();

      const datos = JSON.parse(texto);
      const categoriaFinal = datos.categoria || 'Otros';
      const cuentaFinal = CUENTAS_PUC[categoriaFinal] || '519595';

      return {
        fecha: datos.fecha || respuestaBase.fecha,
        establecimiento: (datos.establecimiento || 'Comprobante').trim(),
        nit: (datos.nit || 'Sin NIT').trim(),
        consecutivo: (datos.consecutivo || '').trim(),
        categoria: categoriaFinal,
        cuenta_contable: cuentaFinal,
        total: Number(datos.total) || 0,
        placa: (datos.placa || '').toUpperCase().trim(),
        conductor: (datos.conductor || '').trim()
      };
    } catch (err) {
      console.warn(`Aviso: Modelo ${nombreModelo} no respondió (${err.message}). Intentando siguiente alternativa...`);
    }
  }

  console.warn('Los modelos no respondieron a tiempo. Usando plantilla base para completar registro.');
  return respuestaBase;
}