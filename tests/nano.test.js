import assert from 'node:assert/strict';
import test from 'node:test';

const created = [];
const prompts = [];
let answers = [];
globalThis.HSR_log = () => {};
globalThis.Translator = {
  availability: async () => 'available',
  create: async () => ({ translate: async (text) => `chrome:${text}` }),
};
globalThis.LanguageModel = {
  availability: async () => 'available',
  params: async () => ({ maxTemperature: 2, maxTopK: 128 }),
  create: async (opts) => {
    created.push(opts);
    return {
      clone: async () => ({ prompt: async (p) => { prompts.push(p); return answers.shift(); }, destroy() {} }),
      destroy() {},
    };
  },
};
const { translateLocal, warmupNano, keepaliveNano, NANO_KEEPALIVE_IDLE_MS, isChineseQuestion } = await import('../extension/offscreen/translator.js');
const story = 'Video title: 全职法师';
const nano = (text, context = []) => translateLocal({ provider: 'nano', text, from: 'zh', to: 'en', context, story });

test('Gemini Nano keeps the story in a reused base session and prompts only the dialogue per line', async () => {
  answers = ['“Hold on a bit longer.”', "I won't fall here."];
  assert.deepEqual(await warmupNano({ to: 'en', story }), { ok: true });
  const res = await nano('再坚持一会', ['天马上就亮了']);
  await nano('我不会倒在这');

  assert.equal(res.translation, 'Hold on a bit longer.');
  assert.equal(created.length, 1);
  assert.match(created[0].initialPrompts[0].content, /Video title: 全职法师/);
  assert.equal(created[0].temperature, 0.2);
  assert.equal(created[0].topK, 3);
  assert.doesNotMatch(prompts[0], /全职法师/);
  assert.match(prompts[0], /天马上就亮了[\s\S]*Translate this line:\n再坚持一会$/);
  assert.equal(prompts[1], '我不会倒在这');
});

test('Gemini Nano answering in Chinese is retried once, then falls back to Chrome', async () => {
  prompts.length = 0;
  answers = ['魔能基本上可以恢复', 'Magic power can mostly recover.'];
  assert.deepEqual(await nano('魔能基本上可以恢复'), { translation: 'Magic power can mostly recover.', prefilled: false });
  assert.match(prompts[1], /Answer in English only/);

  answers = ['应该在天黑之前能赶到', '天黑之前'];
  const res = await nano('天黑之前应该可以赶到');
  assert.equal(res.translation, 'chrome:天黑之前应该可以赶到');
  assert.equal(res.fallback, 'chrome');
  assert.match(res.reason, /answered in Chinese/);
});
test('keep-alive pings Gemini Nano only after it has been idle, generating a single token', async (t) => {
  const pings = [];
  const realCreate = LanguageModel.create;
  LanguageModel.create = async (opts) => {
    const base = await realCreate(opts);
    return {
      ...base,
      clone: async () => ({
        promptStreaming: (p) => {
          pings.push(p);
          let cancelled = false;
          return { getReader: () => ({ read: async () => ({ value: 'O', done: false }), cancel: async () => { cancelled = true; } }) };
        },
        prompt: async (p) => { prompts.push(p); return answers.shift(); },
        destroy() {},
      }),
    };
  };
  t.after(() => { LanguageModel.create = realCreate; });

  answers = ['Fine.'];
  await translateLocal({ provider: 'nano', text: '我还好', from: 'zh', to: 'es', context: [], story: '' });
  assert.deepEqual(await keepaliveNano({ to: 'es' }), { ok: true, skipped: true }); // just used
  await new Promise((r) => setTimeout(r, NANO_KEEPALIVE_IDLE_MS + 50));
  assert.deepEqual(await keepaliveNano({ to: 'es' }), { ok: true });
  assert.equal(pings.length, 1);
});
test('Gemini Nano turning a statement into a question is asked once more to keep it a statement', async () => {
  prompts.length = 0;
  answers = ['Can I be a good dad?', 'I can be a good dad.'];
  const res = await nano('我能做好一个爸爸');
  assert.equal(res.translation, 'I can be a good dad.');
  assert.match(prompts[1], /translate it as a statement/);

  // Real questions are left alone.
  prompts.length = 0;
  answers = ['Can you do it?'];
  assert.equal((await nano('你能不能做到')).translation, 'Can you do it?');
  answers = ['Are you okay?'];
  assert.equal((await nano('你还好吗')).translation, 'Are you okay?');
  assert.equal(prompts.length, 2);
});

test('Chinese question detection', () => {
  for (const q of ['你还好吗', '你去哪', '为什么', '能不能走', '有没有人', '谁啊', '你呢', '怎么了', '真的？']) assert.ok(isChineseQuestion(q), q);
  for (const s of ['我能做好一个爸爸', '天黑之前应该可以赶到', '我不会倒在这', '现在是白天']) assert.ok(!isChineseQuestion(s), s);
});