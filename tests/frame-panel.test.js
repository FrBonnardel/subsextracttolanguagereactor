import assert from 'node:assert/strict';
import test from 'node:test';
import frame from '../extension/sidepanel/sections/frame.js';

test('frame panel shows exact crop and pass/fallback status, clearing rejected and stale previews', () => {
  const handlers = new Map();
  const children = [];
  frame.mount({ append: (...nodes) => children.push(...nodes) }, {
    bus: { on: (event, handler) => handlers.set(event, handler) },
    el: (tag, className, textContent = '') => ({
      tag, className, textContent, style: {},
      removeAttribute(name) { delete this[name]; },
    }),
  });
  const finalCrop = children.find((node) => node.alt === 'Final cropped Chinese rows used for recognition');
  const decision = children.find((node) => node.className === 'frame-decision');
  const recognition = children.find((node) => node.className === 'raw crop-recognition');
  const paddleInput = children.find((node) => node.alt === 'Enhanced Chinese rows cropped and stacked');
  const show = handlers.get('frame');
  show({ crop: 'original', bin: 'outlines', finalCrop: 'exact pixels',
    decision: 'passed', decisionReason: 'Paddle passed', confidence: 95,
    paddleConfidence: 95, paddleText: '你好', outputEngine: 'Paddle', outputText: '你好',
    paddleInput: 'cleaned pixels' });
  assert.equal(paddleInput.src, 'cleaned pixels');
  assert.equal(paddleInput.hidden, false);
  assert.match(recognition.textContent, /95.0%/);
  assert.match(recognition.textContent, /Paddle output: 你好/);
  assert.equal(finalCrop.src, 'exact pixels');
  assert.equal(finalCrop.hidden, false);
  assert.equal(finalCrop.style.borderColor, '#35c66b');
  assert.match(decision.textContent, /PASS: Paddle passed/);
  show({ finalCrop: 'fallback pixels', decision: 'fallback',
    decisionReason: 'Paddle rejected; vision fallback', unchanged: true,
    paddleConfidence: 60, paddleText: '你妤', outputEngine: 'Chrome vision',
    outputText: '你好', outputTranslation: 'Hello' });
  assert.match(recognition.textContent, /60.0%/);
  assert.match(recognition.textContent, /Chrome vision Chinese: 你好/);
  assert.match(recognition.textContent, /English: Hello/);
  assert.equal(finalCrop.style.borderColor, '#f06a6a');
  assert.match(decision.textContent, /FALLBACK:.*result reused/);
  show({ decision: 'rejected', decisionReason: 'No Chinese row', finalCrop: null });
  assert.equal(finalCrop.hidden, true);
  assert.equal(finalCrop.src, undefined);
  assert.equal(paddleInput.hidden, true);
  assert.equal(paddleInput.src, undefined);
  assert.match(decision.textContent, /REJECTED/);
  show({ crop: 'tesseract', bin: 'mask' });
  assert.equal(decision.hidden, true);
  assert.equal(recognition.hidden, true);
  handlers.get('tab')();
  assert.equal(finalCrop.hidden, true);
  assert.equal(decision.hidden, true);
});
