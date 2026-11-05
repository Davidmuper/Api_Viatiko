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

const apiKey = process.env.GEMINI_API_KEY;
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
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json'
      }
    });

    const prompt = `Analiza este comprobante de gasto de transporte/carretera en Colombia y extrae la información en un objeto JSON con los siguientes campos estrictos:
- fecha: cadena en formato YYYY-MM-DD. Si no es legible, usa la fecha de hoy.
- establecimiento: nombre comercial o razón social de quien expide la factura/tique.
- nit: número de identificación tributaria o RUT (solo dígitos y guion). Si no existe, pon "Sin NIT".
- consecutivo: número de factura, tirilla o ticket de pago.
- categoria: clasifica en una de las siguientes opciones exactas: "Combustible", "Peajes", "Mantenimiento / Taller", "Hospedaje / Alimentación", "Cargue / Descargue", "Parqueadero / Lavado", "Pesaje", "Otros".
- total: número entero o decimal positivo con el valor total pagado (sin puntos de miles ni símbolo $).
- placa: placa del vehículo si aparece (ejemplo: WNQ013). Si no aparece, deja cadena vacía.
- conductor: nombre del conductor si aparece impreso. Si no aparece, deja cadena vacía.`;

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
    const textoRespuesta = result.response.text();
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