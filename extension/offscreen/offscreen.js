import { OcrEngine } from './ocr.js';
import { Dictionary } from './dictionary.js';
import { translateLocal, warmupNano, keepaliveNano } from './translator.js';

const log = (level, ...parts) => HSR_log(level, 'offscreen', ...parts);

const dict = new Dictionary(chrome.runtime.getURL('data/'));
const ocr = new OcrEngine(dict);
const dictStart = performance.now();
dict.ready().then(
  () => log('info', `Dictionary loaded: ${dict.entries.length} entries in ${Math.round(performance.now() - dictStart)} ms`),
  (e) => log('error', 'Dictionary load failed:', e),
);

const handlers = {
  OCR: (msg) => ocr.process(msg),
  async SEGMENT({ text }) {
    await dict.ready();
    return { tokens: dict.analyze(text) };
  },
  TRANSLATE_LOCAL: (msg) => translateLocal(msg),
  NANO_WARMUP: (msg) => warmupNano(msg),
  NANO_KEEPALIVE: (msg) => keepaliveNano(msg),
  async EXPLORE({ word }) {
    await dict.ready();
    return dict.explore(word);
  },
  RESET_TAB({ tabId }) {
    ocr.resetTab(tabId);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  Promise.resolve(handler(msg)).then(
    (res) => sendResponse(res),
    (err) => {
      log('error', `${msg.type} failed:`, err);
      sendResponse({ error: String(err?.message || err) });
    },
  );
  return true;
});

log('info', 'Offscreen document ready');
