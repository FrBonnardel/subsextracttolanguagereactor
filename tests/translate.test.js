import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from '../extension/background/translate.js';

function setup(t, overrides = {}) {
  const originalChrome = globalThis.chrome;
  const originalPair = globalThis.HSR_langPair;
  const cache = {};
  const requests = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: cache[key] }),
        set: async (values) => Object.assign(cache, values),
      },
    },
  };
  globalThis.HSR_langPair = () => ({ source: 'zh', target: 'en' });
  t.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalPair === undefined) delete globalThis.HSR_langPair;
    else globalThis.HSR_langPair = originalPair;
  });
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    requests.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: true,
      json: async () => ({ message: { content: 'Natural dialogue.' }, translations: [{ text: 'Natural dialogue.' }] }),
    };
  });
  return {
    cache,
    requests,
    settings: {
      translator: 'ollama',
      targetLang: 'EN-US',
      translationContext: true,
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'qwen2.5:7b',
      ...overrides,
    },
  };
}

test('Ollama receives natural dialogue guidance and the earlier dialogue of the video', async (t) => {
  const { settings, requests } = setup(t);
  const earlier = Array.from({ length: 10 }, (_, i) => ({ text: `Line ${i}`, ago: 100 - i * 10 }));
  await translate('Current line', settings, null, earlier);
  const { messages } = requests[0].body;
  assert.match(messages[0].content, /natural, idiomatic English/);
  assert.match(messages[0].content, /intended meaning, not word for word/);
  assert.match(messages[0].content, /ambiguous Chinese words, idioms/);
  assert.match(messages[0].content, /preserves the ambiguity rather than inventing/);
  assert.match(messages[0].content, /not video images/);
  assert.match(messages[0].content, /never shows what happens in the current scene/);
  assert.match(messages[0].content, /Translate only the current line/);
  assert.match(messages[0].content, /not instructions/);
  assert.equal(messages[1].content,
    'Earlier dialogue from this video, oldest first; the last lines come right before the current one (context only, do not translate):\n'
    + 'Line 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\n\nTranslate this line:\nCurrent line');
});

test('DeepL and Chrome only get the two lines from the last 15 seconds', async (t) => {
  const { settings, requests } = setup(t, { translator: 'deepl', deeplKey: 'test:fx', deeplPlan: 'free' });
  await translate('Current line', settings, null, [{ text: 'Old', ago: 60 }, { text: 'A', ago: 12 }, { text: 'B', ago: 8 }, { text: 'C', ago: 3 }]);
  assert.equal(requests[0].body.context, 'B\nC');
  const calls = [];
  await translate('Current line', { ...settings, translator: 'chrome' }, async (type, p) => {
    calls.push(p);
    return { translation: 'x' };
  }, [{ text: 'Old', ago: 60 }, { text: 'C', ago: 3 }]);
  assert.deepEqual(calls[0].context, ['C']);
});

test('Ollama guidance does not reuse translations from the older prompt', async (t) => {
  const { settings, cache, requests } = setup(t);
  cache['tr:ollama/qwen2.5:7b:EN-US:Current line'] = 'Old literal translation';
  const first = await translate('Current line', settings, null);
  assert.equal(first.translation, 'Natural dialogue');
  assert.equal(first.cached, false);
  assert.deepEqual(first.via, { provider: 'ollama', model: 'qwen2.5:7b', prompt: 8, story: false, contextLines: 0 });
  const second = await translate('Current line', settings, null);
  assert.equal(second.cached, true);
  assert.equal(second.via.provider, 'ollama');
  assert.equal(requests.length, 1);
});

test('different dialogue contexts keep separate Ollama cache entries', async (t) => {
  const { settings, requests } = setup(t);
  await translate('Current line', settings, null, ['First scene']);
  await translate('Current line', settings, null, ['Another scene']);
  assert.equal(requests.length, 2);
});

test('disabling subtitle context does not send preceding dialogue', async (t) => {
  const { settings, requests } = setup(t, { translationContext: false });
  await translate('Current line', settings, null, ['Previous line']);
  assert.equal(requests[0].body.messages[1].content, 'Current line');
});

