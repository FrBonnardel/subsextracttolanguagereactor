/* global Translator, LanguageModel */
import { dialogueSystemPrompt, dialogueUserMessage, dialogueContextMessage, cleanLlmOutput } from '../shared/dialogue-prompt.js';

const OPUS_MODEL = 'Xenova/opus-mt-zh-en';

const chromeTranslators = new Map();
let opusPipeline = null;

async function chromeTranslate(text, source, target, context = []) {
  if (typeof Translator === 'undefined') {
    throw new Error('Chrome built-in Translator API unavailable here (needs Chrome 138+). Pick another translator.');
  }
  const key = `${source}>${target}`;
  if (!chromeTranslators.has(key)) {
    const job = (async () => {
      const availability = await Translator.availability({ sourceLanguage: source, targetLanguage: target });
      HSR_log('info', 'translator', `Chrome Translator ${source} → ${target}: ${availability}`);
      if (availability === 'unavailable') throw new Error(`Chrome can't translate ${source} → ${target} on this device.`);
      try {
        return await Translator.create({ sourceLanguage: source, targetLanguage: target });
      } catch (e) {
        // Model downloads need a user gesture, which the offscreen document never has.
        throw new Error(`Chrome translation model not ready (${availability}): ${e.message} – click "Prepare model" in the options.`);
      }
    })();
    job.catch(() => chromeTranslators.delete(key));
    chromeTranslators.set(key, job);
  }
  const translator = await chromeTranslators.get(key);
  if (!context.length) return translator.translate(text);
  // No context API: translate the preceding lines together with this one (one per line) and keep
  // only the last output line. If the line structure isn't preserved, fall back to the line alone.
  const out = (await translator.translate([...context, text].join('\n'))).split('\n').map((l) => l.trim());
  if (out.length === context.length + 1 && out[out.length - 1]) return out[out.length - 1];
  HSR_log('debug', 'translator', `Context dropped (line structure changed): ${out.length} lines for ${context.length + 1}`);
  return translator.translate(text);
}

async function opusTranslate(text, target) {
  if (target !== 'en') throw new Error('The local Opus-MT model only translates into English.');
  if (!opusPipeline) {
    opusPipeline = (async () => {
      HSR_log('info', 'translator', `Loading ${OPUS_MODEL}`);
      const { pipeline, env } = await import('../vendor/transformers/transformers.min.js');
      env.allowLocalModels = false;
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/transformers/');
      env.backends.onnx.wasm.numThreads = 1; // no cross-origin isolation in extension pages
      return pipeline('translation', OPUS_MODEL, { dtype: 'q8', device: 'wasm' });
    })();
    opusPipeline.catch(() => { opusPipeline = null; });
  }
  const translate = await opusPipeline;
  const [out] = await translate(text, { max_new_tokens: 128 });
  return out?.translation_text ?? '';
}

export async function translateLocal({ provider, text, from, to, context = [], story = '', fallbackContext = [], contextLimit = 0 }) {
  if (provider === 'chrome') return { translation: await chromeTranslate(text, from, to, context) };
  if (provider === 'opus') return { translation: await opusTranslate(text, to) };
  if (provider === 'nano') {
    try {
      const translation = await nanoTranslate(text, to, context, story, contextLimit);
      return { translation, prefilled: lastPrefilled };
    } catch (e) {
      if (e.nanoUntranslated) {
        return { translation: await chromeTranslate(text, from, to, fallbackContext), fallback: 'chrome', reason: e.message };
      }
      if (!e.nanoSetup) throw e;
      // Gemini Nano missing, unsupported or not downloaded yet: keep subtitles translated with Chrome's translator.
      if (!nanoFallbackLogged) HSR_log('warn', 'translator', `${e.message} Falling back to Chrome built-in translator.`);
      nanoFallbackLogged = true;
      return { translation: await chromeTranslate(text, from, to, fallbackContext), fallback: 'chrome', reason: e.message };
    }
  }
  throw new Error(`Unknown local translator: ${provider}`);
}

let nanoFallbackLogged = false;

function setupError(message) {
  const err = new Error(message);
  err.nanoSetup = true;
  return err;
}

// ---- Gemini Nano (Chrome Prompt API): on-device LLM, no key, follows the natural-dialogue prompt ----

