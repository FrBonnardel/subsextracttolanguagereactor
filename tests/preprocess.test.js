import assert from 'node:assert/strict';
import test from 'node:test';
import { textMap } from '../extension/offscreen/preprocess.js';

test('outline evidence only mildly boosts strokes and never suppresses unoutlined text', () => {
  const width = 80;
  const height = 40;
  for (const background of [40, 180, 220]) {
    const gray = new Uint8ClampedArray(width * height).fill(background);
    for (let y = 10; y < 30; y++) {
      for (const x of [20, 30, 40, 50]) gray[y * width + x] = 245;
    }
    const plain = textMap(gray, width, height, 3, false);
    const boosted = textMap(gray, width, height, 3, true);
    assert.ok(plain.some((value) => value > 0), 'Unoutlined strokes remain visible');
    for (let i = 0; i < plain.length; i++) {
      assert.ok(boosted[i] >= plain[i]);
      assert.ok(boosted[i] <= Math.min(255, Math.round(plain[i] * 1.1)));
    }
  }
});
