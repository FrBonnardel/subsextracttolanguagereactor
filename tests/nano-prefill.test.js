import assert from 'node:assert/strict';
import test from 'node:test';

// Session mock that records what each clone processed: appended context and the prompt.
const sessions = [];
globalThis.HSR_log = () => {};
globalThis.LanguageModel = {
  availability: async () => 'available',
  create: async () => {
    const make = () => {
      const s = { appended: [], prompts: [], destroyed: false };
      s.clone = async () => { const c = make(); sessions.push(c); return c; };
      s.append = async (msgs) => { s.appended.push(...msgs.map((m) => m.content)); };
      s.prompt = async (p) => { s.prompts.push(p); return `EN#${s.prompts.length}`; };
      s.destroy = () => { s.destroyed = true; };
      return s;
    };
    return make();
  },
};
const { translateLocal } = await import('../extension/offscreen/translator.js');
const nano = (text, context) => translateLocal({ provider: 'nano', text, from: 'zh', to: 'en', context, contextLimit: 3 });

test('Gemini Nano pre-processes the next line\'s context so only the new line is left to process', async () => {
  const first = await nano('现在是白天', ['高阶法师也未必办得到啊']);
  assert.equal(first.translation, 'EN#1');
  assert.match(sessions[0].appended[0], /高阶法师也未必办得到啊$/);
  assert.equal(sessions[0].prompts[0], 'Translate this line:\n现在是白天');

  // Prepared in the background right after: earlier context + the line just translated.
  await new Promise((r) => setTimeout(r, 0));
  assert.match(sessions[1].appended[0], /高阶法师也未必办得到啊\n现在是白天$/);
  assert.equal(sessions[1].prompts.length, 0);

  // Next line arrives with exactly that context: the prepared session is used, no new clone for it.
  await nano('应该安全了', ['高阶法师也未必办得到啊', '现在是白天']);
  assert.deepEqual(sessions[1].prompts, ['Translate this line:\n应该安全了']);
  assert.equal(sessions[1].destroyed, true);

  // Context limit slides the window (3 lines); a mismatching context discards the prepared session.
  await new Promise((r) => setTimeout(r, 0));
  const prep = sessions[2];
  assert.match(prep.appended[0], /:\n高阶法师也未必办得到啊\n现在是白天\n应该安全了$/);
  await nano('我还好', ['完全不同的上下文']);
  assert.equal(prep.prompts.length, 0);
  assert.equal(prep.destroyed, true);
});