// Base sessions hold the system prompt and the video's story background, already processed by the model,
// so each line only pays for its own dialogue. Keyed by target language + story; only the latest few are kept.
const nanoSessions = new Map(); // key -> Promise<base session>
const MAX_NANO_SESSIONS = 2;
export const NANO_OUTPUT_LANGS = ['en', 'es', 'ja'];

export function nanoOptions(target, systemPrompt, story = '') {
  const system = story
    ? `${systemPrompt}\n\nBackground about the video (may be incomplete or about a different season/version; context only, never translate it):\n${story}`
    : systemPrompt;
  return {
    initialPrompts: [{ role: 'system', content: system }],
    // The Prompt API declares output languages; others still work but Chrome warns, so only declare supported ones.
    ...(NANO_OUTPUT_LANGS.includes(target) && { expectedOutputs: [{ type: 'text', languages: [target] }] }),
  };
}

function nanoBase(target, story) {
  if (typeof LanguageModel === 'undefined') {
    return Promise.reject(setupError('Gemini Nano (Chrome Prompt API) unavailable in this browser – needs Chrome 138+.'));
  }
  const key = `${target}\u0000${story}`;
  if (nanoSessions.has(key)) {
    const job = nanoSessions.get(key);
    nanoSessions.delete(key); // re-insert as most recently used
    nanoSessions.set(key, job);
    return job;
  }
  const job = (async () => {
    const t0 = performance.now();
    const opts = nanoOptions(target, dialogueSystemPrompt(target), story);
    // Extensions may tune sampling (both values required); stay near-deterministic like Ollama's temperature 0.
    const params = await LanguageModel.params?.().catch(() => null);
    if (params) Object.assign(opts, { temperature: Math.min(0.2, params.maxTemperature), topK: Math.min(3, params.maxTopK) });
    const availability = await LanguageModel.availability(opts);
    if (availability === 'unavailable') {
      throw setupError('Gemini Nano is not supported on this device (needs a GPU with >4 GB VRAM or 16 GB RAM, ~22 GB free disk).');
    }
    try {
      const session = await LanguageModel.create(opts);
      HSR_log('info', 'translator', `Gemini Nano session → ${target}${story ? ' with story context' : ''} ready in ${Math.round(performance.now() - t0)} ms`);
      return session;
    } catch (e) {
      // The ~2 GB model download needs a user gesture, which the offscreen document never has.
      throw setupError(`Gemini Nano not ready (${availability}): ${e.message} – click "Prepare model" in the options.`);
    }
  })();
  job.catch(() => nanoSessions.delete(key));
  nanoSessions.set(key, job);
  while (nanoSessions.size > MAX_NANO_SESSIONS) {
    const [oldKey, old] = nanoSessions.entries().next().value;
    nanoSessions.delete(oldKey);
    old.then((s) => s.destroy(), () => {});
  }
  return job;
}

