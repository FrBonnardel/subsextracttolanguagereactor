import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeOcr } from '../extension/offscreen/native-ocr.js';

test('native OCR explicitly reports absent or unsupported implementations', async () => {
  delete globalThis.TextDetector;
  await assert.rejects(new NativeOcr().recognize({ width: 1000 }), /unavailable/);
  globalThis.TextDetector = class {
    async detect() { throw new Error('Not supported'); }
  };
  await assert.rejects(new NativeOcr().recognize({ width: 1000 }), /native OCR failed: Not supported/);
  delete globalThis.TextDetector;
});

test('native OCR reads original image, filters off-centre boxes and orders rows', async () => {
  const source = { width: 1000 };
  globalThis.TextDetector = class {
    async detect(image) {
      assert.equal(image, source);
      return [
        { rawValue: '几点了', boundingBox: { x: 450, y: 60, width: 100, height: 30 } },
        { rawValue: 'Comment', boundingBox: { x: 10, y: 10, width: 100, height: 30 } },
        { rawValue: 'What time is it?', boundingBox: { x: 400, y: 10, width: 200, height: 30 } },
      ];
    }
  };
  const ocr = new NativeOcr();
  assert.equal((await ocr.recognize(source)).raw, 'What time is it?\n几点了');
  assert.equal((await ocr.recognize(source, false)).boxes.length, 3);
  delete globalThis.TextDetector;
});
