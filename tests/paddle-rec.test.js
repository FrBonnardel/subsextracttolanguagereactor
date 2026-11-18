import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.chrome ??= { runtime: { getURL: (path) => path } };
globalThis.HSR_log = () => {};
const { PaddleRecognizer } = await import('../extension/offscreen/paddle-rec.js');

test('releasing PaddleOCR frees the ONNX session and allows a later reload', async () => {
  let released = 0;
  const recognizer = Object.create(PaddleRecognizer.prototype);
  recognizer._loading = Promise.resolve();
  recognizer.session = { release: async () => { released++; } };
  recognizer.ort = {};
  recognizer.backend = 'webgpu';
  recognizer.input = 'input';
  recognizer.output = 'output';

  await recognizer.release();

  assert.equal(released, 1);
  assert.equal(recognizer.session, null);
  assert.equal(recognizer._loading, null);
  assert.equal(recognizer.backend, null);
});
