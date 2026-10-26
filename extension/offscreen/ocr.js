/* global Tesseract */
import { correctLine, flattenSymbols } from './ocr-correct.js';
import { toGray, textMap, renderForOcr, geometryMask } from './preprocess.js';
import { PaddleRecognizer } from './paddle-rec.js';

const VENDOR = chrome.runtime.getURL('vendor/');
const USER_WORDS_PATH = '/hsr.user-words';
const SIG_W = 192; // fingerprint width: ~3–4 px cells, fine enough to tell different glyphs apart
const SIG_REL_TOLERANCE = 0.08; // fraction of ink cells allowed to differ (compression noise)
const MIN_INK = 0.002;
const MAX_INK = 0.4; // more bright pixels than this is background, not subtitles
const TARGET_GLYPH_PX = 56; // Tesseract's LSTM is most accurate around 40–60 px text height
const LINE_PAD = 20;
const CENTER_TOLERANCE = 0.15; // a subtitle block's centre must be within this fraction of the band width from the middle

const HAN_OR_PUNCT = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;

export class OcrEngine {
  constructor(dict) {
    this.dict = dict;
    this.worker = null;
    this.workerKey = null;
    this.tabs = new Map();
    this.queue = Promise.resolve();
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.maskCanvas = document.createElement('canvas');
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
    this.lineCanvas = document.createElement('canvas');
    this.lineCtx = this.lineCanvas.getContext('2d', { willReadFrequently: true });
    this.srcCanvas = document.createElement('canvas'); // untouched colour band, input for PaddleOCR
    this.srcCtx = this.srcCanvas.getContext('2d');
    this.paddle = new PaddleRecognizer();
    this.paddleRetryAt = 0;
  }

  process(msg) {
    // Serialize: one Tesseract worker, and the shared canvas is reused per frame.
    const job = this.queue.then(() => this._process(msg));
    this.queue = job.catch(() => {});
    return job;
  }

  resetTab(tabId) {
    this.tabs.delete(tabId);
  }

  async _ensureWorker(opts) {
    const lang = opts.ocrLang;
    const key = `${lang}|${!!opts.ocrUserWords}|${!!opts.ocrCharWhitelist}`;
    if (this.worker && this.workerKey === key) return this.worker;
    if (this.worker) await this.worker.terminate();
    this.worker = null;
    HSR_log('info', 'ocr', `Starting Tesseract worker (${lang}, user-words ${!!opts.ocrUserWords}, whitelist ${!!opts.ocrCharWhitelist})`);
    const t0 = performance.now();
    const worker = await Tesseract.createWorker(lang, 1, {
      workerPath: `${VENDOR}tesseract/worker.min.js`,
      corePath: `${VENDOR}tesseract-core/`,
      langPath: `${VENDOR}tessdata/`,
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
    });

    let vocab = null;
    if (opts.ocrUserWords || opts.ocrCharWhitelist) {
      await this.dict.ready();
      vocab = this.dict.ocrVocabulary(lang);
    }
    if (opts.ocrUserWords) {
      // user_words_file is an init-only parameter: write the list into the worker FS, then re-init with it.
      try {
        await worker.writeText(USER_WORDS_PATH, vocab.words.join('\n'));
        await worker.reinitialize(lang, 1, { user_words_file: USER_WORDS_PATH });
        HSR_log('info', 'ocr', `Loaded ${vocab.words.length} user words`);
      } catch (e) {
        HSR_log('warn', 'ocr', 'User-words could not be loaded, continuing without:', e);
      }
    }
    await worker.setParameters({
      tessedit_pageseg_mode: '7', // --psm 7: single text line; lines are split beforehand
      preserve_interword_spaces: '0',
      user_defined_dpi: '300',
      lstm_choice_mode: '2', // expose alternative glyphs per symbol for dictionary correction
      tessedit_char_whitelist: opts.ocrCharWhitelist ? vocab.chars : '',
    });
    this.worker = worker;
    this.workerKey = key;
    HSR_log('info', 'ocr', `Tesseract ready in ${Math.round(performance.now() - t0)} ms${vocab ? ` (whitelist ${Array.from(vocab.chars).length} chars)` : ''}`);
    return worker;
  }

