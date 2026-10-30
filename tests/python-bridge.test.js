import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeUrl, pythonHealth, pythonOcr, pythonTranslate } from '../extension/background/python-bridge.js';
import { translate } from '../extension/background/translate.js';

function setup(t, answer = {}) {
  const requests = [];
  const cache = {};
  const original = globalThis.chrome;
  const originalLog = globalThis.HSR_log;
  globalThis.chrome = { storage: { local: {
    get: async (key) => key === 'pythonToken' ? { pythonToken: 'local-only-secret' } : { [key]: cache[key] },
    set: async (values) => Object.assign(cache, values),
  } } };
  globalThis.HSR_log = () => {};
  t.after(() => { globalThis.chrome = original; globalThis.HSR_log = originalLog; });
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    requests.push({ url, opts, body: typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body ?? null });
    return { ok: true, json: async () => ({ contextualTranslation: true, ...answer }) };
  });
  return { requests, settings: { translator: 'python', pythonUrl: 'http://127.0.0.1:8765', targetLang: 'EN-US' } };
}

test('bridge URL cannot send local images or tokens to remote hosts or redirects', () => {
  assert.equal(bridgeUrl('http://127.0.0.1:8765/'), 'http://127.0.0.1:8765');
  assert.equal(bridgeUrl('http://localhost:8765'), 'http://127.0.0.1:8765');
  for (const url of ['https://example.com', 'http://example.com', 'http://127.0.0.1:8765/path',
    'http://user:pass@127.0.0.1', 'http://127.0.0.1?x=y', 'file:///secret']) {
    assert.throws(() => bridgeUrl(url), /loopback/);
  }
});

test('health uses local authentication and checks protocol capabilities', async (t) => {
  const { requests, settings } = setup(t, { ok: true, protocol: 1, target: 'en', model: 'test', binaryOcr: true });
  assert.equal((await pythonHealth(settings)).model, 'test');
  assert.equal(requests[0].opts.headers.Authorization, 'Bearer local-only-secret');
  assert.equal(requests[0].opts.redirect, 'error');
  assert.equal(requests[0].opts.credentials, 'omit');
  assert.equal(requests[0].opts.method, 'GET');
});

test('OCR sends only cropped image and selected geometry settings; returned translation is reused', async (t) => {
  const text = '我们明天见。';
  const { requests, settings } = setup(t, {
    text, raw: text, translation: "See you tomorrow.", confidence: 96, boxes: [],
    timings: { total_ms: 85 },
  });
  const image = 'data:image/png;base64,AAECAw==';
  const result = await pythonOcr(image, { ocrCenteredOnly: false, subtitleColor: 'yellow', minConfidence: 40,
    capturedAt: 1793298335320, paddleText: '我们明天见。\nEnglish' }, settings);
  assert.equal(result.text, text);
  assert.deepEqual(requests[0].body, new Uint8Array([0, 1, 2, 3]));
  assert.equal(requests[0].opts.headers['Content-Type'], 'image/png');
  assert.deepEqual(JSON.parse(Buffer.from(requests[0].opts.headers['X-Hanzi-Paddle'], 'base64').toString('utf8')),
    { paddleText: '我们明天见。\nEnglish' });
  const context = JSON.parse(Buffer.from(requests[0].opts.headers['X-Hanzi-Context'], 'base64').toString('utf8'));
  assert.equal(context.paddleText, undefined, 'Paddle diagnostics must not be translation context');
  assert.deepEqual(JSON.parse(requests[0].opts.headers['X-Hanzi-Options']), {
    centered: false, color: 'yellow', edgeBoost: true, minConfidence: 40, target: 'en',
    capturedAt: 1793298335320,
  });
  const translated = await translate(text, settings, () => { throw new Error('Must not call a Chrome model'); });
  assert.equal(translated.translation, 'See you tomorrow');
  assert.equal(translated.cached, true);
  assert.equal(translated.via.provider, 'python');
  assert.equal(requests.length, 1);
});

test('invalid Paddle diagnostics fail before image transfer', async (t) => {
  const { requests, settings } = setup(t);
  for (const paddleText of [42, {}, '文'.repeat(4001)]) {
    await assert.rejects(pythonOcr('data:image/png;base64,AA==', { paddleText }, settings), /Paddle diagnostic/);
  }
  assert.equal(requests.length, 0);
});

test('Python translator also translates native-track text without OCR', async (t) => {
  const { requests, settings } = setup(t, { translation: 'Native translation.', cached: false });
  const res = await translate('没有OCR的新台词', settings, null);
  assert.equal(res.translation, 'Native translation');
  assert.equal(requests[0].url, 'http://127.0.0.1:8765/translate');
  assert.equal(requests[0].body.text, '没有OCR的新台词');
});

