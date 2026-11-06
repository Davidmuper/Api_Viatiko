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

// Modelos preferidos en orden de prioridad. Se pueden sobrescribir sin redeploy con la
// variable GEMINI_MODELS (lista separada por comas).
const MODELOS_PREFERIDOS = ['gemini-1.5-flash', 'gemini-1.5-pro'];

function modelosConfigurados() {
  return process.env.GEMINI_MODELS
    ? process.env.GEMINI_MODELS.split(',').map(m => m.trim()).filter(Boolean)
    : MODELOS_PREFERIDOS;
}

// ---------- Descubrimiento automático de modelos ----------
// Google retira modelos con frecuencia (404 "not found" / "no longer available").
// Si los preferidos fallan, se consulta ListModels con la misma API key y se usan los
// modelos multimodales que esa key realmente tiene habilitados.

// Tiempos: ningún recibo debe tardar más de TIEMPO_TOTAL_MS en el servidor
const TIEMPO_POR_MODELO_MS = 30000;
const TIEMPO_TOTAL_MS = 50000;

// Los modelos 2.5+ "piensan" antes de responder y por defecto lo hacen mucho (decenas de
// segundos). Leer un recibo no lo necesita: se pide razonamiento mínimo y resolución media.
export function configuracionRapida(nombreModelo) {
  const m = String(nombreModelo).match(/gemini-(\d+(?:\.\d+)?)/);
  const version = m ? parseFloat(m[1]) : 0;
  if (version >= 3) {
    return {
      thinkingConfig: { thinkingLevel: 'low' },
      mediaResolution: 'MEDIA_RESOLUTION_MEDIUM'
    };
  }
  if (version >= 2.5) {
    return {
      // Los modelos pro no permiten desactivar el razonamiento: se usa el mínimo
      thinkingConfig: { thinkingBudget: /pro/.test(nombreModelo) ? 128 : 0 },
      mediaResolution: 'MEDIA_RESOLUTION_MEDIUM'
    };
  }
  return {};
}
const TIEMPO_MINIMO_INTENTO_MS = 4000;
const MAX_DESCUBIERTOS = 2;

const URL_LISTA_MODELOS ='https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';
const TTL_CACHE_MS = 60 * 60 * 1000;
let cacheModelos = { lista: null, expira: 0 };

const EXCLUIR_MODELO = /(embedding|aqa|tts|audio|live|image-generation|imagen|veo|robotics|computer-use|learnlm|gemma)/i;

