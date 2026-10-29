import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('overlay logs actual subtitle writes and clears, but not rejected translation results', () => {
  const logs = [];
  const context = vm.createContext({
    location: { hostname: 'example.com' },
    document: {
      createTextNode: (text) => text,
      createElement: () => ({ append() {}, dataset: {} }),
      createDocumentFragment: () => ({ append() {} }),
    },
    HSR_log: (...args) => logs.push(args),
  });

  vm.runInContext(readFileSync(new URL('../extension/content/overlay.js', import.meta.url), 'utf8'), context);
  const overlay = Object.create(context.HSR.Overlay.prototype);
  Object.assign(overlay, {
    zh: { replaceChildren() {} },
    tr: { textContent: '', classList: { toggle() {} } },
    closeCard() {}, _updateEmpty() {},
  });
  overlay.showRaw('快点');
  overlay.setTranslation('Old result', false, '走吧');
  assert.equal(logs.length, 1);
  overlay.setTranslation('Hurry up', false, '快点');
  assert.equal(logs.length, 2);
  assert.match(logs[0][2], /Displayed subtitle: "快点"/);
  assert.match(logs[1][2], /Displayed translation: "快点" → "Hurry up"/);
  overlay.clear();
  overlay.clear();
  assert.equal(logs.length, 3);
  assert.equal(logs[2][2], 'Displayed subtitle cleared');
});

test('fast dialogue groups Chinese and translations in a sliding one-second window', () => {
    const context = vm.createContext({
      location: { hostname: 'example.com' }, HSR_log() {},
      document: {
        createTextNode: (text) => text,
        createElement: () => ({ append() {}, dataset: {} }),
        createDocumentFragment: () => ({ append() {} }),
      },
    });
    vm.runInContext(readFileSync(new URL('../extension/content/overlay.js', import.meta.url), 'utf8'), context);
    const overlay = Object.create(context.HSR.Overlay.prototype);
    Object.assign(overlay, {
      zh: { replaceChildren() {} },
      tr: { textContent: '', classList: { toggle() {} } },
      closeCard() {}, _updateEmpty() {},
    });
    overlay.identifySubtitle('快点', { seq: 1, at: 0 });
    overlay.showRaw('快点', 1);
    overlay.setTranslation('Hurry up', false, '快点', 1);
    overlay.identifySubtitle('走吧', { seq: 2, at: 400 });
    overlay.identifySubtitle('好', { seq: 3, at: 800 });
    overlay.rememberTranslation(2, "Let's go");
    overlay.showRaw('好', 3);
    assert.equal(overlay.tokens.map((t) => t.text).join(''), '快点 - 走吧 - 好');
    overlay.setTranslation('Okay', false, '好', 3);
    assert.equal(overlay.tr.textContent, "Hurry up - Let's go - Okay");
    overlay.identifySubtitle('来了', { seq: 4, at: 1100 });
    overlay.showRaw('来了', 4);
    assert.equal(overlay.tokens.map((t) => t.text).join(''), '走吧 - 好 - 来了');
    assert.equal(overlay.hasSubtitle(1), false);
    overlay.setTranslation('Too late', false, '快点', 1);
    assert.equal(overlay.tr.textContent, "Let's go - Okay");
    overlay.identifySubtitle('来了来了', { seq: 5, replaces: 4, at: 1200 });
    overlay.showRaw('来了来了', 5);
    assert.equal(overlay.tokens.map((t) => t.text).join(''), '走吧 - 好 - 来了来了');
    overlay.renderTokens([{ text: '好', hanzi: true, entries: [], pinyin: 'hao' }], 3);
    assert.ok(overlay.tokens.some((t) => t.hanzi && t.text === '好'));
    overlay.identifySubtitle('再见', { seq: 6, at: 2200 });
    overlay.showRaw('再见', 6);
    assert.equal(overlay.tokens.map((t) => t.text).join(''), '再见');
    assert.equal(overlay.tr.textContent, '');
    overlay.clear();
    assert.equal(overlay.hasSubtitle(6), false);
    const displayed = [];
    overlay.onSubtitleDisplay = (item, kind) => {
      item.timing[kind === 'text' ? 'textDisplayedAt' : 'translationDisplayedAt'] = 1;
      displayed.push([item.seq, kind]);
    };
    const timing = { textDisplayedAt: null, translationDisplayedAt: null };
    overlay.identifySubtitle('快点', { seq: 7, at: 3000, timing });
    assert.equal(displayed.length, 0);
    overlay.showRaw('快点', 7);
    overlay.setTranslation('Hurry up', false, '快点', 7);
    assert.deepEqual(displayed, [[7, 'text'], [7, 'translation']]);
    overlay.identifySubtitle('走吧', { seq: 8, at: 4500 });
    overlay.showRaw('走吧', 8);
    overlay.setTranslation('Too late', false, '快点', 7);
    assert.equal(displayed.length, 2);
});
