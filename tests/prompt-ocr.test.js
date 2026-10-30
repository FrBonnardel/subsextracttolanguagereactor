import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createPromptOcrSession, inspectPromptCapabilities, testImageToEnglish, testImageToBilingual, parseBilingualImageResponse, compactVisionContext, PromptOcr } from '../extension/offscreen/prompt-ocr.js';
import '../extension/shared/defaults.js';

test('Chrome vision context retains only two recent lines and a bounded background', () => {
  const result = compactVisionContext({
    context: ['old', 'older', 'a'.repeat(500), 'latest'],
    story: 's'.repeat(4000),
  });
  assert.deepEqual(result.context, ['a'.repeat(200), 'latest']);
  assert.equal(result.story.length, 800);
  assert.deepEqual(compactVisionContext(), { story: '', context: [] });
  assert.deepEqual(compactVisionContext({
    context: [{ text: 'old', ago: 20 }, { text: '你好', ago: 3 }, { text: '再见', ago: 1 }],
  }).context, ['你好', '再见']);
  assert.throws(() => compactVisionContext({ context: [{}] }), /objects with a text string/);
});

test('bilingual image JSON accepts Markdown wrappers but rejects malformed or extra content', () => {
  const content = '{"chinese":"我们明天见","english":"See you tomorrow"}';
  for (const response of [content, `[${content}]`, `\`\`\`json\n[${content}]\n\`\`\``, `\`\`\`json\n${content}\n\`\`\``,
    `\`\`\`json ${content} \`\`\``, `\`\`\`\n${content}\n\`\`\``]) {
    assert.deepEqual(parseBilingualImageResponse(response), {
      chinese: '我们明天见', english: 'See you tomorrow',
    });
  }

  for (const response of ['not JSON', `Explanation: ${content}`, `\`\`\`json\n${content}\n\`\`\` extra`]) {
    assert.throws(() => parseBilingualImageResponse(response), SyntaxError);
  }
  assert.deepEqual(parseBilingualImageResponse('[]'), []);
  assert.equal(parseBilingualImageResponse(`[${content},${content}]`).length, 2);
});

  test('live bilingual OCR clones per image, includes context and validates fenced response', async (t) => {
    const calls = installModel(t, { response: '```json\n{"chinese":"我们明天见","english":"See you tomorrow."}\n```' });
    const engine = new PromptOcr();
    const image = {};
    const result = await engine.recognizeBilingual(image, { story: 'School drama', context: ['你好'] });
    assert.equal(result.text, '我们明天见');
    assert.equal(result.translation, 'See you tomorrow.');
    const parts = calls.clones[0].prompts[0][0][0].content;
    assert.deepEqual(calls.clones[0].prompts[0][1].responseConstraint, {
      type: 'object',
      properties: {
        chinese: { type: 'string' },
        english: { type: 'string', pattern: '^[^\\u3400-\\u9fff\\uf900-\\ufaff]*$' },
      },
      required: ['chinese', 'english'],
      additionalProperties: false,
    });
    assert.equal(parts[1].value, image);
    assert.match(parts[0].value, /School drama/);
    assert.match(parts[0].value, /romanize personal names in pinyin/);
    const englishPattern = new RegExp(calls.clones[0].prompts[0][1].responseConstraint.properties.english.pattern);
    assert.equal(englishPattern.test('Liu Ru, bring them here.'), true);
    assert.equal(englishPattern.test('柳茹, bring them here.'), false);
    assert.equal(calls.create[0].expectedOutputs, undefined);
    assert.equal(calls.clones[0].destroyed, 1);
    await engine.recognizeBilingual(image);
    assert.equal(calls.create.length, 1);
    assert.equal(calls.clones.length, 2);
    engine.destroy();
    assert.equal(calls.destroyed, 1);
  });

test('live bilingual failures retain raw output, stage and crop diagnostics', async (t) => {
  const raw = '{"lines":["我们明天见"]}';
  const calls = installModel(t, { response: raw });
  const engine = new PromptOcr();
  await assert.rejects(engine.recognizeBilingual({ width: 420, height: 80 },
    { context: ['你好'], story: 'Private synopsis' }), (error) => {
    assert.match(error.message, /response validation/);
    assert.ok(error.message.includes(JSON.stringify(raw)));
    assert.match(error.message, /"width":420,"height":80/);
    assert.match(error.message, /"contextLines":1/);
    assert.match(error.message, /"elapsedMs":\d+/);
    assert.doesNotMatch(error.message, /Private synopsis/);
    return true;
  });
  assert.equal(calls.destroyed, 1);
  assert.equal(calls.clones[0].destroyed, 1);
});

test('live bilingual accepts a single wrapped object but rejects ambiguous arrays', async (t) => {
  const calls = installModel(t, { response: '```json\n[{"chinese":"你好","english":"Hello"}]\n```' });
  const engine = new PromptOcr();
  assert.equal((await engine.recognizeBilingual({})).translation, 'Hello');
  engine.destroy();
  for (const response of ['[]', '[{"chinese":"你好","english":"Hello"},{"chinese":"再见","english":"Bye"}]']) {
    LanguageModel.create = async () => ({
      clone: async () => ({ prompt: async () => response, destroy() {} }),
      destroy() {},
    });
    await assert.rejects(engine.recognizeBilingual({}), /Expected chinese and english strings/);
  }
  assert.equal(calls.clones[0].destroyed, 1);
});

