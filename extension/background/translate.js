import { deeplTranslate } from './deepl.js';
import { storyTag } from './story-context.js';
import { dialogueSystemPrompt, dialogueUserMessage, cleanLlmOutput } from '../shared/dialogue-prompt.js';
import { pythonTranslate } from './python-bridge.js';

const CACHE_PREFIX = 'tr:';
const PROMPT_VERSION = 8;
const LLM_CONTEXT_LINES = 8;
const SHORT_CONTEXT_S = 15;
const inflight = new Map();

// LLM translators follow the natural-dialogue prompt and use the video's earlier dialogue + story background.
const LLM = new Set(['ollama', 'nano']);

export const ollamaUserMessage = dialogueUserMessage;

async function ollamaTranslate(text, { ollamaUrl, ollamaModel }, target, context, story) {
  const res = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: dialogueSystemPrompt(target) },
        { role: 'user', content: dialogueUserMessage(text, context, story) },
      ],
    }),
  }).catch(() => {
    throw new Error(`Ollama not reachable at ${ollamaUrl} â€“ is it running?`);
  });
  if (res.status === 403) {
    throw new Error('Ollama rejected the extension origin â€“ set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.');
  }
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  return cleanLlmOutput(data.message?.content);
}

/**
 * @param {string} text
 * @param {object} settings
 * @param {(type: string, payload: object) => Promise<any>} toOffscreen  runs on-device models
 * @param {Array<string|{text: string, ago: number}>} [context] earlier dialog of this video, oldest first
 *   (ago = seconds before the current line); used to disambiguate, never translated
 * @param {string} [story] video title/description/synopsis; LLM translators only
 */
/** Subtitles read better without a closing full stop; ?, ! and ellipses are kept. */
export function stripFinalPeriod(s) {
  return typeof s === 'string' ? s.replace(/(?<![.。…])[.。](?=["'”’」』)）]*\s*$)/u, '') : s;
}

export async function translate(text, settings, toOffscreen, context = [], story = '') {
  const res = await translateRaw(text, settings, toOffscreen, context, story);
  return { ...res, translation: stripFinalPeriod(res.translation) };
}

async function translateRaw(text, settings, toOffscreen, context = [], story = '') {
  const { translator, targetLang } = settings;
  if (translator === 'python') return pythonTranslate(text, settings, context, story);
  const llm = LLM.has(translator);
  const useStory = llm && settings.storyContext && story ? story : '';
  const base = translator === 'ollama' ? `ollama/${settings.ollamaModel}` : translator;
  const model = llm ? `${base}/prompt-v${PROMPT_VERSION}${useStory ? `/story-${storyTag(useStory)}` : ''}` : translator;
  // Opus-MT is a plain sentence model with no way to take context. LLMs read a longer stretch of the
  // video's dialog; DeepL/Chrome only the lines right before (Chrome must keep line boundaries intact).
  const lines = (context ?? [])
    .map((c) => (typeof c === 'string' ? { text: c, ago: 0 } : c))
    .filter((c) => c?.text);
  const shortCtx = lines.filter((c) => c.ago <= SHORT_CONTEXT_S).slice(-2).map((c) => c.text);
  const ctx = !settings.translationContext || translator === 'opus'
    ? []
    : llm
      ? lines.slice(-LLM_CONTEXT_LINES).map((c) => c.text)
      : shortCtx;
  const cacheKey = `${CACHE_PREFIX}${model}:${targetLang}:${text}${ctx.length ? `\u0000${ctx.join('\n')}` : ''}`;

  // Which translator really answered, for the logs.
  const via = {
    provider: translator,
    ...(llm && {
      model: translator === 'ollama' ? settings.ollamaModel : 'gemini-nano',
      prompt: PROMPT_VERSION,
      story: !!useStory,
    }),
    contextLines: ctx.length,
  };
  const hit = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (hit !== undefined) return { translation: hit, cached: true, via };
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const job = (async () => {
    const { source, target } = globalThis.HSR_langPair(settings);
    let translation;
    let fallback = null;
    let prefilled = false;
    if (translator === 'deepl') translation = await deeplTranslate(text, settings, ctx);
    else if (translator === 'ollama') translation = await ollamaTranslate(text, settings, target, ctx, useStory);
    else {
      const res = await toOffscreen('TRANSLATE_LOCAL', {
        provider: translator, text, from: source, to: target, context: ctx, story: useStory,
        fallbackContext: settings.translationContext ? shortCtx : [],
        // Gemini Nano pre-processes the context the next line will get (this line appended, same limit).
        contextLimit: llm && settings.translationContext ? LLM_CONTEXT_LINES : 0,
      });
      translation = res.translation;
      fallback = res.fallback ? { provider: res.fallback, reason: res.reason } : null;
      prefilled = !!res.prefilled;
    }
    // A fallback answer isn't cached under the LLM's key, so the line is redone once the model is ready.
    if (fallback) {
      const fallbackVia = { provider: fallback.provider, fallbackFrom: translator, reason: fallback.reason, contextLines: settings.translationContext ? shortCtx.length : 0 };
      return { translation, cached: false, via: fallbackVia };
    }
    await chrome.storage.local.set({ [cacheKey]: translation });
    return { translation, cached: false, via: prefilled ? { ...via, prefilled } : via };
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
