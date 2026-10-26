(async () => {
  const DEFAULTS = globalThis.HSR_DEFAULTS;
  HSR_captureErrors('options');
  const fields = document.querySelectorAll('[name]');
  const $ = (sel) => document.querySelector(sel);

  function readField(input) {
    if (input.type === 'checkbox') return input.checked;
    if (input.type === 'number') {
      const n = Number(input.value);
      return Number.isFinite(n) ? n : DEFAULTS[input.name];
    }
    if (input.name === 'disabledDomains') {
      return input.value.split(/\s+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
    }
    return input.value.trim();
  }

  function writeField(input, value) {
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else if (Array.isArray(value)) input.value = value.join('\n');
    else input.value = value;
  }

  function flash(el, text, isError = false) {
    if (el.id === 'deeplResult') HSR_log(isError ? 'error' : 'info', 'options', text);
    el.textContent = text;
    el.classList.toggle('error', isError);
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.textContent = ''; }, 2500);
  }

  function showProviderFields() {
    const provider = $('[name="translator"]').value;
    for (const el of document.querySelectorAll('[data-provider]')) {
      el.hidden = !el.dataset.provider.split(' ').includes(provider);
    }
  }

  async function load() {
    const settings = await chrome.storage.sync.get(DEFAULTS);
    for (const input of fields) writeField(input, settings[input.name]);
    showProviderFields();
  }

  for (const input of fields) {
    input.addEventListener('change', async () => {
      let value = readField(input);
      if (input.name === 'cropTop' || input.name === 'cropBottom') {
        const top = readField($('[name="cropTop"]'));
        const bottom = readField($('[name="cropBottom"]'));
        if (top >= bottom) {
          flash($('#saved'), 'Crop top must be above crop bottom.', true);
          return;
        }
      }
      if (input.name === 'captureIntervalMs') value = Math.max(250, value);
      await chrome.storage.sync.set({ [input.name]: value });
      if (input.name === 'translator') showProviderFields();
      flash($('#saved'), 'Saved');
    });
  }

  $('#prepareModel').addEventListener('click', async () => {
    const out = $('#deeplResult');
    const settings = await chrome.storage.sync.get(DEFAULTS);
    if (settings.translator === 'chrome') {
      if (typeof Translator === 'undefined') {
        flash(out, 'Chrome built-in Translator API not available in this browser.', true);
        return;
      }
      const { source, target } = globalThis.HSR_langPair(settings);
      try {
        out.textContent = 'Checking…';
        // Runs here because downloading the model requires a user gesture.
        const t = await Translator.create({
          sourceLanguage: source,
          targetLanguage: target,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              out.textContent = `Downloading ${source} → ${target}: ${Math.round(e.loaded * 100)}%`;
            });
          },
        });
        flash(out, `Ready: “${await t.translate('你好，世界')}”`);
        t.destroy();
      } catch (e) {
        flash(out, `Chrome translator: ${e.message}`, true);
      }
      return;
    }
    out.textContent = 'Loading model (first run downloads ~100 MB)…';
    const res = await chrome.runtime.sendMessage({ type: 'TRANSLATE', text: '我们明天见。' }).catch((e) => ({ error: e.message }));
    if (!res) flash(out, 'No response from the background service worker.', true);
    else if (res.error) flash(out, res.error, true);
    else flash(out, `Ready: “${res.translation}”`);
  });

  $('#testKey').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'TRANSLATE', text: '你好，世界' }).catch((e) => ({ error: e.message }));
    if (!res) flash($('#deeplResult'), 'No response from the background service worker.', true);
    else if (res.error) flash($('#deeplResult'), res.error, true);
    else flash($('#deeplResult'), `OK: “${res.translation}”${res.cached ? ' (cached)' : ''}`);
  });

  $('#clearCache').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'CLEAR_TRANSLATION_CACHE' });
    flash($('#deeplResult'), `Removed ${res?.removed ?? 0} cached translations`);
  });

  $('#reset').addEventListener('click', async () => {
    const { deeplKey } = await chrome.storage.sync.get('deeplKey');
    await chrome.storage.sync.clear();
    if (deeplKey) await chrome.storage.sync.set({ deeplKey });
    await load();
    flash($('#saved'), 'Defaults restored (API key kept)');
  });

  await load();
})();