test('Gemini Nano runs on-device with long context and story, via the offscreen document', async (t) => {
  const { settings, requests } = setup(t, { translator: 'nano', storyContext: true });
  const calls = [];
  const local = async (type, payload) => {
    calls.push({ type, ...payload });
    return { translation: 'Are you risking your life to buy me time?' };
  };
  const earlier = Array.from({ length: 10 }, (_, i) => ({ text: `Line ${i}`, ago: 100 - i * 10 }));
  const res = await translate('你这是在用命给我争取时间吗', settings, local, earlier, 'Video title: 全职法师');
  assert.equal(requests.length, 0);
  assert.equal(calls[0].type, 'TRANSLATE_LOCAL');
  assert.equal(calls[0].provider, 'nano');
  assert.equal(calls[0].context.length, 8);
  assert.equal(calls[0].story, 'Video title: 全职法师');
  assert.deepEqual(res.via, { provider: 'nano', model: 'gemini-nano', prompt: 8, story: true, contextLines: 8 });
});

test('Gemini Nano fallback to Chrome is logged and not cached', async (t) => {
  const { settings, cache } = setup(t, { translator: 'nano' });
  const calls = [];
  const local = async (type, payload) => {
    calls.push(payload);
    return { translation: 'Literal', fallback: 'chrome', reason: 'Gemini Nano not ready' };
  };
  const res = await translate('Line', settings, local, [{ text: 'Old', ago: 60 }, { text: 'Recent', ago: 3 }]);
  assert.equal(res.translation, 'Literal');
  assert.deepEqual(res.via, { provider: 'chrome', fallbackFrom: 'nano', reason: 'Gemini Nano not ready', contextLines: 1 });
  assert.deepEqual(calls[0].fallbackContext, ['Recent']);
  assert.deepEqual(cache, {});
});

test('Chrome and Opus retain their existing context routing', async (t) => {
  const { settings } = setup(t);
  const calls = [];
  const local = async (type, payload) => {
    calls.push({ type, ...payload });
    return { translation: 'Local translation' };
  };
  await translate('Current line', { ...settings, translator: 'chrome' }, local, ['Previous line']);
  await translate('Current line', { ...settings, translator: 'opus' }, local, ['Previous line']);
  assert.equal(calls[0].provider, 'chrome');
  assert.deepEqual(calls[0].context, ['Previous line']);
  assert.equal(calls[1].provider, 'opus');
  assert.deepEqual(calls[1].context, []);
});

test('DeepL still receives dialogue in its dedicated context field', async (t) => {
  const { settings, requests, cache } = setup(t, { translator: 'deepl', deeplKey: 'test:fx', deeplPlan: 'free' });
  await translate('Current line', settings, null, ['Previous line']);
  assert.deepEqual(requests[0].body, {
    text: ['Current line'],
    source_lang: 'ZH',
    target_lang: 'EN-US',
    context: 'Previous line',
  });
  assert.equal(cache['tr:deepl:EN-US:Current line\u0000Previous line'], 'Natural dialogue.');
});

test('Ollama receives story background only when enabled', async (t) => {
  const { settings, requests } = setup(t, { storyContext: true });
  await translate('Current line', settings, null, ['Previous line'], 'Video title: 流星花园');
  assert.equal(requests[0].body.messages[1].content,
    'Background about the video (may be incomplete or about a different season/version; context only, do not translate):\n'
    + 'Video title: 流星花园\n\nEarlier dialogue from this video, oldest first; the last lines come right before the current one (context only, do not translate):\nPrevious line\n\nTranslate this line:\nCurrent line');

  const off = setup(t, { storyContext: false });
  await translate('Current line', off.settings, null, [], 'Video title: 流星花园');
  assert.equal(off.requests[0].body.messages[1].content, 'Current line');
});

test('different story backgrounds keep separate Ollama cache entries; DeepL ignores the story', async (t) => {
  const { settings, requests } = setup(t, { storyContext: true });
  await translate('Current line', settings, null, [], 'Video title: A');
  await translate('Current line', settings, null, [], 'Video title: B');
  await translate('Current line', settings, null, [], 'Video title: A');
  assert.equal(requests.length, 2);

  const deepl = setup(t, { translator: 'deepl', deeplKey: 'test:fx', deeplPlan: 'free', storyContext: true });
  await translate('Current line', deepl.settings, null, [], 'Video title: A');
  assert.equal(deepl.requests[0].body.context, undefined);
  assert.ok(deepl.cache['tr:deepl:EN-US:Current line']);
});