test('Python OCR and native translation share Nano instructions, recent lines and Unicode story context', async (t) => {
  const text = '大家好，我是谢时';
  const story = 'Video title: Example\nVideo description: 谢时 (Xie Shi) is a character.';
  const { requests, settings } = setup(t, {
    text, raw: text, translation: "Hello, I'm Xie Shi.", confidence: 96, boxes: [],
    timings: { total_ms: 85 },
  });
  settings.translationContext = true;
  settings.storyContext = true;
  const previous = Array.from({ length: 10 }, (_, i) => ({ text: `台词${i}`, ago: 100 - i }));
  await pythonOcr('data:image/png;base64,AA==', {
    translationContext: { context: previous, story },
  }, settings);
  const context = JSON.parse(Buffer.from(requests[0].opts.headers['X-Hanzi-Context'], 'base64').toString('utf8'));
  assert.deepEqual(context.context, previous.slice(-8).map((line) => line.text));
  assert.equal(context.story, story);
  assert.match(context.systemPrompt, /romanize Chinese names in pinyin/);
  const result = await translate(text, settings, null, previous, story);
  assert.equal(result.translation, "Hello, I'm Xie Shi");
  assert.equal(result.via.contextLines, 8);
  assert.equal(result.via.story, true);
  assert.equal(requests.length, 1, 'Same OCR context must reuse its translation');
  await translate(text, settings, null, previous, `${story}\nAnother episode.`);
  assert.equal(requests.length, 2, 'Changed background must not reuse a text-only cache hit');
  assert.equal(requests[1].body.context.length, 8);
  assert.match(requests[1].body.story, /Another episode/);
  await translate(text, settings, null, ['Different dialogue'], story);
  assert.equal(requests.length, 3, 'Changed dialogue must not reuse another context');
});

test('Python context settings exclude disabled dialogue and background', async (t) => {
  const { requests, settings } = setup(t, { translation: 'Test' });
  await pythonTranslate('New line', {
    ...settings, translationContext: false, storyContext: false,
  }, ['Previous line'], 'Video title: Not sent');
  assert.deepEqual(requests[0].body.context, []);
  assert.equal(requests[0].body.story, '');
});

test('whole-band VLM OCR accepts unavailable confidence but rejects invented line boxes', async (t) => {
  const { settings } = setup(t, {
    text: '在全球的这个房源量', raw: '在全球的这个房源量', translation: 'the worldwide property count',
    confidence: null, boxes: [], wholeBandOcr: true, timings: { total_ms: 750 },
  });
  const result = await pythonOcr('data:image/png;base64,AA==', {}, settings);
  assert.equal(result.confidence, null);
  assert.deepEqual(result.boxes, []);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({
    ...result, boxes: [{ x: 10, y: 10, width: 10, height: 10 }],
  }) }));
  await assert.rejects(pythonOcr('data:image/png;base64,AA==', {}, settings), /invalid OCR/);
});

test('older servers explicitly require restart for binary support', async (t) => {
  const { settings } = setup(t, { ok: true, protocol: 1, target: 'en' });
  await assert.rejects(pythonHealth(settings), /Restart the updated Python app/);
});

test('older vision servers must be restarted before using extension-side crops', async (t) => {
  const { settings } = setup(t, { ok: true, protocol: 1, target: 'en', binaryOcr: true, wholeBandOcr: true });
  await assert.rejects(pythonHealth(settings), /Paddle cropping now runs in the extension/);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({
    ok: true, protocol: 1, target: 'en', binaryOcr: true, contextualTranslation: true,
    wholeBandOcr: true, clientPreCrop: true, automaticPreCrop: false,
  }) }));
  assert.equal((await pythonHealth(settings)).clientPreCrop, true);
});

test('older servers cannot silently provide context-free OPUS translation', async (t) => {
  const { settings } = setup(t, { ok: true, protocol: 1, target: 'en', binaryOcr: true, contextualTranslation: false });
  await assert.rejects(pythonHealth(settings), /context-aware Qwen/);
});

test('busy OCR skips rather than falling back; authentication, invalid responses and transport failures are explicit', async (t) => {
  const { settings } = setup(t);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 429, json: async () => ({ error: 'Busy' }) }));
  assert.deepEqual(await pythonOcr('data:image/png;base64,AA==', {}, settings), { skipped: true, reason: 'Busy' });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, json: async () => ({ error: 'Invalid token' }) }));
  await assert.rejects(pythonHealth(settings), /Invalid token/);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  await assert.rejects(pythonHealth(settings), /incompatible/);
  await assert.rejects(pythonOcr('data:image/png;base64,AA==', {}, settings), /invalid OCR/);
  await assert.rejects(pythonOcr('invalid-frame', {}, settings), /PNG\/JPEG/);
  await assert.rejects(pythonTranslate('uncached', settings), /invalid translation/);
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(pythonHealth(settings), /Python bridge.*fetch failed/);
  await assert.rejects(pythonTranslate('text', { ...settings, targetLang: 'FR' }), /English only/);
  globalThis.chrome.storage.local.get = async () => ({});
  await assert.rejects(pythonHealth(settings), /token is missing/);
});