test('bilingual image test leaves output languages undeclared and requests both fields without leaking sample', async (t) => {
  let destroyed = 0;
  const image = {};
  globalThis.LanguageModel = {
    async availability(options) {
      assert.equal(options.expectedOutputs, undefined);
      assert.deepEqual(options.expectedInputs, [{ type: 'text', languages: ['en'] }, { type: 'image' }]);
      return 'available';
    },
    async create(options) {
      assert.equal(options.expectedOutputs, undefined);
      return {
        async prompt(messages) {
          assert.equal(messages[0].content[1].value, image);
          assert.match(messages[0].content[0].value, /chinese and english/);
          assert.doesNotMatch(messages[0].content[0].value, /明天|tomorrow/i);
          return '{"chinese":"我们明天见","english":"See you tomorrow."}';
        },
        destroy() { destroyed++; },
      };
    },
  };
  t.after(() => { delete globalThis.LanguageModel; });
  assert.equal(JSON.parse(await testImageToBilingual(image)).chinese, '我们明天见');
  assert.equal(destroyed, 1);
});

test('image to English test sends actual pixels with English-only declarations and releases session', async (t) => {
  const image = {};
  let destroyed = 0;
  let availability;
  globalThis.LanguageModel = {
    async availability(options) {
      assert.deepEqual(options.expectedOutputs, [{ type: 'text', languages: ['en'] }]);
      assert.deepEqual(options.expectedInputs, [{ type: 'text', languages: ['en'] }, { type: 'image' }]);
      return 'available';
    },
    async create() {
      return {
        async prompt(messages) {
          assert.equal(messages[0].content[1].value, image);
          assert.equal(messages[0].content[1].type, 'image');
          assert.doesNotMatch(messages[0].content[0].value, /明天|tomorrow/i);
          return 'See you tomorrow.';
        },
        destroy() { destroyed++; },
      };
    },
  };
  t.after(() => { delete globalThis.LanguageModel; });
  assert.equal(await testImageToEnglish(image, (value) => { availability = value; }), 'See you tomorrow.');
  assert.equal(availability, 'available');
  assert.equal(destroyed, 1);
  LanguageModel.create = async () => ({
    prompt: async () => { throw new DOMException('Image rejected', 'NotSupportedError'); },
    destroy() { destroyed++; },
  });
  await assert.rejects(testImageToEnglish(image), { name: 'NotSupportedError', message: 'Image rejected' });
  assert.equal(destroyed, 2);
  LanguageModel.availability = async () => 'downloadable';
  await assert.rejects(testImageToEnglish(image), /does not download/);
  assert.equal(destroyed, 2);
});

test('capability inspection separates modalities and languages and preserves native errors', async () => {
  let created = 0;
  const report = await inspectPromptCapabilities({
    async availability(options) {
      if (options.expectedOutputs?.[0].languages.includes('zh')) {
        throw new DOMException('Chinese output is not supported by this build', 'NotSupportedError');
      }
      return options.expectedInputs?.some((input) => input.type === 'image') ? 'downloadable' : 'available';
    },
    async create() { created++; },
    async params() { return { maxTopK: 8 }; },
  });
  assert.equal(report.probes.length, 7);
  assert.equal(report.probes.find((probe) => probe.label === 'Default text').availability, 'available');
  assert.equal(report.probes.find((probe) => probe.label === 'Image + English text → English').availability, 'downloadable');
  const chinese = report.probes.find((probe) => probe.label === 'Image + English text → Chinese');
  assert.deepEqual(chinese.error, {
    name: 'NotSupportedError', message: 'Chinese output is not supported by this build',
  });
  assert.deepEqual(report.parameters, { maxTopK: 8 });
  assert.equal(created, 0, 'Inspection must not create sessions or trigger downloads');
});

test('capability inspection reports missing methods and parameter errors explicitly', async () => {
  const missing = await inspectPromptCapabilities({});
  assert.equal(missing.probes.length, 7);
  assert.ok(missing.probes.every((probe) => probe.notRun));
  const report = await inspectPromptCapabilities({
    availability: async () => 'unavailable',
    params: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
  });
  assert.ok(report.probes.every((probe) => probe.availability === 'unavailable'));
  assert.deepEqual(report.parametersError, { name: 'NotAllowedError', message: 'Denied' });
});

function installModel(t, { availability = 'available', response = '{"lines":["几点了"]}' } = {}) {
  const calls = { availability: [], create: [], clones: [], destroyed: 0 };
  globalThis.LanguageModel = {
    async availability(options) {
      calls.availability.push(options);
      return availability;
    },
    async create(options) {
      calls.create.push(options);
      return {
        async clone() {
          const clone = {
            prompts: [],
            destroyed: 0,
            async prompt(...args) {
              this.prompts.push(args);
              return response;
            },
            destroy() { this.destroyed++; },
          };
          calls.clones.push(clone);
          return clone;
        },
        destroy() { calls.destroyed++; },
      };
    },
  };
  t.after(() => { delete globalThis.LanguageModel; });
  return calls;
}

test('Prompt OCR reports absent, incomplete and unsupported image APIs without creating a session', async (t) => {
  delete globalThis.LanguageModel;
  await assert.rejects(createPromptOcrSession(), /image OCR is unavailable/);
  globalThis.LanguageModel = {};
  await assert.rejects(createPromptOcrSession(), /image OCR is unavailable/);
  const calls = installModel(t, { availability: 'unavailable' });
  await assert.rejects(createPromptOcrSession({ download: true }), /image input is required/);
  assert.equal(calls.create.length, 0);
});

