import '../shared/defaults.js';
import '../shared/log.js';
import { translate, clearTranslationCache } from './translate.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const MAX_LOGS = 1000;
let creatingOffscreen = null;

const getSettings = () => chrome.storage.sync.get(globalThis.HSR_DEFAULTS);
const log = (level, ...parts) => HSR_log(level, 'background', ...parts);

let logBuffer = chrome.storage.local.get(HSR_LOG_KEY).then((r) => r[HSR_LOG_KEY] ?? []);
let flushTimer = 0;

globalThis.HSR_logSink = async (entry) => {
  const buf = await logBuffer;
  const last = buf[buf.length - 1];
  if (last && last.msg === entry.msg && last.source === entry.source && last.level === entry.level) {
    last.count = (last.count ?? 1) + 1;
    last.t = entry.t;
  } else {
    buf.push(entry);
    if (buf.length > MAX_LOGS) buf.splice(0, buf.length - MAX_LOGS);
  }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => chrome.storage.local.set({ [HSR_LOG_KEY]: buf }), 300);
};

HSR_captureErrors('background');

// Open side panels keep a port; frame debug images are only produced while one is connected.
let panelPorts = 0;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  panelPorts++;
  port.onDisconnect.addListener(() => { panelPorts = Math.max(0, panelPorts - 1); });
});

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  log('info', 'Creating offscreen document');
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS', 'BLOBS'],
      justification: 'Runs the Tesseract OCR worker, the in-memory Chinese dictionary and on-device translation models.',
    })
    .finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

async function toOffscreen(type, payload = {}) {
  await ensureOffscreen();
  // The offscreen listener may not be registered yet right after creation; retry briefly.
  for (let attempt = 0; attempt < 15; attempt++) {
    const res = await chrome.runtime
      .sendMessage({ ...payload, target: 'offscreen', type })
      .catch((e) => (/Receiving end does not exist/i.test(e.message) ? undefined : { error: e.message }));
    if (res !== undefined) {
      if (res?.error) throw new Error(res.error);
      return res;
    }
    log('debug', `Offscreen gave no response to ${type}, retry ${attempt + 1}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Offscreen document not responding – open chrome://extensions → "Inspect views: offscreen.html" and check its console.');
}

const handlers = {
  async CAPTURE_OCR(msg, sender) {
    const tab = sender.tab;
    // captureVisibleTab grabs whatever tab is active, so only the visible tab may request it.
    if (!tab || sender.frameId !== 0) return { skipped: true, reason: 'not a top-level frame' };
    if (!tab.active) return { skipped: true, reason: 'tab not active in its window' };
    const isStillActive = async () => (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id === tab.id;
    let dataUrl;
    const t0 = performance.now();
    try {
      if (!(await isStillActive())) return { skipped: true, reason: 'tab not active in its window' };
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      // The user may have switched tabs mid-capture; the image would then show another tab.
      if (!(await isStillActive())) return { skipped: true, reason: 'tab switched during capture' };
    } catch (e) {
      log('warn', 'captureVisibleTab failed:', e.message);
      return { skipped: true, reason: `captureVisibleTab: ${e.message}` };
    }
    log('debug', `Captured tab ${tab.id} in ${Math.round(performance.now() - t0)} ms`);
    return toOffscreen('OCR', { tabId: tab.id, dataUrl, rect: msg.rect, dpr: msg.dpr, opts: msg.opts, fresh: msg.fresh, debug: panelPorts > 0 });
  },

  OCR_FRAME: (msg, sender) =>
    toOffscreen('OCR', { tabId: sender.tab?.id, dataUrl: msg.dataUrl, precropped: true, opts: msg.opts, fresh: msg.fresh, debug: panelPorts > 0 }),

  SEGMENT: (msg) => toOffscreen('SEGMENT', { text: msg.text }),

  EXPLORE: (msg) => toOffscreen('EXPLORE', { word: msg.word }),

  async TRANSLATE(msg) {
    return translate(msg.text, await getSettings(), toOffscreen, msg.context ?? []);
  },

  CLEAR_TRANSLATION_CACHE: () => clearTranslationCache(),

  async CLEAR_LOGS() {
    logBuffer = Promise.resolve([]);
    await chrome.storage.local.set({ [HSR_LOG_KEY]: [] });
    return { ok: true };
  },

  async CLEAR_HISTORY({ tabId }) {
    histories.set(tabId, Promise.resolve([]));
    await chrome.storage.session.remove(historyKey(tabId));
    return { ok: true };
  },

  async GET_HISTORY(_msg, sender) {
    return { items: sender.tab ? await historyOf(sender.tab.id) : [] };
  },
};

// ---- subtitle history (per tab, kept even while the side panel is closed) ----

const MAX_HISTORY = 500;
const histories = new Map(); // tabId -> Promise<items[]>, oldest first
const historyTimers = new Map();
const historyKey = (tabId) => `hist:${tabId}`;

function historyOf(tabId) {
  if (!histories.has(tabId)) {
    histories.set(tabId, chrome.storage.session.get(historyKey(tabId)).then((r) => r[historyKey(tabId)] ?? []));
  }
  return histories.get(tabId);
}

async function recordHistory(tabId, kind, data) {
  if (kind !== 'line' && kind !== 'translation') return;
  if (data.replay) return; // already in history from the first time it was captured
  const items = await historyOf(tabId);
  if (kind === 'line') {
    const replaced = data.replaces != null ? items.findLast((i) => i.seq === data.replaces) : null;
    if (replaced) {
      Object.assign(replaced, { seq: data.seq, text: data.text, translation: '', error: undefined });
    } else {
      const last = items[items.length - 1];
      if (last?.text === data.text) return;
      items.push({ seq: data.seq, text: data.text, time: data.time, at: Date.now(), page: data.page, translation: '' });
      if (items.length > MAX_HISTORY) items.splice(0, items.length - MAX_HISTORY);
    }
  } else {
    const item = items.findLast((i) => i.seq === data.seq);
    if (!item) return;
    item.translation = data.text;
    item.error = data.error;
  }
  clearTimeout(historyTimers.get(tabId));
  const write = () => chrome.storage.session.set({ [historyKey(tabId)]: items });
  // New lines are written at once; translation updates are batched.
  if (kind === 'line') write();
  else historyTimers.set(tabId, setTimeout(write, 200));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  if (msg?.type === 'LOG') {
    globalThis.HSR_logSink(msg.entry);
    return false;
  }
  if (msg?.type === 'PANEL_EVENT') {
    if (sender.tab?.id != null) recordHistory(sender.tab.id, msg.kind, msg.data ?? {});
    return false;
  }
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg, sender)).then(
    (res) => sendResponse(res),
    (err) => {
      log('error', `${msg.type} failed:`, err);
      sendResponse({ error: String(err?.message || err) });
    },
  );
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  histories.delete(tabId);
  chrome.storage.session.remove(historyKey(tabId));
  if (await hasOffscreen()) chrome.runtime.sendMessage({ target: 'offscreen', type: 'RESET_TAB', tabId }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
  injectIntoOpenTabs();
});

// Manifest content scripts only run on page load, so tabs open before install/reload would be missed.
async function injectIntoOpenTabs() {
  const files = chrome.runtime.getManifest().content_scripts[0].js;
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  let ok = 0;
  await Promise.all(tabs.map((tab) =>
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files }).then(() => ok++, () => {})));
  log('info', `Injected content script into ${ok}/${tabs.length} open tabs`);
}