  async _process({ tabId, dataUrl, rect, dpr, opts, precropped, debug, fresh }) {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const crop = precropped
      ? { x: 0, y: 0, w: bitmap.width, h: bitmap.height }
      : cropBox(rect, dpr, opts, bitmap.width, bitmap.height);
    if (!crop) {
      bitmap.close();
      return { text: '', confidence: 0, skipped: true, reason: `crop band outside screenshot (${bitmap.width}x${bitmap.height})` };
    }

    const w = Math.round(crop.w);
    const h = Math.round(crop.h);
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
    bitmap.close();
    this.srcCanvas.width = w;
    this.srcCanvas.height = h;
    this.srcCtx.drawImage(this.canvas, 0, 0);
    const cropUrl = debug ? this.canvas.toDataURL('image/jpeg', 0.8) : null;

    const img = this.ctx.getImageData(0, 0, w, h);
    const enhanced = opts.ocrPreprocess !== 'binary';
    let mask;
    if (enhanced) {
      const strokeRadius = Math.min(10, Math.max(2, Math.round(h / 20)));
      const map = textMap(toGray(img.data, opts.subtitleColor), w, h, strokeRadius, opts.ocrEdgeBoost, opts.subtitleColor);
      mask = geometryMask(map);
      renderForOcr(map, w, h, img.data);
    } else {
      mask = makeMask(img.data, opts.textThreshold, opts.subtitleColor);
    }
    removeNoise(mask, w, h);
    let inkCount = 0;
    for (let i = 0; i < mask.length; i++) inkCount += mask[i];
    const ink = inkCount / mask.length;
    const lines = findLines(mask, w, h, opts.ocrCenteredOnly);

    // OCR source image: soft grayscale (enhanced) or the legacy black-on-white mask.
    if (!enhanced) {
      for (let i = 0; i < mask.length; i++) {
        const v = mask[i] ? 0 : 255;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
    }
    this.maskCanvas.width = w;
    this.maskCanvas.height = h;
    this.maskCtx.putImageData(img, 0, 0);

    const dbg = (raw, ms) => {
      if (!debug) return undefined;
      this.ctx.drawImage(this.maskCanvas, 0, 0);
      this.ctx.strokeStyle = 'rgba(255,0,0,.8)';
      for (const l of lines) this.ctx.strokeRect(l.x0 + 0.5, l.y0 + 0.5, l.x1 - l.x0, l.y1 - l.y0);
      return { crop: cropUrl, bin: this.canvas.toDataURL('image/png'), ink, raw, ms, size: `${w}x${h}, ${lines.length} line(s)` };
    };

    const sig = signature(mask, w, h);
    const prev = this.tabs.get(tabId);
    if (!fresh && prev && prev.key === this._frameKey(opts) && sameFrame(sig, prev.sig)) {
      return { text: prev.text, confidence: prev.confidence, quality: prev.quality, unchanged: true, debug: dbg(prev.raw, 0) };
    }

    let text = '';
    let raw = '';
    let ms = 0;
    let confidence = 0;
    const inkPct = `${(ink * 100).toFixed(1)}%`;
    if (ink >= MIN_INK && ink <= MAX_INK && lines.length) {
      const engine = await this._pickEngine(opts);
      await this.dict.ready();
      const t0 = performance.now();
      const raws = [];
      const texts = [];
      const fixes = [];
      let confSum = 0;
      let confWeight = 0;
      for (const line of lines) {
        const { text: lineRaw, confidence: lineConf, symbols } = await engine.recognize(line);
        raws.push(lineRaw);
        const weight = Math.max(1, lineRaw.length);
        confSum += lineConf * weight;
        confWeight += weight;
        if (lineConf < opts.minConfidence) continue;
        let lineText = lineRaw;
        if (opts.ocrDictCorrection && symbols.length) {
          const corrected = correctLine(symbols, this.dict);
          lineText = corrected.text;
          fixes.push(...corrected.changes);
        }
        texts.push(cleanText(lineText));
      }
      ms = Math.round(performance.now() - t0);
      raw = raws.join('\n');
      confidence = confWeight ? confSum / confWeight : 0;
      text = texts.filter(Boolean).join(' ');
      HSR_log('debug', 'ocr', `${engine.name} · crop ${w}x${h}, ${lines.length} line(s), ink ${inkPct}, ${ms} ms, conf ${Math.round(confidence)}: raw "${raw}" → "${text}"${fixes.length ? ` [${fixes.join(', ')}]` : ''}`);
    } else {
      HSR_log('debug', 'ocr', `crop ${w}x${h}, ink ${inkPct} – ${
        ink < MIN_INK || !lines.length ? 'no subtitle pixels' : 'too bright, treated as background'}`);
    }
    // Read quality: dictionary coverage weighted by recognizer confidence; lets the page pick the best of several reads.
    const quality = text ? this.dict.quality(text) * (confidence / 100) : 0;
    this.tabs.set(tabId, { sig, text, raw, confidence, quality, key: this._frameKey(opts) });
    return { text, confidence, quality, debug: dbg(raw, ms) };
  }

  _frameKey(opts) {
    return `${opts.ocrEngine}|${opts.ocrLang}|${!!opts.ocrUserWords}|${!!opts.ocrCharWhitelist}|${!!opts.ocrDictCorrection}|${opts.ocrPreprocess}|${!!opts.ocrEdgeBoost}|${!!opts.ocrCenteredOnly}`;
  }

  /** Line recognizer: PaddleOCR on the GPU by default, Tesseract (CPU) if chosen or if Paddle can't load. */
  async _pickEngine(opts) {
    if (opts.ocrEngine !== 'tesseract' && Date.now() >= this.paddleRetryAt) {
      try {
        await this.paddle.load();
        return {
          name: `paddle/${this.paddle.backend}`,
          recognize: (line) => this.paddle.recognize(this.srcCanvas, line),
        };
      } catch (e) {
        this.paddleRetryAt = Date.now() + 60_000;
        HSR_log('warn', 'ocr', 'PaddleOCR unavailable, falling back to Tesseract for 60 s:', e);
      }
    }
    const worker = await this._ensureWorker(opts);
    return {
      name: 'tesseract',
      recognize: async (line) => {
        const { data } = await worker.recognize(this._lineImage(line), {}, { text: true, blocks: true });
        return { text: data.text.trim(), confidence: data.confidence, symbols: opts.ocrDictCorrection ? flattenSymbols(data.blocks) : [] };
      },
    };
  }

  /** One text line from the cleaned mask, upscaled to a comfortable glyph size with white padding. */
  _lineImage({ x0, y0, x1, y1 }) {
    const lw = x1 - x0;
    const lh = y1 - y0;
    const scale = Math.min(4, Math.max(1, TARGET_GLYPH_PX / lh));
    const cw = Math.round(lw * scale) + LINE_PAD * 2;
    const ch = Math.round(lh * scale) + LINE_PAD * 2;
    this.lineCanvas.width = cw;
    this.lineCanvas.height = ch;
    this.lineCtx.fillStyle = '#fff';
    this.lineCtx.fillRect(0, 0, cw, ch);
    this.lineCtx.imageSmoothingEnabled = true;
    this.lineCtx.imageSmoothingQuality = 'high';
    this.lineCtx.drawImage(this.maskCanvas, x0, y0, lw, lh, LINE_PAD, LINE_PAD, cw - LINE_PAD * 2, ch - LINE_PAD * 2);
    return this.lineCanvas;
  }
}

function cropBox(rect, dpr, opts, imgW, imgH) {
  const x0 = Math.max(0, rect.left * dpr);
  const y0 = Math.max(0, (rect.top + rect.height * opts.cropTop) * dpr);
  const x1 = Math.min(imgW, (rect.left + rect.width) * dpr);
  const y1 = Math.min(imgH, (rect.top + rect.height * opts.cropBottom) * dpr);
  if (x1 - x0 < 40 || y1 - y0 < 16) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// 1 = subtitle pixel.
function makeMask(d, threshold, color) {
  const mask = new Uint8Array(d.length / 4);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (color === 'yellow') {
      mask[p] = r > threshold && g > threshold - 30 && b < r - 60 ? 1 : 0;
    } else {
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      mask[p] = luma > threshold && (color === 'any' || Math.max(r, g, b) - Math.min(r, g, b) < 60) ? 1 : 0;
    }
  }
  return mask;
}

// Drops connected components that can't be subtitle strokes: specks, blobs touching the band edge, oversized shapes.
function removeNoise(mask, w, h) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const comp = new Int32Array(mask.length);
  const maxH = h * 0.6;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    let n = 0;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp) {
      const p = stack[--sp];
      comp[n++] = p;
      const x = p % w;
      const y = (p - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    const bh = maxY - minY + 1;
    const touchesEdge = minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1;
    if (n < 6 || touchesEdge || bh > maxH) {
      for (let i = 0; i < n; i++) mask[comp[i]] = 0;
    }
  }
}