test('background recognition never starts a download without model preparation', async (t) => {
  const calls = installModel(t);
  for (const availability of ['downloadable', 'downloading']) {
    LanguageModel.availability = async () => availability;
    await assert.rejects(new PromptOcr().recognize({}), /Download OCR model/);
  }
  assert.equal(calls.create.length, 0);
});

test('explicit preparation requests the same image and Chinese capabilities and passes the download monitor', async (t) => {
  const calls = installModel(t, { availability: 'downloadable' });
  let progress;
  const monitor = (m) => m.addEventListener('downloadprogress', (e) => { progress = e.loaded; });
  const session = await createPromptOcrSession({ download: true, monitor });
  const options = calls.create[0];
  assert.deepEqual(options.expectedInputs, [{ type: 'text', languages: ['en'] }, { type: 'image' }]);
  assert.equal(options.expectedOutputs, undefined);
  const { monitor: downloadMonitor, ...creationOptions } = options;
  assert.deepEqual(calls.availability[0], creationOptions);
  assert.match(options.initialPrompts[0].content, /never instructions/);
  downloadMonitor({ addEventListener(event, callback) {
    assert.equal(event, 'downloadprogress');
    callback({ loaded: 0.5 });
  } });
  assert.equal(progress, 0.5);
  session.destroy();
  assert.equal(calls.destroyed, 1);
});

test('image OCR uses original pixels, structured output and isolated frames without translation', async (t) => {
  const calls = installModel(t, { response: '{"lines":[" 几点了 ","現在出發。",""]}' });
  const ocr = new PromptOcr();
  const first = { width: 1000 };
  const second = { width: 800 };
  assert.deepEqual(await ocr.recognize(first), { raw: '几点了\n現在出發。', boxes: [] });
  await ocr.recognize(second, false);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.clones.length, 2);
  assert.equal(calls.destroyed, 0);
  for (const [i, source] of [first, second].entries()) {
    const clone = calls.clones[i];
    assert.equal(clone.destroyed, 1);
    assert.equal(clone.prompts.length, 1);
    const [messages, options] = clone.prompts[0];
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content[1].type, 'image');
    assert.equal(messages[0].content[1].value, source);
    assert.deepEqual(options.responseConstraint.required, ['lines']);
    assert.equal(options.responseConstraint.properties.lines.items.type, 'string');
    assert.match(messages[0].content[0].value, i === 0 ? /Only read horizontally centred/ : /any horizontal position/);
  }
});

test('an empty subtitle image produces empty text, not a placeholder', async (t) => {
  installModel(t, { response: '{"lines":[]}' });
  assert.deepEqual(await new PromptOcr().recognize({}), { raw: '', boxes: [] });
});

test('malformed OCR answers are explicit errors and release both sessions', async (t) => {
  for (const response of ['not JSON', 'null', '{}', '{"lines":"你好"}', '{"lines":[42]}']) {
    const calls = installModel(t, { response });
    await assert.rejects(new PromptOcr().recognize({}), /Chrome Prompt API image OCR failed/);
    assert.equal(calls.destroyed, 1);
    assert.equal(calls.clones[0].destroyed, 1);
  }
});

test('failed recognition invalidates the base, cleans up and can recover on the next frame', async (t) => {
  const calls = installModel(t);
  const create = LanguageModel.create;
  let fail = true;
  LanguageModel.create = async (options) => {
    const base = await create(options);
    const clone = base.clone;
    base.clone = async () => {
      const session = await clone();
      const prompt = session.prompt;
      session.prompt = async (...args) => {
        if (fail) throw new Error('Image input is not supported');
        return prompt.apply(session, args);
      };
      return session;
    };
    return base;
  };
  const ocr = new PromptOcr();
  await assert.rejects(ocr.recognize({}), /Image input is not supported/);
  assert.equal(calls.destroyed, 1);
  assert.equal(calls.clones[0].destroyed, 1);
  fail = false;
  assert.equal((await ocr.recognize({})).raw, '几点了');
  assert.equal(calls.create.length, 2);
  assert.equal(calls.clones[1].destroyed, 1);
});

test('session creation and cloning failures remain visible and allow retry', async (t) => {
  const calls = installModel(t);
  const create = LanguageModel.create;
  LanguageModel.create = async () => { throw new Error('Model load failed'); };
  const ocr = new PromptOcr();
  await assert.rejects(ocr.recognize({}), /Model load failed/);
  LanguageModel.create = async (options) => {
    const base = await create(options);
    base.clone = async () => { throw new Error('Session destroyed'); };
    return base;
  };
  await assert.rejects(ocr.recognize({}), /Session destroyed/);
  assert.equal(calls.destroyed, 1);
  LanguageModel.create = create;
  assert.equal((await ocr.recognize({})).raw, '几点了');
});