// Prioriza: flash antes que pro, estables antes que preview/exp, versión más nueva primero
export function ordenarModelosDisponibles(modelos) {
  const version = (n) => {
    const m = n.match(/gemini-(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  };
  const puntaje = (n) =>
    (/flash/.test(n) ? 0 : 10) +
    (/lite/.test(n) ? 1 : 0) +
    (/(preview|exp|latest)/.test(n) ? 5 : 0);

  return modelos
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace(/^models\//, ''))
    .filter(n => /^gemini-/.test(n) && /(flash|pro)/.test(n) && !EXCLUIR_MODELO.test(n))
    .sort((a, b) => puntaje(a) - puntaje(b) || version(b) - version(a) || a.localeCompare(b));
}

async function descubrirModelos() {
  if (cacheModelos.lista && Date.now() < cacheModelos.expira) return cacheModelos.lista;

  const resp = await fetch(URL_LISTA_MODELOS, {
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(8000)
  });
  const cuerpo = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`ListModels ${resp.status}: ${cuerpo?.error?.message || resp.statusText}`);
  }

  const lista = ordenarModelosDisponibles(cuerpo.models || []);
  cacheModelos = { lista, expira: Date.now() + TTL_CACHE_MS };
  console.info('Modelos Gemini disponibles para esta API key:', lista.slice(0, 6).join(', '));
  return lista;
}

// Modelos que respondieron "no disponible": se omiten durante una hora para no repetir el 404
const modelosNoDisponibles = new Map();
const marcarNoDisponible = (nombre) => modelosNoDisponibles.set(nombre, Date.now() + TTL_CACHE_MS);
const estaNoDisponible = (nombre) => {
  const expira = modelosNoDisponibles.get(nombre);
  if (expira && Date.now() < expira) return true;
  modelosNoDisponibles.delete(nombre);
  return false;
};

const esModeloNoDisponible = (err) =>
  /\b404\b|not found|no longer available|is not supported|deprecated/i.test(String(err?.message || ''));

// ---------- Imagen en formato inlineData ----------

const MIME_SOPORTADOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

// Detecta el tipo real por los primeros bytes (los celulares a veces envían octet-stream o image/jpg)
export function detectarMime(buffer, mimeDeclarado) {
  const b = buffer;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const marca = b.toString('ascii', 8, 12);
    return /hei|mif|msf/.test(marca) ? 'image/heic' : 'image/heif';
  }
  const declarado = String(mimeDeclarado || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  return MIME_SOPORTADOS.includes(declarado) ? declarado : 'image/jpeg';
}

export function construirParteImagen(buffer, mimeDeclarado) {
  const datos = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (datos.length === 0) throw new Error('La imagen llegó vacía');
  return {
    inlineData: {
      data: datos.toString('base64'),
      mimeType: detectarMime(datos, mimeDeclarado)
    }
  };
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

  let parteImagen;
  try {
    parteImagen = construirParteImagen(buffer, mimeType);
  } catch (err) {
    return { ...vacio, ocr_ok: false, ocr_error: err.message };
  }

  // Formato de la API: texto + imagen en base64 como inlineData { data, mimeType }
  const partes = [{ text: prompt }, parteImagen];

  const errores = [];
  const intentados = new Set();
  let descubiertos = false;

  // Límite total para que la petición nunca se quede colgada
  const limite = Date.now() + TIEMPO_TOTAL_MS;

  const llamar = async (nombreModelo, extras) => {
    const timeout = Math.min(TIEMPO_POR_MODELO_MS, limite - Date.now());
    const model = genAI.getGenerativeModel(
      {
        model: nombreModelo,
        generationConfig: { responseMimeType: 'application/json', temperature: 0, ...extras }
      },
      { timeout }
    );
    const inicio = Date.now();
    const result = await model.generateContent(partes);
    console.info(`Gemini ${nombreModelo} respondió en ${Date.now() - inicio} ms`);
    return extraerJson(result.response.text());
  };

  const intentarModelo = async (nombreModelo) => {
    intentados.add(nombreModelo);
    const extras = configuracionRapida(nombreModelo);
    try {
      return await llamar(nombreModelo, extras);
    } catch (err) {
      // Si el modelo no reconoce la configuración rápida (400), se reintenta sin ella
      const rechazoConfig = /\b400\b|invalid argument|unknown name|thinking|media_?resolution/i.test(String(err?.message));
      if (Object.keys(extras).length && rechazoConfig && limite - Date.now() > TIEMPO_MINIMO_INTENTO_MS) {
        console.warn(`Gemini ${nombreModelo} rechazó la configuración rápida; reintentando sin ella`);
        return llamar(nombreModelo, {});
      }
      throw err;
    }
  };

  const configurados = modelosConfigurados();
  const cola = configurados.filter(m => !estaNoDisponible(m));
  // Si todos los preferidos están marcados como retirados, se pasa directo a los descubiertos
  if (cola.length < configurados.length && cacheModelos.lista) {
    descubiertos = true;
    cola.push(...cacheModelos.lista.filter(m => !estaNoDisponible(m)).slice(0, MAX_DESCUBIERTOS));
  }
  while (cola.length > 0) {
    if (limite - Date.now() < TIEMPO_MINIMO_INTENTO_MS) {
      errores.push('Tiempo de lectura agotado');
      break;
    }
    const nombreModelo = cola.shift();
    if (intentados.has(nombreModelo)) continue;
    try {
      const datos = await intentarModelo(nombreModelo);

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

      // Modelo retirado o no habilitado para la key: se descubren los disponibles (una sola vez)
      if (esModeloNoDisponible(err)) marcarNoDisponible(nombreModelo);
      if (esModeloNoDisponible(err) && !descubiertos) {
        descubiertos = true;
        try {
          const disponibles = await descubrirModelos();
          cola.push(...disponibles.filter(m => !intentados.has(m)).slice(0, MAX_DESCUBIERTOS));
        } catch (errLista) {
          console.warn(`No se pudo consultar ListModels: ${errLista.message}`);
          errores.push(errLista.message);
        }
      }
    }
  }

  console.error('Ningún modelo de Gemini respondió:', errores.join(' | '));
  const huboDemora = errores.some(e => /abort|timeout|timed out|tiempo/i.test(e));
  return {
    ...vacio,
    ocr_ok: false,
    ocr_error: huboDemora
      ? 'La lectura con IA tardó demasiado.'
      : 'No se pudo leer el recibo con IA. ' + (errores[errores.length - 1] || '').slice(0, 250)
  };
}