/** Creates the session ahead of the first subtitle (video found / story loaded) so no line waits for it. */
export async function warmupNano({ to, story = '' }) {
  try {
    await nanoBase(to, story);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Han characters in the answer mean Nano echoed or rephrased the Chinese instead of translating (targets other than zh/ja).
const HAN = /\p{Script=Han}/u;
const HAN_TARGETS = ['zh', 'ja'];

// Question mark, particle (吗/呢/吧/么/嘛), question word, or A-not-A (能不能, 有没有).
const QUESTION = /[?？]|[吗呢吧么嘛]|谁|哪|几|多少|为何|何|啥|咋|难道|岂|(\p{Script=Han})[不没]\1/u;
export const isChineseQuestion = (text) => QUESTION.test(text);

// Keep-alive: while a video plays, a tiny prompt runs when the model has been idle for a while, so the GPU
// stays clocked up between subtitles instead of ramping up for every line. Real translations abort it.
export const NANO_KEEPALIVE_IDLE_MS = 1500;
let nanoLastUse = 0;
let nanoActive = 0;
let keepalive = null; // AbortController of the running ping

export async function keepaliveNano({ to, story = '' }) {
  if (nanoActive || keepalive || performance.now() - nanoLastUse < NANO_KEEPALIVE_IDLE_MS) return { ok: true, skipped: true };
  const controller = new AbortController();
  keepalive = controller;
  let session;
  try {
    const base = await nanoBase(to, story);
    if (controller.signal.aborted) return { ok: true, skipped: true };
    session = await base.clone({ signal: controller.signal });
    // One generated token is enough to run the model on the GPU; the rest is discarded.
    const reader = session.promptStreaming('Reply with OK.', { signal: controller.signal }).getReader();
    await reader.read();
    reader.cancel().catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    session?.destroy();
    if (keepalive === controller) keepalive = null;
    nanoLastUse = performance.now();
  }
}

async function nanoTranslate(text, target, context, story, contextLimit) {
  keepalive?.abort();
  nanoActive++;
  try {
    return await nanoTranslateLine(text, target, context, story, contextLimit);
  } finally {
    nanoActive--;
    nanoLastUse = performance.now();
  }
}

/*
 * Prepared session: right after a line is translated, a copy of the base session is given the dialogue
 * context the *next* line will most likely receive (the same lines plus this one), and the model processes
 * it in the background. When the next subtitle appears, only the short line itself is left to process.
 */
let prepared = null; // { key, job: Promise<session|null>, controller }
let lastPrefilled = false;
const contextKey = (target, story, context) => `${target}\u0000${story}\u0000${context.join('\n')}`;

async function contextSession(base, context, signal) {
  const session = await base.clone(signal ? { signal } : undefined);
  if (!context.length) return session;
  try {
    await session.append([{ role: 'user', content: dialogueContextMessage(context) }], signal ? { signal } : undefined);
    return session;
  } catch (e) {
    session.destroy();
    throw e;
  }
}

function takePrepared(key) {
  const p = prepared;
  prepared = null;
  if (!p) return null;
  if (p.key === key) return p.job;
  p.controller.abort();
  p.job.then((s) => s?.destroy());
  return null;
}

function prepareNext(base, target, story, context) {
  if (typeof base.append !== 'function') return;
  takePrepared(null); // drop the stale one
  const controller = new AbortController();
  nanoActive++; // the GPU is busy anyway: no keep-alive ping meanwhile
  const job = contextSession(base, context, controller.signal)
    .catch(() => null)
    .finally(() => { nanoActive--; nanoLastUse = performance.now(); });
  prepared = { key: contextKey(target, story, context), job, controller };
}

async function nanoTranslateLine(text, target, context, story, contextLimit) {
  const base = await nanoBase(target, story);
  const canAppend = typeof base.append === 'function';
  const ask = async (extra = '') => {
    // Each line runs in its own copy of the base session so earlier answers don't pile up in its history.
    let session = canAppend ? await takePrepared(contextKey(target, story, context)) : null;
    if (!extra) lastPrefilled = !!session;
    if (!session) session = canAppend ? await contextSession(base, context) : await base.clone();
    try {
      const message = canAppend
        ? (context.length ? `Translate this line:\n${text}` : text)
        : dialogueUserMessage(text, context);
      return cleanLlmOutput(await session.prompt(message + extra));
    } finally {
      session.destroy();
    }
  };
  const out = await ask();
  const language = new Intl.DisplayNames(['en'], { type: 'language' }).of(target) ?? target;
  let fix = '';
  if (!HAN_TARGETS.includes(target.split('-')[0]) && HAN.test(out)) {
    fix = `\n\nAnswer in ${language} only. Do not write any Chinese characters.`;
  } else if (/[?？]\s*$/.test(out) && !isChineseQuestion(text)) {
    fix = '\n\nThis Chinese line has no question mark, question word or question particle: translate it as a statement, not a question, unless the earlier dialogue makes it clearly a question.';
  }
  if (!fix) {
    if (contextLimit > 0) prepareNext(base, target, story, [...context, text].slice(-contextLimit));
    return out;
  }
  const retry = await ask(fix);
  if (contextLimit > 0) prepareNext(base, target, story, [...context, text].slice(-contextLimit));
  if (!HAN.test(retry) || HAN_TARGETS.includes(target.split('-')[0])) return retry;
  const err = new Error('Gemini Nano answered in Chinese');  err.nanoUntranslated = true;
  throw err;
}