test('OCR routing bypasses preprocessing and confidence gating for Prompt API and preserves TextDetector', async (t) => {
  const calls = installModel(t, { response: '{"lines":["What time is it?","几点了"]}' });
  const logs = [];
  const originals = new Map(['chrome', 'document', 'createImageBitmap', 'HSR_log', 'TextDetector']
    .map((key) => [key, globalThis[key]]));
  t.after(() => {
    for (const [key, value] of originals) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  globalThis.chrome = { runtime: { getURL: (path) => path } };
  globalThis.HSR_log = (...args) => logs.push(args);
  globalThis.document = {
    createElement() {
      return {
        width: 0, height: 0,
        getContext: () => ({
          drawImage() {},
          getImageData() { throw new Error('Must not preprocess model input'); },
          strokeRect() {},
        }),
        toDataURL: () => 'data:image/png;base64,AA==',
      };
    },
  };
  let closed = 0;
  globalThis.createImageBitmap = async () => ({ width: 1000, height: 100, close() { closed++; } });
  const { OcrEngine } = await import('../extension/offscreen/ocr.js');
  const engine = new OcrEngine({ ready: async () => {}, quality: () => 0.8 });
  const request = {
    tabId: 1, dataUrl: 'data:image/png;base64,AA==', precropped: true, debug: true,
    opts: { ocrEngine: 'native', ocrCenteredOnly: true, minConfidence: 100, ocrDictCorrection: true },
  };
  globalThis.TextDetector = class {
    async detect(source) {
      assert.equal(source, engine.srcCanvas);
      return [{ rawValue: '你好', boundingBox: { x: 450, y: 10, width: 100, height: 30 } }];
    }
  };
  const native = await engine.process({ ...request, opts: { ...request.opts, ocrEngine: 'native' } });
  assert.equal(native.text, '你好');
  assert.equal(native.confidence, null);
  assert.match(native.debug.size, /1 native box/);
  assert.equal(calls.clones.length, 0);
  assert.equal(closed, 1);
});

async function loadOptions(settings = {}) {
  const elements = new Map();
  const logs = [];
  function element(selector) {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, {
        type: 'select-one', value: '', hidden: false, disabled: false, textContent: '',
        handlers: {},
        classList: {
          add: (value) => classes.add(value),
          remove: (value) => classes.delete(value),
          contains: (value) => classes.has(value),
          toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
        },
        addEventListener(event, handler) { this.handlers[event] = handler; },
      });
    }
    return elements.get(selector);
  }
  const fields = ['translator', 'ocrEngine', 'pythonUrl'].map((name) => {
    const field = element(`[name="${name}"]`);
    field.name = name;
    return field;
  });
  const stored = { ...settings };
  const localStored = {};
  const source = await readFile(new URL('../extension/options/options.js', import.meta.url), 'utf8');
  await vm.runInNewContext(source.replace(/^import .*;\r?\n/gm, ''), {
    createPromptOcrSession,
    bridgeUrl: (value) => {
      if (value !== 'http://127.0.0.1:8765') throw new Error('Loopback only');
      return value;
    },
    HSR_DEFAULTS: globalThis.HSR_DEFAULTS,
    HSR_captureErrors() {},
    HSR_log: (...args) => logs.push(args),
    document: {
      querySelector: element,
      querySelectorAll: (selector) => selector === '[name]' ? fields : [],
    },
    chrome: { runtime: { sendMessage: async () => ({ model: 'Local OCR + MT' }) },
      storage: { local: {
        get: async () => localStored, set: async (values) => Object.assign(localStored, values),
      }, sync: {
      get: async (defaults) => typeof defaults === 'string'
        ? { [defaults]: stored[defaults] } : { ...defaults, ...stored },
      set: async (values) => Object.assign(stored, values),
      clear: async () => { for (const key of Object.keys(stored)) delete stored[key]; },
      remove: async (key) => { delete stored[key]; },
    } } },
    setTimeout() {},
    clearTimeout() {},
  });
  return { element, logs, stored, localStored };
}

test('options persist the separate engine, show preparation only for it, and restore Paddle defaults', async () => {
  const html = await readFile(new URL('../extension/options/options.html', import.meta.url), 'utf8');
  assert.match(html, /<option value="prompt">Chrome Prompt API image OCR/);
  assert.match(html, /<script type="module" src="options.js">/);
  assert.match(html, /id="prepareOcrModel"/);
  assert.equal(globalThis.HSR_DEFAULTS.ocrEngine, 'paddle');
  const { element, stored } = await loadOptions({ translator: 'deepl', ocrEngine: 'paddle' });
  assert.equal(element('#promptOcrSettings').hidden, true);
  const select = element('[name="ocrEngine"]');
  select.value = 'prompt';
  await select.handlers.change();
  assert.equal(stored.ocrEngine, 'prompt');
  assert.equal(stored.translator, 'deepl');
  assert.equal(element('#promptOcrSettings').hidden, false);
  await element('#reset').handlers.click();
  assert.equal(select.value, 'paddle');
  assert.equal(element('#promptOcrSettings').hidden, true);
  assert.equal((await loadOptions({ ocrEngine: 'prompt' })).element('#promptOcrSettings').hidden, false);
});

test('OCR preparation works independently of translation and reports progress, readiness and persistent errors', async (t) => {
  const calls = installModel(t, { availability: 'downloadable' });
  const { element, logs } = await loadOptions({ translator: 'deepl', ocrEngine: 'prompt' });
  const button = element('#prepareOcrModel');
  const out = element('#ocrModelResult');
  const create = LanguageModel.create;
  LanguageModel.create = async (options) => {
    assert.equal(button.disabled, true);
    options.monitor({ addEventListener(_event, callback) { callback({ loaded: 0.75 }); } });
    assert.equal(out.textContent, 'Downloading OCR model: 75%');
    return create(options);
  };
  await button.handlers.click();
  assert.equal(calls.destroyed, 1);
  assert.match(out.textContent, /OCR model ready/);
  assert.equal(button.disabled, false);
  assert.equal(out.classList.contains('error'), false);
  assert.equal(element('#deeplResult').textContent, '');

  LanguageModel.availability = async () => 'unavailable';
  await button.handlers.click();
  assert.match(out.textContent, /image input is required/);
  assert.equal(out.classList.contains('error'), true);
  assert.equal(button.disabled, false);
  assert.ok(logs.some((entry) => entry[0] === 'error'));

  LanguageModel.availability = async () => 'available';
  await button.handlers.click();
  assert.match(out.textContent, /OCR model ready/);
  assert.equal(out.classList.contains('error'), false);
});

