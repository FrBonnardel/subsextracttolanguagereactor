import assert from 'node:assert/strict';
import test from 'node:test';
import '../extension/content/subtitle-smoother.js';

test('OCR timing metadata follows the chosen candidate through stabilization and paused-frame reads', () => {
  const lines = [];
  const smoother = new HSR.SubtitleSmoother({ onLine: (...args) => lines.push(args), onClear() {} });
  const first = { frame: 1, capturedAt: 100 };
  const better = { frame: 2, capturedAt: 200 };
  smoother.push('业务水平', 80, 30, 0.7, first);
  smoother.push('业务水平', 90, 30.3, 0.9, better);
  assert.equal(lines[0][3], better);
  const paused = { frame: 3, capturedAt: 300 };
  smoother.force('几点了', 32, 0.9, paused);
  assert.equal(lines[1][3], paused);
});
test('shorter OCR fragments cannot replace the recognized line, even with higher quality or a paused read', () => {
  const lines = [];
  const smoother = new HSR.SubtitleSmoother({ onLine: (text) => lines.push(text), onClear() {} });
  smoother.configure({ stableFrames: 1 });
  smoother.push('业务水平特牛', 80, 30, 0.6);
  for (const fragment of ['水平特', '业务水平', '特牛', '业务 水平。']) {
    smoother.push(fragment, 99, 30.3, 0.99);
    smoother.force(fragment, 30.4, 1);
  }
  assert.deepEqual(lines, ['业务水平特牛']);
  assert.equal(smoother.current, '业务水平特牛');
  smoother.push('不能当一般人对待', 80, 32, 0.8);
  assert.equal(lines.at(-1), '不能当一般人对待');
});

test('fragment protection expires when the line clears or resets; longer expansions are still accepted', () => {
  const lines = [];
  const smoother = new HSR.SubtitleSmoother({ onLine: (text) => lines.push(text), onClear() {} });
  smoother.configure({ stableFrames: 1, clearAfterEmptyFrames: 1 });
  smoother.push('快点', 80, 30, 0.8);
  smoother.push('快点快点', 80, 30.3, 0.8);
  assert.equal(lines.at(-1), '快点快点');
  smoother.push('', 0, 31);
  smoother.push('快点', 80, 32, 0.8);
  assert.equal(lines.at(-1), '快点');
  smoother.reset();
  smoother.force('点', 33);
  assert.equal(lines.at(-1), '点');
});
