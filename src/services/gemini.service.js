import { GoogleGenerativeAI } from '@google/generative-ai';

const CATEGORIAS_DEFECTO = [
  'Combustible',
  'Peajes',
  'Mantenimiento / Taller',
  'Hospedaje / Alimentación',
  'Cargue / Descargue',
  'Parqueadero / Lavado',
  'Báscula',
  'Otros'
];

const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// Modelos en orden de prioridad. Se pueden sobrescribir sin redeploy con la variable
// GEMINI_MODELS (lista separada por comas). Nota: la familia gemini-1.5 fue retirada por Google.
function modelosConfigurados() {
  return process.env.GEMINI_MODELS
    ? process.env.GEMINI_MODELS.split(',').map(m => m.trim()).filter(Boolean)
    : ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];
}

// Acepta YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY y DD/MM/YY. Retorna '' si no es válida.
export function normalizarFecha(valor) {
  if (!valor) return '';
  const texto = String(valor).trim();
  let a, m, d;

  let r = texto.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (r) {
    [, a, m, d] = r;
  } else {
    r = texto.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (!r) return '';
    [, d, m, a] = r;
    if (a.length === 2) a = '20' + a;
  }

  const fecha = new Date(Date.UTC(Number(a), Number(m) - 1, Number(d)));
  const valida = fecha.getUTCFullYear() === Number(a)
    && fecha.getUTCMonth() === Number(m) - 1
    && fecha.getUTCDate() === Number(d);
  return valida ? fecha.toISOString().slice(0, 10) : '';
}

// Convierte montos colombianos ('$ 45.000', '45,000', '45.000,50', 45000) a número. 0 si no es legible.
export function normalizarTotal(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) && valor > 0 ? valor : 0;
  if (!valor) return 0;
  let texto = String(valor).replace(/[^\d.,]/g, '');
  if (!texto) return 0;

  const ultimoPunto = texto.lastIndexOf('.');
  const ultimaComa = texto.lastIndexOf(',');
  const sep = Math.max(ultimoPunto, ultimaComa);
  // Si el último separador tiene 1-2 dígitos después, es decimal; si tiene 3, es de miles
  if (sep !== -1 && texto.length - sep - 1 <= 2) {
    texto = texto.slice(0, sep).replace(/[.,]/g, '') + '.' + texto.slice(sep + 1);
  } else {
    texto = texto.replace(/[.,]/g, '');
  }

  const numero = Number(texto);
  return Number.isFinite(numero) && numero > 0 ? numero : 0;
}

function extraerJson(texto) {
  const limpio = String(texto || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(limpio);
  } catch {
    const bloque = limpio.match(/\{[\s\S]*\}/);
    if (!bloque) throw new Error('La IA no devolvió un JSON válido');
    return JSON.parse(bloque[0]);
  }
}

function elegirCategoria(valor, categorias) {
  if (!valor) return 'Otros';
  const base = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const buscada = base(valor);
  return categorias.find(c => base(c) === buscada)
    || categorias.find(c => base(c).includes(buscada) || buscada.includes(base(c).split(' ')[0]))
    || 'Otros';
}

/**
 * Analiza la foto de un recibo. Siempre retorna un objeto; si la IA falla, `ocr_ok` es false
 * y `ocr_error` explica el motivo para que el conductor complete los datos manualmente.
 * Los campos que la IA no logra leer se devuelven vacíos (fecha '' y total 0).
 */
export async function analizarComprobanteConGemini(buffer, mimeType = 'image/jpeg', categorias = CATEGORIAS_DEFECTO) {
  const listaCategorias = categorias && categorias.length ? categorias : CATEGORIAS_DEFECTO;
  const vacio = {
    fecha: '',
    establecimiento: '',
    nit: '',
    consecutivo: '',
    categoria: 'Otros',
    total: 0,
    placa: '',
    conductor: ''
  };

  if (!genAI) {
    console.warn('GEMINI_API_KEY no configurada.');
    return { ...vacio, ocr_ok: false, ocr_error: 'La lectura automática no está configurada (falta GEMINI_API_KEY en el servidor).' };
  }

  const prompt = `Eres un asistente contable colombiano. Lee la foto de este recibo, tiquete o factura de un gasto de transporte de carga.
Responde SOLO con un objeto JSON con estas claves:
- "fecha": fecha de emisión impresa en el recibo en formato YYYY-MM-DD. Si no es legible, "".
- "establecimiento": nombre comercial o razón social del negocio que emite el recibo (estación de servicio, taller, peaje, báscula, restaurante, etc.). Si no es legible, "".
- "nit": NIT o cédula del emisor tal como aparece. Si no aparece, "".
- "consecutivo": número de factura, tiquete o consecutivo. Si no aparece, "".
- "categoria": exactamente una de: ${listaCategorias.map(c => `"${c}"`).join(', ')}. Usa "Báscula" para tiquetes de pesaje de vehículos y "Otros" si no encaja en ninguna.
- "total": valor TOTAL pagado como número entero en pesos, sin puntos, comas ni símbolo (ej. 45000). Si no es legible, 0.
- "placa": placa del vehículo si aparece, si no "".
No inventes datos: si un campo no se puede leer con seguridad, déjalo vacío.`;

  const partes = [
    prompt,
    { inlineData: { data: buffer.toString('base64'), mimeType: mimeType || 'image/jpeg' } }
  ];

  const errores = [];
  for (const nombreModelo of modelosConfigurados()) {
    try {
      const model = genAI.getGenerativeModel({
        model: nombreModelo,
        generationConfig: { responseMimeType: 'application/json', temperature: 0 }
      });
      const result = await model.generateContent(partes);
      const datos = extraerJson(result.response.text());

      return {
        fecha: normalizarFecha(datos.fecha),
        establecimiento: String(datos.establecimiento || '').trim(),
        nit: String(datos.nit || '').trim(),
        consecutivo: String(datos.consecutivo || '').trim(),
        categoria: elegirCategoria(datos.categoria, listaCategorias),
        total: normalizarTotal(datos.total),
        placa: String(datos.placa || '').toUpperCase().trim(),
        conductor: '',
        ocr_ok: true,
        modelo: nombreModelo
      };
    } catch (err) {
      console.warn(`Gemini ${nombreModelo} falló: ${err.message}`);
      errores.push(`${nombreModelo}: ${err.message}`);
    }
  }

  console.error('Ningún modelo de Gemini respondió:', errores.join(' | '));
  return {
    ...vacio,
    ocr_ok: false,
    ocr_error: 'No se pudo leer el recibo con IA. ' + (errores[0] || '').slice(0, 250)
  };
}
