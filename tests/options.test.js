import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const html = await readFile(new URL('../extension/options/options.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../extension/options/options.js', import.meta.url), 'utf8');

test('Settings offers supported translators without obsolete provider controls', () => {
  const select = html.match(/<select name="translator">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...select.matchAll(/value="([^"]+)"/g)].map((match) => match[1]),
    ['nano', 'python', 'chrome', 'deepl']);
  assert.doesNotMatch(html, /opus|ollama/i);
});

test('Settings excludes Chrome native OCR while retaining image Prompt API OCR', () => {
  const select = html.match(/<select name="ocrEngine">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...select.matchAll(/value="([^"]+)"/g)].map((match) => match[1]),
    ['prompt', 'paddle-vision', 'python', 'paddle', 'tesseract']);
});

for (const translator of ['opus', 'ollama', 'python']) {
  test(`Settings loads saved ${translator} selection safely`, async () => {
    const nodes = new Map();
    const node = (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, {
        value: '', dataset: {}, classList: { toggle() {} }, addEventListener() {},
      });
      return nodes.get(selector);
    };
    const field = node('[name="translator"]');
    field.name = 'translator';
    const writes = [];
    const logs = [];
    await vm.runInNewContext(source.replace(/^import .*;\r?\n/gm, ''), {
      HSR_DEFAULTS: { translator: 'nano' },
      HSR_captureErrors() {},
      HSR_log: (...args) => logs.push(args),
      setTimeout() {},
      clearTimeout() {},
      document: {
        querySelector: node,
        querySelectorAll: (selector) => selector === '[name]' ? [field] : [],
      },
      chrome: { storage: {
        sync: {
          get: async () => ({ translator }),
          set: async (values) => writes.push(values),
        },
        local: { get: async () => ({}) },
      } },
    });
    const retired = translator !== 'python';
    assert.equal(field.value, retired ? 'nano' : translator);
    assert.equal(writes.length, retired ? 1 : 0);
    if (retired) {
      assert.equal(writes[0].translator, 'nano');
      assert.match(node('#saved').textContent, /Obsolete translator/);
      assert.equal(logs.length, 1);
    }

  });
}

    for (const raw of ['{"chinese":"我们明天见","english":"See you tomorrow."}', 'invalid']) {
      test(`bilingual image test reports ${raw === 'invalid' ? 'invalid JSON' : 'success'}`, async () => {
        const nodes = new Map();
        const handlers = new Map();
        const node = (selector) => {
          if (!nodes.has(selector)) nodes.set(selector, {
            value: '', dataset: {}, classList: { toggle() {}, remove() {}, add() {} },
            addEventListener(event, callback) { handlers.set(`${selector}:${event}`, callback); },
          });
          return nodes.get(selector);
        };
        let recognized = 0;
        const canvas = { getContext: () => ({ fillRect() {}, fillText() {} }) };
        await vm.runInNewContext(source.replace(/^import .*;\r?\n/gm, ''), {
          HSR_DEFAULTS: { translator: 'nano' }, HSR_captureErrors() {}, HSR_log() {},
          setTimeout() {}, clearTimeout() {}, performance: { now: () => 10 },
          testImageToBilingual: async (image) => { assert.equal(image, canvas); recognized++; return raw; },
          parseBilingualImageResponse: JSON.parse,
          document: {
            fonts: { ready: Promise.resolve() }, createElement: () => canvas,
            querySelector: node, querySelectorAll: () => [],
          },
          chrome: { storage: {
            sync: { get: async () => ({ translator: 'nano' }) },
            local: { get: async () => ({}) },
          } },
        });
        await handlers.get('#testImageBilingual:click')();
        assert.equal(recognized, 1);
        assert.equal(node('#testImageBilingual').disabled, false);
        assert.match(node('#imageBilingualResult').textContent,
          raw === 'invalid' ? /Invalid JSON/ : /Chinese transcription matches/);
  });
}
