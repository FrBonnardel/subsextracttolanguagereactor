(async () => {
  const settings = await chrome.storage.sync.get(globalThis.HSR_DEFAULTS);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try {
    const url = new URL(tab?.url ?? '');
    if (/^https?:$/.test(url.protocol)) host = url.hostname;
  } catch { /* non-web page */ }

  const $ = (sel) => document.querySelector(sel);
  const save = (patch) => chrome.storage.sync.set(patch);

  $('#domain').textContent = host || 'Not available on this page';

  const enabled = $('#enabled');
  enabled.checked = settings.enabled;
  enabled.addEventListener('change', () => save({ enabled: enabled.checked }));

  const site = $('#site');
  site.disabled = !host;
  site.checked = host && !settings.disabledDomains.includes(host);
  site.addEventListener('change', () => {
    const set = new Set(settings.disabledDomains);
    if (site.checked) set.delete(host);
    else set.add(host);
    settings.disabledDomains = [...set];
    save({ disabledDomains: settings.disabledDomains });
  });

  for (const input of document.querySelectorAll('[data-key]')) {
    const key = input.dataset.key;
    if (input.type === 'checkbox') {
      input.checked = settings[key];
      input.addEventListener('change', () => save({ [key]: input.checked }));
    } else {
      const out = document.querySelector(`[data-out="${key}"]`);
      const show = () => { if (out) out.textContent = `${input.value}px`; };
      input.value = settings[key];
      show();
      input.addEventListener('input', show);
      // 'change' rather than 'input': storage.sync has a per-minute write quota.
      input.addEventListener('change', () => save({ [key]: Number(input.value) }));
    }
  }

  $('#warn').hidden = settings.translator !== 'deepl' || Boolean(settings.deeplKey);
  $('#sidepanel').addEventListener('click', async () => {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  });
  $('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#logs').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('logs/logs.html') }));
})();