test('Python bridge settings keep the token out of Chrome Sync and test a local connection', async () => {
  const { element, stored, localStored } = await loadOptions({ translator: 'python', ocrEngine: 'python' });
  element('#pythonToken').value = 'local-test-token';
  await element('#pythonToken').handlers.change();
  assert.equal(localStored.pythonToken, 'local-test-token');
  assert.equal(stored.pythonToken, undefined);
  await element('#testPython').handlers.click();
  assert.equal(element('#pythonResult').textContent, 'Connected: Local OCR + MT');
  assert.equal(element('#pythonResult').classList.contains('error'), false);
  assert.equal(stored.pythonUrl, 'http://127.0.0.1:8765');
  element('[name="pythonUrl"]').value = 'https://remote.example';
  await element('#testPython').handlers.click();
  assert.equal(element('#pythonResult').classList.contains('error'), true);
  assert.equal(stored.pythonUrl, 'http://127.0.0.1:8765');
});

test('Python OCR route sends the original crop and returns text through the existing pipeline', async (t) => {
  const saved = new Map(['chrome', 'document', 'createImageBitmap', 'HSR_log'].map((key) => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of saved) globalThis[key] = value; });
  let request;
  let sent = 0;
  let paddleReading = '我们明天见。';
  const rectangles = [];
  let pixels = new Uint8ClampedArray(1000 * 100 * 4);
  for (let y = 40; y < 70; y++) {
    for (let x = 400; x < 600; x++) {
      if (x % 20 < 4) {
        const index = (y * 1000 + x) * 4;
        pixels[index] = pixels[index + 1] = pixels[index + 2] = 255;
      }
    }
  }
  const originalPixels = pixels.slice();
  globalThis.chrome = { runtime: {
    getURL: (path) => path,
    sendMessage: async (message) => {
      sent++;
      request = message;
      return {
        text: '我们明天见。', raw: '我们明天见。', translation: 'See you tomorrow.',
        confidence: null, boxes: [], size: [1000, 100], wholeBandOcr: true, singlePass: true,
        preCrop: { regions: [{ x: 200, y: 40, width: 600, height: 60 }], size: [600, 60] },
        timings: { total_ms: 60 }, roundTripMs: 65,
      };
    },
  } };
  globalThis.HSR_log = () => {};
  globalThis.document = { createElement: () => ({
    getContext: () => ({
      drawImage() {},
      getImageData() { return { data: pixels, width: 1000, height: 100 }; },
      createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
      putImageData() {},
      strokeRect(...args) { rectangles.push(args); },
    }),
    toDataURL: (type) => `data:${type};base64,original-crop`,
  }) };
  globalThis.createImageBitmap = async () => ({ width: 1000, height: 100, close() {} });
  const { OcrEngine } = await import('../extension/offscreen/ocr.js');
  const engine = new OcrEngine({ ready: async () => {}, quality: () => 1 });
  engine.paddle.recognize = async (source, box) => {
    assert.ok(source === engine.srcCanvas || source === engine.maskCanvas);
    assert.ok(box.x1 > box.x0 && box.y1 > box.y0);
    return { text: paddleReading, confidence: 95, symbols: [] };
  };
  const args = { tabId: 1, dataUrl: 'data:image/png;base64,AA==', precropped: true,
    opts: { ...globalThis.HSR_DEFAULTS, ocrEngine: 'python' }, debug: true };
  const result = await engine.process(args);
  assert.equal(request.type, 'PYTHON_OCR');
  assert.equal(request.image, 'data:image/png;base64,original-crop');
  assert.equal(request.opts.ocrEngine, 'python');
  assert.equal(result.text, '我们明天见。');
  assert.equal(result.pythonTranslationReady, true);
  assert.equal(result.pythonTranslation, 'See you tomorrow.');
  assert.deepEqual(pixels, originalPixels, 'Presence detection must not alter pixels sent to Python');
  assert.equal(request.opts.paddleText, '我们明天见。');
  assert.equal(rectangles.length, 1);
  assert.ok(engine.lineCanvas.width < 1000, 'Only the cropped Chinese region is sent');
  assert.ok(engine.lineCanvas.height < 100, 'Black padding is trimmed');
  assert.match(result.debug.size, /extension Paddle crop \d+x\d+ -> single-pass VLM/);
  assert.match(result.debug.size, /60 ms server/);
  assert.equal(sent, 1);
  // Moving backgrounds, force captures and evolving dialogue must not rerun the same subtitle.
  pixels[0] = 50;
  for (let index = 0; index < 3; index++) {
    const repeated = await engine.process({ ...args, fresh: true,
      opts: { ...args.opts, capturedAt: index, translationContext: { context: [`Earlier ${index}`] } } });
    assert.equal(repeated.unchanged, true);
    assert.equal(repeated.text, result.text);
    assert.equal(repeated.pythonTranslationReady, true);
    assert.equal(repeated.pythonTranslation, 'See you tomorrow.');
    assert.equal(repeated.pythonStages, undefined, 'Reused subtitles must not report stale inference timings');
  }
  assert.equal(sent, 1, 'Four matching local reads must cause exactly one Python call');
  paddleReading = 'Changed embedded English\n我 们 明 天 见';
  assert.equal((await engine.process(args)).unchanged, true, 'English and spacing changes are not new Chinese');
  assert.equal(sent, 1);
  paddleReading = '明天见';
  assert.equal((await engine.process(args)).unchanged, true, 'A fading fragment must not replace the complete subtitle');
  assert.equal(sent, 1);
  paddleReading = '我们明天再见。';
  await engine.process(args);
  assert.equal(sent, 2, 'An additional Chinese character must be forwarded');
  paddleReading = '我们今天再见。';
  await engine.process(args);
  assert.equal(sent, 3, 'Even one substituted character is a different subtitle');
  await engine.process({ ...args, tabId: 2 });
  assert.equal(sent, 4, 'Tabs must not suppress one another');
  engine.resetTab(1);
  await engine.process(args);
  assert.equal(sent, 5, 'Tab reset must invalidate the local decision');
  await engine.process({ ...args, opts: { ...args.opts, translationContext: { story: 'New episode' } } });
  assert.equal(sent, 6, 'A changed episode background must not reuse the previous result');
  let visionCalls = 0;
  engine.prompt.recognizeBilingual = async (source) => {
    assert.equal(source, engine.lineCanvas);
    visionCalls++;
    return { text: '我们明天见。', raw: '我们明天见。', translation: 'See you tomorrow.',
      confidence: null, singlePass: true, timings: { total_ms: 10 } };
  };
  const chromeArgs = { ...args, opts: { ...args.opts, ocrEngine: 'prompt' } };
  engine.paddle.recognize = async (source) => {
    assert.equal(source, engine.maskCanvas, 'Chrome Paddle must receive enhanced pixels');
    return { text: paddleReading, confidence: 95, symbols: [] };
  };
  const chromeResult = await engine.process(chromeArgs);
  assert.equal(chromeResult.bundledTranslationProvider, 'nano');
  assert.equal(chromeResult.pythonTranslation, 'See you tomorrow.');
  const chromeRepeat = await engine.process(chromeArgs);
  assert.equal(chromeRepeat.unchanged, true);
  assert.equal(chromeRepeat.bundledTranslationProvider, 'nano');
  assert.equal(visionCalls, 1);
  assert.equal(sent, 6, 'Chrome vision must not contact Python');
  const { needsVisionFallback } = await import('../extension/offscreen/ocr.js');
  const { hasSubtitleGlyphs } = await import('../extension/offscreen/ocr.js');
  const glyphMask = new Uint8Array(100 * 20);
  const glyphBox = { x0: 0, x1: 100, y0: 0, y1: 20 };
  assert.equal(hasSubtitleGlyphs(glyphMask, 100, glyphBox), false);
  for (let y = 0; y < 20; y++) glyphMask.fill(1, y * 100, y * 100 + 90);
  assert.equal(hasSubtitleGlyphs(glyphMask, 100, glyphBox), false, 'Wide artwork is not a glyph sequence');
  glyphMask.fill(0);
  for (let y = 0; y < 20; y++) {
    for (const x of [10, 35, 60]) glyphMask.fill(1, y * 100 + x, y * 100 + x + 15);
  }
  assert.equal(hasSubtitleGlyphs(glyphMask, 100, glyphBox), true);
  const reliable = { confidence: 95, symbols: [{ confidence: 95 }] };
  const contrastPixels = new Uint8ClampedArray(40 * 4);
  for (let x = 20; x < 40; x++) contrastPixels.fill(255, x * 4, x * 4 + 3);
  const bounds = { x0: 0, x1: 40, y0: 0, y1: 1 };
  assert.equal(needsVisionFallback(reliable, contrastPixels, 40, bounds), false);
  assert.equal(needsVisionFallback({ confidence: 79 }, contrastPixels, 40, bounds), true);
  assert.equal(needsVisionFallback({ confidence: 80 }, contrastPixels, 40, bounds), false);
  assert.equal(needsVisionFallback({ confidence: 95, symbols: [{ confidence: 49 }] },
    contrastPixels, 40, bounds), true);
  assert.equal(needsVisionFallback(reliable, new Uint8ClampedArray(160).fill(240), 40, bounds), true);
  assert.equal(needsVisionFallback(reliable, new Uint8ClampedArray(160).fill(10), 40, bounds), true);
  const hybridArgs = { ...args, opts: { ...args.opts, ocrEngine: 'paddle-vision' } };
  const hybridResult = await engine.process(hybridArgs);
  assert.equal(hybridResult.text, paddleReading);
  assert.equal(hybridResult.pythonTranslationReady, false);
  assert.equal(hybridResult.debug.decision, 'passed');
  assert.match(hybridResult.debug.finalCrop, /^data:image\/png/);
  assert.equal(visionCalls, 1, 'Reliable Paddle text must not invoke Chrome vision');
  let paddleCalls = 0;
  engine.paddle.recognize = async () => {
    paddleCalls++;
    return { text: paddleReading, confidence: 95, symbols: [] };
  };
  for (let index = 0; index < 3; index++) {
    const repeated = await engine.process(hybridArgs);
    assert.equal(repeated.unchanged, true);
    assert.match(repeated.debug.decisionReason, /Paddle and vision skipped/);
    assert.equal(repeated.debug.outputEngine, 'Paddle');
  }
  assert.equal(paddleCalls, 0, 'Three identical subtitle masks must bypass Paddle inference');
  await engine.process(hybridArgs);
  assert.equal(paddleCalls, 1, 'Periodic recognition must revalidate unchanged masks');
  await engine.process({ ...hybridArgs, fresh: true });
  assert.equal(paddleCalls, 2, 'Forced frames must revalidate recognition');
  pixels[0] = 90;
  await engine.process(hybridArgs);
  assert.equal(paddleCalls, 2, 'Background changes outside subtitle rows must not trigger recognition');
  const changedPixel = (50 * 1000 + 420) * 4;
  const savedPixel = pixels.slice(changedPixel, changedPixel + 4);
  pixels[changedPixel] = pixels[changedPixel + 1] = pixels[changedPixel + 2] = 0;
  await engine.process(hybridArgs);
  assert.equal(paddleCalls, 3, 'Even one changed subtitle stroke must trigger recognition');
  pixels.set(savedPixel, changedPixel);
  engine.paddle.recognize = async () => ({
    text: `${paddleReading}，`, confidence: 60, symbols: [],
  });
  const weakerSameText = await engine.process({ ...hybridArgs, fresh: true });
  assert.equal(weakerSameText.unchanged, true);
  assert.equal(weakerSameText.debug.decision, 'passed');
  assert.equal(weakerSameText.debug.outputEngine, 'Paddle');
  assert.equal(visionCalls, 1, 'Punctuation and confidence changes must not invoke vision for accepted text');
  engine.paddle.recognize = async () => ({ text: '我们今天再来。', confidence: 60, symbols: [] });
  await engine.process({ ...hybridArgs, fresh: true });
  assert.equal(visionCalls, 2, 'A substituted Hanzi must still reach vision when unreliable');
  engine.resetTab(1);
  engine.paddle.recognize = async () => ({ text: paddleReading, confidence: 60, symbols: [] });
  const fallbackResult = await engine.process(hybridArgs);
  assert.equal(fallbackResult.pythonTranslationReady, true);
  assert.equal(fallbackResult.debug.decision, 'fallback');
  assert.match(fallbackResult.debug.decisionReason, /Paddle rejected/);
  assert.match(fallbackResult.debug.finalCrop, /^data:image\/png/);
  assert.equal(fallbackResult.pythonTranslation, 'See you tomorrow.');
  assert.equal(visionCalls, 3, 'Low confidence must invoke vision');
  assert.equal((await engine.process(hybridArgs)).unchanged, true);
  assert.equal(visionCalls, 3, 'Unchanged fallback subtitles must be reused');
  engine.paddle.recognize = async (source) => {
    assert.equal(source, engine.srcCanvas, 'Python bridge must retain original pixels');
    return { text: paddleReading, confidence: 95, symbols: [] };
  };
  pixels = originalPixels.slice();
  const binary = await engine.process({ ...args, opts: { ...args.opts, ocrPreprocess: 'binary' } });
  assert.equal(binary.text, '我们明天见。');
  assert.deepEqual(pixels, originalPixels);
  engine.resetTab(1);
  globalThis.chrome.runtime.sendMessage = async () => ({ skipped: true, reason: 'Busy' });
  assert.deepEqual(await engine.process(args), { skipped: true, reason: 'Busy' });
  globalThis.chrome.runtime.sendMessage = async () => ({ error: 'Authentication failed' });
  await assert.rejects(engine.process(args), /Authentication failed/);
  engine.paddle.recognize = async () => { throw new Error('Local Paddle failed'); };
  await assert.rejects(engine.process(args), /Local Paddle failed/);
  engine.paddle.recognize = async () => ({ text: paddleReading, confidence: 95, symbols: [] });
  sent = 0;
  globalThis.chrome.runtime.sendMessage = async () => { sent++; throw new Error('Empty frame must not be sent'); };
  for (const preprocess of ['enhanced', 'binary']) {
    for (const fill of [0, 255]) {
      pixels = new Uint8ClampedArray(1000 * 100 * 4).fill(fill);
      const empty = await engine.process({ ...args, opts: { ...args.opts, ocrPreprocess: preprocess } });
      assert.equal(empty.text, '');
      assert.equal(empty.debug.decision, 'rejected');
      assert.equal(empty.debug.finalCrop, null);
      assert.equal(empty.pythonTranslationReady, false);
      assert.equal(empty.skipped, undefined, 'Empty evidence must reach the subtitle smoother, not preserve stale text');
      assert.match(empty.debug.size, /Python frame not sent/);
    }
  }
  assert.equal(sent, 0);
  pixels = originalPixels.slice();
  globalThis.chrome.runtime.sendMessage = async () => {
    sent++;
    return {
      text: '我们明天见。', raw: '我们明天见。', translation: 'See you tomorrow.',
      confidence: null, boxes: [], timings: { total_ms: 60 }, roundTripMs: 65,
    };
  };
  await engine.process(args);
  assert.equal(sent, 1, 'A subtitle appearing after a blank must be sent again');
  paddleReading = '';
  await engine.process(args);
  await engine.process(args);
  assert.equal(sent, 1, 'No Chinese row must clear evidence without sending a full band to Python');
  paddleReading = '我们明天见。';
  globalThis.chrome.runtime.sendMessage = async () => {
    sent++;
    return { text: '', raw: '', translation: '', confidence: null, boxes: [],
      timings: { total_ms: 60 }, roundTripMs: 65 };
  };
  await engine.process(args);
  await engine.process(args);
  assert.equal(sent, 3, 'Empty Python results must not prevent a later successful read');
});

