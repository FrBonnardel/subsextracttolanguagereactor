import { dialogueSystemPrompt } from '../shared/dialogue-prompt.js';

const recentTranslations = new Map();
const MAX_RECENT = 256;

export function bridgeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Python bridge URL must be a loopback HTTP address, such as http://127.0.0.1:8765');
  }
  url.hostname = '127.0.0.1';
  return url.origin;
}

async function request(path, settings, body, imageOptions = null) {
  const base = bridgeUrl(settings.pythonUrl);
  const { pythonToken } = await chrome.storage.local.get('pythonToken');
  if (!pythonToken) throw new Error('Python bridge token is missing. Copy it from the Python app into Settings.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${pythonToken}`,
        ...(body && { 'Content-Type': imageOptions ? imageOptions.contentType : 'application/json' }),
        ...(imageOptions && { 'X-Hanzi-Options': JSON.stringify(imageOptions.settings) }),
        ...(imageOptions && { 'X-Hanzi-Context': imageOptions.context }),
        ...(imageOptions?.paddle && { 'X-Hanzi-Paddle': imageOptions.paddle }),
      },
      ...(body && { body: imageOptions ? body : JSON.stringify(body) }),
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 429 && path === '/ocr') return { skipped: true, reason: data.error || 'Python bridge busy' };
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
  } catch (e) {
    throw new Error(`Python bridge ${base}: ${e.name === 'AbortError' ? 'request timed out after 15 s' : e.message}`, { cause: e });
  } finally {
    clearTimeout(timeout);
  }
}

function translationContext(text, settings, context = [], story = '') {
  const lines = settings.translationContext === false ? [] : context
    .map((line) => typeof line === 'string' ? line : line?.text)
    .filter((line) => line && line !== text).slice(-8);
  const background = settings.storyContext ? story : '';
  if (lines.some((line) => typeof line !== 'string' || line.length > 500)
    || typeof background !== 'string' || background.length > 4000) {
    throw new Error('Python translation context exceeds eight 500-character lines or 4000 characters of background.');
  }
  return { context: lines, story: background, systemPrompt: dialogueSystemPrompt('en') };
}

function translationKey(text, settings, context) {
  return JSON.stringify([bridgeUrl(settings.pythonUrl), settings.targetLang, text, context]);
}

function encodeContext(context) {
  const bytes = new TextEncoder().encode(JSON.stringify(context));
  const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
  if (encoded.length > 60 * 1024) throw new Error('Python translation context exceeds the 60 KiB transfer limit.');
  return encoded;
}

function checkTarget(settings) {
  if (settings.translator === 'python' && !settings.targetLang.toUpperCase().startsWith('EN')) {
    throw new Error('Python bridge currently supports Chinese to English only. Select an English target language.');
  }
}

export async function pythonHealth(settings) {
  const data = await request('/health', settings);
  if (data.ok !== true || data.protocol !== 1 || data.target !== 'en') {
    throw new Error('Python bridge returned an incompatible health response (protocol 1, English required).');
  }
  if (data.binaryOcr !== true) throw new Error('Restart the updated Python app to enable binary image transfer.');
  if (data.contextualTranslation !== true) throw new Error('Update and restart the Python app to enable context-aware Qwen translation.');
  if (data.wholeBandOcr === true && data.clientPreCrop !== true) {
    throw new Error('Update and restart the Python app: Paddle cropping now runs in the extension.');
  }
  return data;
}

export async function pythonOcr(image, opts, settings) {
  checkTarget(settings);
  const t0 = performance.now();
  const match = typeof image === 'string' && /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(image);
  if (!match || match[2].length > 8 * 1024 * 1024) throw new Error('Python OCR requires a PNG/JPEG crop of at most 6 MiB.');
  const pixels = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
  const source = opts.translationContext ?? {};
  const context = translationContext('', settings, source.context, source.story);
  if (opts.paddleText != null && (typeof opts.paddleText !== 'string' || opts.paddleText.length > 4000)) {
    throw new Error('Paddle diagnostic text must contain at most 4000 characters.');
  }
  const data = await request('/ocr', settings, pixels, {
    contentType: `image/${match[1]}`,
    context: encodeContext(context),
    paddle: opts.paddleText == null ? null : encodeContext({ paddleText: opts.paddleText }),
    settings: {
      centered: opts.ocrCenteredOnly ?? true, color: opts.subtitleColor ?? 'white',
      edgeBoost: opts.ocrEdgeBoost ?? true, minConfidence: opts.minConfidence ?? 50, target: 'en',
      ...(opts.capturedAt != null && { capturedAt: opts.capturedAt }),
    },
  });
  if (data.skipped) return data;
  const confidenceValid = data.wholeBandOcr === true
    ? data.confidence === null && Array.isArray(data.boxes) && data.boxes.length === 0
    : Number.isFinite(data.confidence) && data.confidence >= 0 && data.confidence <= 100;
  if (data.contextualTranslation !== true || typeof data.text !== 'string' || typeof data.raw !== 'string' || typeof data.translation !== 'string'
    || !confidenceValid
    || !Array.isArray(data.boxes) || data.boxes.some((box) =>
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0)
    || !Number.isFinite(data.timings?.total_ms) || (data.text && !data.translation.trim())) {
    throw new Error('Python bridge returned an invalid OCR/translation response.');
  }
  if (data.text) {
    const key = translationKey(data.text, settings, {
      ...context, context: context.context.filter((line) => line !== data.text),
    });
    recentTranslations.delete(key);
    recentTranslations.set(key, data.translation);
    if (recentTranslations.size > MAX_RECENT) recentTranslations.delete(recentTranslations.keys().next().value);
  }
  const roundTripMs = Math.round(performance.now() - t0);
  HSR_log('debug', 'python', `OCR+translation round trip ${roundTripMs} ms; server ${Math.round(data.timings.total_ms)} ms`);
  return { ...data, roundTripMs };
}

export async function pythonTranslate(text, settings, previous = [], story = '') {
  checkTarget({ ...settings, translator: 'python' });
  const context = translationContext(text, settings, previous, story);
  const key = translationKey(text, settings, context);
  const via = { provider: 'python', model: 'local-qwen', contextLines: context.context.length, story: !!context.story };
  if (recentTranslations.has(key)) {
    return { translation: recentTranslations.get(key), cached: true, via };
  }
  const data = await request('/translate', settings, { text, target: 'en', ...context });
  if (data.contextualTranslation !== true || typeof data.translation !== 'string' || !data.translation.trim()) {
    throw new Error('Python bridge returned an invalid translation response.');
  }
  return { translation: data.translation, cached: !!data.cached, via };
}
