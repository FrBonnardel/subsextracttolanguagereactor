import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { findLines, removeNoise } from '../extension/offscreen/ocr-geometry.js';

function rectangle(mask, w, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
}

test('isolates the supplied subtitle from sparse artwork above it', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/subtitle-artwork-mask.json', import.meta.url), 'utf8'));
  const mask = inflateSync(Buffer.from(fixture.mask, 'base64'));
  assert.equal(mask.length, fixture.width * fixture.height);
  const lines = findLines(mask, fixture.width, fixture.height, true);
  assert.deepEqual(lines.find((line) => line.y1 > 70), { x0: 252, y0: 65, x1: 611, y1: 98 });
  assert.ok(lines.every((line) => line.y1 - line.y0 < 40));
});

test('preserves a clean centered line and its padding', () => {
  const mask = new Uint8Array(200 * 80);
  rectangle(mask, 200, 60, 30, 140, 50);
  assert.deepEqual(findLines(mask, 200, 80, true), [{ x0: 44, y0: 27, x1: 155, y1: 53 }]);
});

test('keeps short subtitles in a wide frame', () => {
  const mask = new Uint8Array(1600 * 100);
  rectangle(mask, 1600, 796, 60, 804, 80);
  assert.equal(findLines(mask, 1600, 100, true).length, 1);
});

test('separates two lines connected by sparse background strokes', () => {
  const mask = new Uint8Array(400 * 100);
  rectangle(mask, 400, 40, 10, 43, 90);
  rectangle(mask, 400, 120, 25, 280, 40);
  rectangle(mask, 400, 120, 60, 280, 75);
  const lines = findLines(mask, 400, 100, true);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].y1 < lines[1].y0);
  assert.ok(lines.every((line) => line.x0 > 43));
});

test('uses a separate density threshold for each disconnected line', () => {
  const mask = new Uint8Array(400 * 100);
  rectangle(mask, 400, 50, 20, 350, 35);
  rectangle(mask, 400, 195, 60, 205, 75);
  assert.equal(findLines(mask, 400, 100, true).length, 2);
});

test('merges small gaps inside glyphs', () => {
  const mask = new Uint8Array(200 * 80);
  rectangle(mask, 200, 70, 25, 130, 33);
  rectangle(mask, 200, 70, 36, 130, 45);
  assert.equal(findLines(mask, 200, 80, true).length, 1);
});

test('honors the centered-only setting', () => {
  const mask = new Uint8Array(400 * 80);
  rectangle(mask, 400, 20, 30, 60, 50);
  assert.deepEqual(findLines(mask, 400, 80, true), []);
  assert.equal(findLines(mask, 400, 80, false).length, 1);
});

test('does not detect subtitles in an empty mask', () => {
  assert.deepEqual(findLines(new Uint8Array(200 * 80), 200, 80, true), []);
});

test('noise removal retains interior strokes and removes edge blobs and specks', () => {
  const mask = new Uint8Array(200 * 80);
  rectangle(mask, 200, 0, 20, 10, 40);
  rectangle(mask, 200, 90, 30, 100, 50);
  mask[10 * 200 + 50] = 1;
  removeNoise(mask, 200, 80);
  assert.equal(mask[20 * 200], 0);
  assert.equal(mask[10 * 200 + 50], 0);
  assert.equal(mask[30 * 200 + 90], 1);
});