test('extension Paddle selects and stacks only Chinese source rows before Python transfer', async () => {
  const source = await readFile(new URL('../extension/offscreen/ocr.js', import.meta.url), 'utf8');
  const requests = [];
  let readings = ['English subtitle', '第一行', '第二行'];
  const context = {
    performance, fetch,
    chrome: { runtime: { getURL: (path) => path, sendMessage: async (message) => {
      requests.push(message);
      return { text: '第一行 第二行', raw: '第一行\n第二行', translation: 'Two lines',
        confidence: null, boxes: [], timings: { total_ms: 10 }, roundTripMs: 12 };
    } } },
    document: { createElement: () => {
      const canvas = { width: 0, height: 0, draws: [] };
      canvas.getContext = () => ({
        drawImage: (...args) => canvas.draws.push(args),
        getImageData: () => ({ data: new Uint8ClampedArray(600 * 150 * 4).fill(50) }),
      });
      canvas.toDataURL = () => `data:image/png;base64,${canvas.width}x${canvas.height}`;
      return canvas;
    } },
    createImageBitmap: async () => ({ width: 600, height: 150, close() {} }),
    HSR_log() {},
    PaddleRecognizer: class { async recognize() { return { text: readings.shift() }; } },
    NativeOcr: class {},
    PromptOcr: class {},
    subtitleGeometry: () => ({ ink: 0.02, lines: [
      { x0: 100, y0: 10, x1: 500, y1: 30 },
      { x0: 180, y0: 50, x1: 420, y1: 70 },
      { x0: 200, y0: 100, x1: 400, y1: 120 },
    ] }),
  };
  vm.runInNewContext(source.replace(/^import .*;\r?\n/gm, '')
    .replace(/export function /g, 'function ')
    .replace('export class OcrEngine', 'globalThis.OcrEngine = class OcrEngine')
    .replace('function subtitleGeometry(', 'function unusedSubtitleGeometry('), context);
  const engine = new context.OcrEngine({ ready: async () => {}, quality: () => 1 });
  const args = { tabId: 1, dataUrl: 'data:image/png;base64,AA==', precropped: true,
    opts: { ocrEngine: 'python', capturedAt: 1234 } };
  await engine.process(args);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].image, 'data:image/png;base64,320x80');
  assert.equal(requests[0].opts.paddleText, 'English subtitle\n第一行\n第二行');
  assert.equal(requests[0].opts.capturedAt, 1234);
  assert.equal(engine.lineCanvas.draws.length, 2);
  assert.equal(engine.lineCanvas.draws[0][0], engine.srcCanvas);
  assert.deepEqual(Array.from(engine.lineCanvas.draws[0].slice(1)), [140, 40, 320, 40, 0, 0, 320, 40]);
  assert.deepEqual(Array.from(engine.lineCanvas.draws[1].slice(1)), [140, 90, 320, 40, 0, 40, 320, 40]);
  readings = ['English subtitle', '', 'More English'];
  const empty = await engine.process(args);
  assert.equal(empty.text, '');
  assert.equal(empty.skipped, undefined);
  assert.equal(requests.length, 1, 'English-only and unreadable rows never reach Python');
});

