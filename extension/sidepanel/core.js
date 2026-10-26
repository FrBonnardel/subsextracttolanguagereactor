export function createBus() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    emit(event, data) {
      for (const fn of listeners.get(event) ?? []) {
        try { fn(data); } catch (e) { HSR_log('error', 'sidepanel', `${event} handler:`, e); }
      }
    },
  };
}

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Sends a message to the service worker; throws on error or missing response. */
export async function request(msg) {
  const res = await chrome.runtime.sendMessage(msg).catch((e) => ({ error: e.message }));
  if (!res) throw new Error('No response from background');
  if (res.error) throw new Error(res.error);
  return res;
}

/** Hanzi with pinyin ruby, as a clickable chip. */
export function tokenChip(token, onClick) {
  if (!token.hanzi) return el('span', 'hz', token.text);
  const chip = el('span', `chip${token.entries?.length ? '' : ' unknown'}`);
  const ruby = el('ruby');
  ruby.append(document.createTextNode(token.text), el('rt', null, token.pinyin ?? ''));
  chip.append(ruby);
  chip.title = token.entries?.[0]?.defs?.slice(0, 3).join('; ') ?? '';
  chip.addEventListener('click', () => onClick(token.text, chip));
  return chip;
}
