/* global Translator */
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

export async function translateLocal({ provider, text, from, to, context = [] }) {
  if (provider === 'chrome') return { translation: await chromeTranslate(text, from, to, context) };
  if (provider === 'opus') return { translation: await opusTranslate(text, to) };
  throw new Error(`Unknown local translator: ${provider}`);
}
