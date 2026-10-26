(() => {
  const LEVELS = ['debug', 'info', 'warn', 'error'];
  const $ = (sel) => document.querySelector(sel);
  let entries = [];

  const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour12: false }) + `.${String(t % 1000).padStart(3, '0')}`;

  function visible() {
    const min = LEVELS.indexOf($('#level').value);
    const q = $('#filter').value.trim().toLowerCase();
    return entries.filter((e) => LEVELS.indexOf(e.level) >= min
      && (!q || `${e.source} ${e.msg}`.toLowerCase().includes(q)));
  }

  function asText(list) {
    return list
      .map((e) => `${new Date(e.t).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.msg}${e.count > 1 ? ` (x${e.count})` : ''}`)
      .join('\n');
  }

  function render() {
    const list = visible();
    const rows = list.map((e) => {
      const tr = document.createElement('tr');
      tr.className = e.level;
      for (const text of [time(e.t), e.level, e.source, e.msg]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      if (e.count > 1) {
        const rep = document.createElement('span');
        rep.className = 'repeat';
        rep.textContent = `×${e.count}`;
        tr.lastChild.append(rep);
      }
      return tr;
    });
    $('#rows').replaceChildren(...rows);
    $('#count').textContent = `${list.length} / ${entries.length} entries`;
    if ($('#follow').checked) scrollTo(0, document.body.scrollHeight);
  }

  async function load() {
    entries = (await chrome.storage.local.get(HSR_LOG_KEY))[HSR_LOG_KEY] ?? [];
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[HSR_LOG_KEY]) {
      entries = changes[HSR_LOG_KEY].newValue ?? [];
      render();
    }
  });

  $('#level').addEventListener('change', render);
  $('#filter').addEventListener('input', render);
  $('#clear').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }));
  $('#copy').addEventListener('click', () => navigator.clipboard.writeText(asText(visible())));
  $('#download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([asText(entries)], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `hanzi-subs-reactor-${Date.now()}.log` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  load();
})();