test('Python geometry widens centered rows without adding unrelated uncentered rows or changing other engines', async () => {
  const source = await readFile(new URL('../extension/offscreen/ocr.js', import.meta.url), 'utf8');
  const centered = [{ x0: 260, y0: 50, x1: 340, y1: 80 }];
  const unrestricted = [
    { x0: 5, y0: 5, x1: 80, y1: 25 },
    { x0: 110, y0: 50, x1: 490, y1: 80 },
  ];
  const context = {
    chrome: { runtime: { getURL: (path) => path } },
    removeNoise() {},
    findLines: (_mask, _w, _h, centeredOnly) => centeredOnly ? centered : unrestricted,
  };
  vm.runInNewContext(source.replace(/^import .*;\r?\n/gm, '').replace(/export function /g, 'function ').replace('export class OcrEngine', 'class OcrEngine')
    + '\nglobalThis.geometry = subtitleGeometry;', context);
  const image = { data: new Uint8ClampedArray(600 * 100 * 4) };
  const opts = { ocrPreprocess: 'binary', ocrCenteredOnly: true, textThreshold: 200, subtitleColor: 'white' };
  const standard = context.geometry(image, 600, 100, opts);
  assert.equal(standard.lines[0].x0, 260, 'Existing Paddle/Tesseract detection must be unchanged');
  const python = context.geometry(image, 600, 100, opts, false, true);
  assert.equal(python.lines.length, 1, 'Unrelated uncentered rows must not be added');
  assert.equal(python.lines[0].x0, 110, 'Recover faint/split beginning of centered subtitles');
  assert.equal(python.lines[0].x1, 490, 'Recover the end of centered subtitles');
  assert.equal(python.lines[0].y0, 50);
  assert.equal(python.lines[0].y1, 80);
});
