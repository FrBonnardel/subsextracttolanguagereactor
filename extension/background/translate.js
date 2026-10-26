import { deeplTranslate } from './deepl.js';

const CACHE_PREFIX = 'tr:';
const inflight = new Map();

async function ollamaTranslate(text, { ollamaUrl, ollamaModel }, target, context) {
  const language = new Intl.DisplayNames(['en'], { type: 'language' }).of(target) ?? target;
  const user = context.length
    ? `Previous subtitle lines (context only, do not translate):\n${context.join('\n')}\n\nTranslate this line:\n${text}`
    : text;
  const res = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      options: { temperature: 0 },
      messages: [
        {
          role: 'system',
          content: `You translate Chinese video subtitles into ${language}. Reply with the translation only, no notes or quotes.`,
        },
        { role: 'user', content: user },
      ],
    }),
  }).catch(() => {
    throw new Error(`Ollama not reachable at ${ollamaUrl} – is it running?`);
  });
  if (res.status === 403) {
    throw new Error('Ollama rejected the extension origin – set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.');
  }
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  return (data.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * @param {string} text
 * @param {object} settings
 * @param {(type: string, payload: object) => Promise<any>} toOffscreen  runs on-device models
 * @param {string[]} [context] preceding subtitle lines, oldest first; used to disambiguate, never translated
 */
export async function translate(text, settings, toOffscreen, context = []) {
  const { translator, targetLang } = settings;
  const model = translator === 'ollama' ? `ollama/${settings.ollamaModel}` : translator;
  // Opus-MT is a plain sentence model with no way to take context.
  const ctx = settings.translationContext && translator !== 'opus' ? context.filter(Boolean).slice(-2) : [];
  const cacheKey = `${CACHE_PREFIX}${model}:${targetLang}:${text}${ctx.length ? `\u0000${ctx.join('\n')}` : ''}`;

  const hit = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (hit !== undefined) return { translation: hit, cached: true };
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const job = (async () => {
    const { source, target } = globalThis.HSR_langPair(settings);
    let translation;
    if (translator === 'deepl') translation = await deeplTranslate(text, settings, ctx);
    else if (translator === 'ollama') translation = await ollamaTranslate(text, settings, target, ctx);
    else translation = (await toOffscreen('TRANSLATE_LOCAL', { provider: translator, text, from: source, to: target, context: ctx })).translation;
    await chrome.storage.local.set({ [cacheKey]: translation });
    return { translation, cached: false };
  })().finally(() => inflight.delete(cacheKey));

  inflight.set(cacheKey, job);
  return job;
}

export async function clearTranslationCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  await chrome.storage.local.remove(keys);
  return { removed: keys.length };
}
