import { createPromptOcrSession, inspectPromptCapabilities, testImageToEnglish, testImageToBilingual, parseBilingualImageResponse } from '../offscreen/prompt-ocr.js';
import { bridgeUrl } from '../background/python-bridge.js';

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

  function showOcrFields() {
    $('#promptOcrSettings').hidden = !['prompt', 'paddle-vision'].includes($('[name="ocrEngine"]').value);
  }

  async function load() {
    const settings = await chrome.storage.sync.get(DEFAULTS);
    if (settings.ocrEngine === 'native') {
      settings.ocrEngine = DEFAULTS.ocrEngine;
      await chrome.storage.sync.set({ ocrEngine: settings.ocrEngine });
      HSR_log('info', 'options', 'Retired Chrome native OCR selection replaced with PaddleOCR');
      flash($('#saved'), 'Chrome native OCR replaced with PaddleOCR');
    }
    if (['opus', 'ollama'].includes(settings.translator)) {
      const previous = settings.translator;
      settings.translator = DEFAULTS.translator;
      await chrome.storage.sync.set({ translator: settings.translator });
      HSR_log('info', 'options', `Retired translator ${previous} replaced with ${settings.translator}`);
      flash($('#saved'), 'Obsolete translator replaced with Gemini Nano');
    }
    for (const input of fields) writeField(input, settings[input.name]);
    $('#pythonToken').value = (await chrome.storage.local.get('pythonToken')).pythonToken ?? '';
    showProviderFields();
    showOcrFields();
  }

  $('#resetOverlayY').addEventListener('click', async () => {
    await chrome.storage.sync.remove('overlayY');
    flash($('#saved'), 'Saved');
  });

  for (const input of fields) {
    input.addEventListener('change', async () => {
      let value = readField(input);
      if (input.name === 'pythonUrl') {
        try { value = bridgeUrl(value); } catch (e) {
          flash($('#saved'), e.message, true);
          return;
        }
      }
      if (input.name === 'cropTop' || input.name === 'cropBottom') {
        const top = readField($('[name="cropTop"]'));
        const bottom = readField($('[name="cropBottom"]'));
        if (top >= bottom) {
          flash($('#saved'), 'Crop top must be above crop bottom.', true);
          return;
        }
      }
      if (input.name === 'captureIntervalMs') value = Math.max(250, value);
      // Picking a preset position drops the dragged one.
      await chrome.storage.sync.set({ [input.name]: value });
      if (input.name === 'overlayPosition') await chrome.storage.sync.remove('overlayY');
      if (input.name === 'translator') showProviderFields();
      if (input.name === 'ocrEngine') showOcrFields();
      flash($('#saved'), 'Saved');
    });
  }

  $('#pythonToken').addEventListener('change', async () => {
    await chrome.storage.local.set({ pythonToken: $('#pythonToken').value.trim() });
    flash($('#saved'), 'Local token saved');
  });

  $('#testPython').addEventListener('click', async () => {
    const out = $('#pythonResult');
    out.classList.remove('error');
    out.textContent = 'Connecting...';
    try {
      const pythonUrl = bridgeUrl($('[name="pythonUrl"]').value.trim());
      await chrome.storage.sync.set({ pythonUrl });
      await chrome.storage.local.set({ pythonToken: $('#pythonToken').value.trim() });
      const res = await chrome.runtime.sendMessage({ type: 'PYTHON_HEALTH' });
      if (!res || res.error) throw new Error(res?.error || 'No response from background service worker.');
      out.textContent = `Connected: ${res.model}`;
      HSR_log('info', 'options', out.textContent);
    } catch (e) {
      out.textContent = e.message;
      out.classList.add('error');
      HSR_log('error', 'options', 'Python connection failed:', e.message);
    }
  });

  $('#inspectPromptApi').addEventListener('click', async () => {
    const button = $('#inspectPromptApi');
    const out = $('#promptApiReport');
    button.disabled = true;
    out.hidden = false;
    out.textContent = 'Querying Chrome Prompt API capabilities...';
    try {
      const report = await inspectPromptCapabilities();
      out.textContent = JSON.stringify(report, null, 2);
      HSR_log('info', 'options', 'Prompt API capability report:', out.textContent);
    } catch (e) {
      out.textContent = `${e.name}: ${e.message}`;
      HSR_log('error', 'options', 'Prompt API inspection failed:', out.textContent);
    } finally {
      button.disabled = false;
    }
  });

  $('#prepareOcrModel').addEventListener('click', async () => {
    const button = $('#prepareOcrModel');
    const out = $('#ocrModelResult');
    button.disabled = true;
    out.classList.remove('error');
    out.textContent = 'Checking image input support (output languages undeclared)...';
    try {
      const session = await createPromptOcrSession({
        download: true,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            out.textContent = `Downloading OCR model: ${Math.round(e.loaded * 100)}%`;
          });
        },
      });
      session.destroy();
      out.textContent = 'OCR model ready. Play a video or capture a frame to test recognition.';
      HSR_log('info', 'options', 'Chrome Prompt API image OCR model ready');
    } catch (e) {
      out.textContent = `OCR model: ${e.message}`;
      out.classList.add('error');
      HSR_log('error', 'options', out.textContent);
    } finally {
      button.disabled = false;
    }
  });

  async function sampleImage(sample) {
    await document.fonts.ready;
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 100;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create the OCR test image.');
    ctx.fillStyle = '#202020';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '48px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(sample, canvas.width / 2, canvas.height / 2);
    return canvas;
  }

  $('#testImageEnglish').addEventListener('click', async () => {
    const button = $('#testImageEnglish');
    const out = $('#imageEnglishResult');
    button.disabled = true;
    out.textContent = 'Testing image input with English output...';
    out.classList.remove('error');
    try {
      const sample = '我们明天见';
      const canvas = await sampleImage(sample);
      const start = performance.now();
      const response = await testImageToEnglish(canvas, (value) => {
        out.textContent = `Chrome availability: ${value}. Testing inference...`;
      });
      out.textContent = `Source image: "${sample}". Model response: "${response}" (${Math.round(performance.now() - start)} ms). Expected meaning: "See you tomorrow." Check semantic accuracy; availability alone is not a pass.`;
      HSR_log('info', 'options', 'Image → English test:', out.textContent);
    } catch (e) {
      out.textContent = `${e.name}: ${e.message}`;
      out.classList.add('error');
      HSR_log('error', 'options', 'Image → English test:', out.textContent);
    } finally {
      button.disabled = false;
    }
  });

  $('#testImageBilingual').addEventListener('click', async () => {
    const button = $('#testImageBilingual');
    const out = $('#imageBilingualResult');
    button.disabled = true;
    out.classList.remove('error');
    out.textContent = 'Testing Chinese + English image output (no output language declaration)...';
    try {
      const sample = '我们明天见';
      const canvas = await sampleImage(sample);
      const start = performance.now();
      const response = await testImageToBilingual(canvas);
      out.textContent = `Source image: "${sample}". Raw model response: ${response} (${Math.round(performance.now() - start)} ms).`;
      let data;
      try {
        data = parseBilingualImageResponse(response);
      } catch (e) {
        throw new Error(`Invalid JSON. Raw model response: ${response}`, { cause: e });
      }
      if (!data || typeof data.chinese !== 'string' || typeof data.english !== 'string'
          || Object.keys(data).length !== 2
          || data.chinese.replace(/[\s\p{P}]/gu, '') !== sample
          || !data.english.trim() || /\p{Script=Han}/u.test(data.english)) {
        throw new Error(`Bilingual output mismatch. Raw model response: ${response}`);
      }
      out.textContent += ' Chinese transcription matches; expected English meaning: "See you tomorrow."';
      HSR_log('info', 'options', 'Bilingual image test:', out.textContent);
    } catch (e) {
      out.textContent = `${e.name}: ${e.message}`;
      out.classList.add('error');
      HSR_log('error', 'options', 'Bilingual image test:', out.textContent);
    } finally {
      button.disabled = false;
    }
  });

  $('#prepareModel').addEventListener('click', async () => {
    const out = $('#deeplResult');
    const settings = await chrome.storage.sync.get(DEFAULTS);
    if (settings.translator === 'nano') {
      if (typeof LanguageModel === 'undefined') {
        flash(out, 'Gemini Nano (Chrome Prompt API) not available in this browser – needs Chrome 138+.', true);
        return;
      }
      const { target } = globalThis.HSR_langPair(settings);
      const langs = ['en', 'es', 'ja'].includes(target) ? { expectedOutputs: [{ type: 'text', languages: [target] }] } : {};
      try {
        out.textContent = 'Checking…';
        const availability = await LanguageModel.availability(langs);
        if (availability === 'unavailable') {
          flash(out, 'Gemini Nano is not supported on this device (needs a capable GPU or 16 GB RAM, ~22 GB free disk).', true);
          return;
        }
        // Runs here because downloading the model requires a user gesture.
        const s = await LanguageModel.create({
          ...langs,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              out.textContent = `Downloading Gemini Nano: ${Math.round(e.loaded * 100)}%`;
            });
          },
        });
        s.destroy();
        out.textContent = 'Model ready – testing…';
        const res = await chrome.runtime.sendMessage({ type: 'TRANSLATE', text: '你这是在用命给我争取时间吗' }).catch((e) => ({ error: e.message }));
        if (res?.error) flash(out, res.error, true);
        else flash(out, `Ready: “${res?.translation}”`);
      } catch (e) {
        flash(out, `Gemini Nano: ${e.message}`, true);
      }
      return;
    }
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
    flash(out, 'Model preparation is available only for Chrome built-in and Gemini Nano.', true);
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
