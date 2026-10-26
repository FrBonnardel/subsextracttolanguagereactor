import { createBus, el, request, tokenChip } from './core.js';
import sections from './sections/index.js';

HSR_captureErrors('sidepanel');

const bus = createBus();
/**
 * Shared context handed to every section.
 * Events: tab, state, frame, line, tokens, translation, clear, word (from page) + explore, show-line (panel-internal).
 */
const ctx = {
  bus,
  el,
  request,
  tokenChip,
  activeTabId: null,
  explore: (word) => bus.emit('explore', word),
};

const root = document.getElementById('sections');
for (const section of sections) {
  const details = el('details', 'section');
  details.open = section.open ?? true;
  details.dataset.section = section.id;
  const body = el('div', 'section-body');
  details.append(el('summary', null, section.title), body);
  root.append(details);
  section.mount(body, ctx);
}

function connect() {
  const port = chrome.runtime.connect({ name: 'sidepanel' });
  // The service worker may be restarted; reconnect so it keeps producing frame previews.
  port.onDisconnect.addListener(() => setTimeout(connect, 1000));
}
connect();

const { id: windowId } = await chrome.windows.getCurrent();

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab?.id === ctx.activeTabId) return;
  ctx.activeTabId = tab?.id ?? null;
  bus.emit('tab', tab ?? null);
}

chrome.tabs.onActivated.addListener((info) => info.windowId === windowId && refreshActiveTab());
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tabId === ctx.activeTabId && info.status === 'complete') bus.emit('tab', tab);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'PANEL_EVENT' && sender.tab?.id === ctx.activeTabId) bus.emit(msg.kind, msg.data ?? {});
  return false;
});

refreshActiveTab();
