const LEAD_IN = 0.8; // seconds

export function formatTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '--:--';
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export default {
  id: 'history',
  title: 'History',
  mount(root, { bus, el, request }) {
    const tools = el('div', 'row');
    const copy = el('button', null, 'Copy');
    const clear = el('button', null, 'Clear');
    const count = el('span', 'muted');
    tools.append(copy, clear, count);
    const list = el('div', 'history');
    root.append(tools, list);

    // Recorded by the service worker into storage.session, so lines are kept while the panel is closed.
    let tabId = null;
    let items = [];
    const key = () => `hist:${tabId}`;
    const seek = (time, play) => chrome.tabs.sendMessage(tabId, { type: 'HSR_SEEK', time, play }).catch(() => {});

    function render(scrollToEnd) {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
      count.textContent = `${items.length} lines`;
      list.replaceChildren(...items.map((item, i) => {
        const row = el('div', `history-item${i === items.length - 1 ? ' latest' : ''}`);
        const time = el('button', 'time', formatTime(item.time));
        time.title = 'Jump here without playing';
        time.disabled = item.time == null;
        time.addEventListener('click', (e) => {
          e.stopPropagation();
          seek(item.time, false);
        });
        const body = el('div', 'body');
        body.append(el('div', 'zh', item.text), el('div', `tr${item.error ? ' error' : ''}`, item.translation ?? ''));
        row.append(time, body);
        row.addEventListener('click', () => {
          bus.emit('show-line', item);
          // Lines are logged when detected, slightly after they appear; start a bit earlier.
          if (item.time != null) seek(Math.max(0, item.time - LEAD_IN), true);
        });
        return row;
      }));
      // Follow new lines unless the user scrolled up to read older ones.
      if (scrollToEnd || nearBottom) list.scrollTop = list.scrollHeight;
    }

    async function load() {
      items = tabId == null ? [] : (await chrome.storage.session.get(key()))[key()] ?? [];
      render(true);
    }

    bus.on('tab', (tab) => {
      tabId = tab?.id ?? null;
      load();
    });

    // Show lines the moment the page reports them; storage updates (below) remain the source of truth.
    bus.on('line', (d) => {
      if (d.replay) return;
      const replaced = d.replaces != null ? items.findLast((i) => i.seq === d.replaces) : null;
      if (replaced) {
        Object.assign(replaced, { seq: d.seq, text: d.text, translation: '', error: undefined });
        render(false);
        return;
      }
      if (items[items.length - 1]?.text === d.text) return;
      items = [...items, { seq: d.seq, text: d.text, time: d.time, at: Date.now(), translation: '' }];
      render(false);
    });
    bus.on('translation', (d) => {
      const item = items.findLast((i) => i.seq === d.seq);
      if (!item) return;
      item.translation = d.text;
      item.error = d.error;
      render(false);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session' || tabId == null || !changes[key()]) return;
      items = changes[key()].newValue ?? [];
      render(false);
    });

    copy.addEventListener('click', () => {
      const text = items.map((i) => `${formatTime(i.time)}\t${i.text}\t${i.translation ?? ''}`).join('\n');
      navigator.clipboard.writeText(text);
    });
    clear.addEventListener('click', async () => {
      if (tabId == null) return;
      await request({ type: 'CLEAR_HISTORY', tabId });
      items = [];
      render(true);
    });
  },
};