// Horizontal projection -> text line boxes (tight, in band coordinates).
// centeredOnly: per row, keep only the text block around the band centre (subtitles are centred;
// danmaku/comments/credits to the sides are dropped).
function findLines(mask, w, h, centeredOnly = false) {
  const rows = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0, p = y * w; x < w; x++, p++) s += mask[p];
    rows[y] = s;
  }
  const runs = [];
  let start = -1;
  for (let y = 0; y <= h; y++) {
    const on = y < h && rows[y] >= 2;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      const prev = runs[runs.length - 1];
      if (prev && start - prev.y1 <= 3) prev.y1 = y; // tiny gap inside a line
      else runs.push({ y0: start, y1: y });
      start = -1;
    }
  }
  const tallest = Math.max(0, ...runs.map((r) => r.y1 - r.y0));
  const lines = [];
  for (const r of runs) {
    const lh = r.y1 - r.y0;
    if (lh < 6 || lh < tallest * 0.45) continue;

    const cols = new Uint8Array(w);
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = 0, p = y * w; x < w; x++, p++) if (mask[p]) cols[x] = 1;
    }
    // Ink columns -> blocks; gaps wider than ~1.5 glyphs separate unrelated texts on the same row.
    const maxGap = Math.round(lh * 1.5);
    const blocks = [];
    for (let x = 0; x < w; x++) {
      if (!cols[x]) continue;
      const last = blocks[blocks.length - 1];
      if (last && x - last.x1 <= maxGap) last.x1 = x;
      else blocks.push({ x0: x, x1: x });
    }
    if (!blocks.length) continue;

    let x0, x1, left = 0, right = w;
    if (centeredOnly) {
      const mid = w / 2;
      const dist = (b) => (b.x0 <= mid && mid <= b.x1 ? 0 : Math.min(Math.abs(b.x0 - mid), Math.abs(b.x1 - mid)));
      const i = blocks.reduce((best, b, k) => (dist(b) < dist(blocks[best]) ? k : best), 0);
      const b = blocks[i];
      if (Math.abs((b.x0 + b.x1) / 2 - mid) > w * CENTER_TOLERANCE) continue;
      ({ x0, x1 } = b);
      // Padding must not reach into a neighbouring block.
      if (blocks[i - 1]) left = Math.round((blocks[i - 1].x1 + x0) / 2);
      if (blocks[i + 1]) right = Math.round((x1 + blocks[i + 1].x0) / 2);
    } else {
      x0 = blocks[0].x0;
      x1 = blocks[blocks.length - 1].x1;
    }
    const padY = Math.round(lh * 0.15);
    // Generous horizontal margin: a faint glyph at the line end may be missing from the geometry mask.
    const padX = Math.round(lh * 0.8);
    lines.push({
      x0: Math.max(left, x0 - padX),
      y0: Math.max(0, r.y0 - padY),
      x1: Math.min(right, x1 + padX),
      y1: Math.min(h, r.y1 + padY),
    });
  }
  return lines;
}

