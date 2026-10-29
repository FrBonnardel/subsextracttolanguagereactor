import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { findLines, removeNoise, expandLineBounds, recoverFaintRows } from '../extension/offscreen/ocr-geometry.js';
import { geometryMask } from '../extension/offscreen/preprocess.js';

test('recovers the entirely missing Chinese row in the supplied time-question frame', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/subtitle-missing-row.json', import.meta.url), 'utf8'));
  const { width: w, height: h } = fixture;
  const map = inflateSync(Buffer.from(fixture.map, 'base64'));
  const masks = [geometryMask(map), Uint8Array.from(map, (v) => v > 40 ? 1 : 0), Uint8Array.from(map, (v) => v > 15 ? 1 : 0)];
  for (const mask of masks) removeNoise(mask, w, h);
  const strong = findLines(masks[0], w, h, true);
  assert.equal(strong.length, 1);
  const expanded = expandLineBounds(strong, findLines(masks[1], w, h, true));
  const lines = recoverFaintRows(expanded, findLines(masks[2], w, h, true), w);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].x0 <= 590 && lines[1].x1 >= 690);
  assert.ok(lines[1].y0 <= 63 && lines[1].y1 >= 93);
});

test('faint-row recovery requires an existing nearby subtitle and rejects small background blobs', () => {
  const reference = { x0: 400, x1: 880, y0: 15, y1: 43 };
  const noise = [
    { x0: 630, x1: 690, y0: 100, y1: 118 },
    { x0: 600, x1: 680, y0: 130, y1: 160 },
    { x0: 50, x1: 150, y0: 60, y1: 90 },
  ];
  assert.deepEqual(recoverFaintRows([reference], noise, 1280), [reference]);
  assert.deepEqual(recoverFaintRows([], noise, 1280), []);
});

test('supplied bilingual frame retains the full faint Chinese line instead of only its middle glyphs', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/subtitle-faint-strokes.json', import.meta.url), 'utf8'));
  const { width: w, height: h } = fixture;
  const map = inflateSync(Buffer.from(fixture.map, 'base64'));
  assert.equal(map.length, w * h);
  const strong = geometryMask(map);
  const faint = Uint8Array.from(map, (value) => value > 40 ? 1 : 0);
  removeNoise(strong, w, h);
  removeNoise(faint, w, h);
  const original = findLines(strong, w, h, true);
  assert.equal(original.length, 2);
  assert.ok(original[1].x0 > 600);
  const lines = expandLineBounds(original, findLines(faint, w, h, true));
  assert.equal(lines.length, 2);
  const chinese = lines[1];
  assert.ok(chinese.x0 <= 538 && chinese.x1 >= 743, JSON.stringify(chinese));
  assert.ok(chinese.y0 <= 63 && chinese.y1 >= 92, JSON.stringify(chinese));
  assert.ok(chinese.x1 - chinese.x0 < 300);
  assert.ok(lines[0].y1 < chinese.y0);
  const weak = Uint8Array.from(map, (value) => value > 15 ? 1 : 0);
  removeNoise(weak, w, h);
  assert.equal(recoverFaintRows(lines, findLines(weak, w, h, true), w).length, 2);
});

test('faint bounds cannot introduce new lines or expand a subtitle into a large background region', () => {
  const line = { x0: 100, y0: 30, x1: 200, y1: 50 };
  assert.deepEqual(expandLineBounds([line], [
    { x0: 0, y0: 0, x1: 500, y1: 100 },
    { x0: 100, y0: 70, x1: 200, y1: 90 },
  ]), [line]);
  assert.deepEqual(expandLineBounds([], [line]), []);
});

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