function signature(mask, w, h) {
  const gw = Math.min(SIG_W, w);
  const gh = Math.max(4, Math.round((h * gw) / w));
  const bits = new Uint8Array(gw * gh);
  const cw = w / gw;
  const ch = h / gh;
  let ink = 0;
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor(gy * ch), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * ch));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor(gx * cw), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cw));
      let on = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          n++;
          on += mask[y * w + x];
        }
      }
      if (n && on / n > 0.2) {
        bits[gy * gw + gx] = 1;
        ink++;
      }
    }
  }
  return { bits, gw, gh, ink };
}

function sameFrame(a, b) {
  if (a.gw !== b.gw || a.gh !== b.gh) return false;
  let diff = 0;
  for (let i = 0; i < a.bits.length; i++) if (a.bits[i] !== b.bits[i]) diff++;
  return diff <= Math.max(2, Math.max(a.ink, b.ink) * SIG_REL_TOLERANCE);
}

function cleanText(raw) {
  const lines = raw
    .split(/\n+/)
    .map((line) =>
      line
        .replace(/[^\p{Script=Han}\u3000-\u303f\uff00-\uffef\p{L}\p{N}\s!?.,…—"'“”‘’]/gu, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => {
      const chars = Array.from(line.replace(/\s/g, ''));
      const han = chars.filter((c) => HAN_OR_PUNCT.test(c)).length;
      return han > 0 && han / chars.length >= 0.6;
    })
    // Tesseract inserts spaces between CJK glyphs.
    .map((line) => line.replace(/(?<=[\p{Script=Han}\u3000-\u303f\uff00-\uffef])\s+(?=[\p{Script=Han}\u3000-\u303f\uff00-\uffef])/gu, ''));
  return lines.join(' ');
}
