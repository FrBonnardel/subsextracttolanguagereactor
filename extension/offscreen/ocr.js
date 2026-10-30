/* global Tesseract */
import { correctLine, flattenSymbols } from './ocr-correct.js';
import { toGray, textMap, renderForOcr, geometryMask } from './preprocess.js';
import { PaddleRecognizer } from './paddle-rec.js';
import { NativeOcr } from './native-ocr.js';
import { PromptOcr } from './prompt-ocr.js';
import { removeNoise, findLines, expandLineBounds, recoverFaintRows, refineLineBounds } from './ocr-geometry.js';

const VENDOR = chrome.runtime.getURL('vendor/');
const USER_WORDS_PATH = '/hsr.user-words';
const SIG_W = 192; // fingerprint width: ~3–4 px cells, fine enough to tell different glyphs apart
const SIG_REL_TOLERANCE = 0.08; // fraction of ink cells allowed to differ (compression noise)
const MIN_INK = 0.002;
const MAX_INK = 0.4; // more bright pixels than this is background, not subtitles
const TARGET_GLYPH_PX = 56; // Tesseract's LSTM is most accurate around 40–60 px text height
const LINE_PAD = 20;
const MAX_FRAME_REUSES = 3;

const HAN_OR_PUNCT = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;

function subtitleFingerprint(mask, width, lines) {
  const pixels = new Uint8Array(lines.reduce((sum, line) =>
    sum + (line.x1 - line.x0) * (line.y1 - line.y0), 0));
  let offset = 0;
  for (const line of lines) {
    for (let y = line.y0; y < line.y1; y++) {
      const row = mask.subarray(y * width + line.x0, y * width + line.x1);
      pixels.set(row, offset);
      offset += row.length;
    }
  }
  return { bounds: JSON.stringify(lines), pixels };
}

function identicalSubtitlePixels(a, b) {
  return a?.bounds === b.bounds && a.pixels.length === b.pixels.length
    && a.pixels.every((pixel, index) => pixel === b.pixels[index]);
}

export function needsVisionFallback(reading, pixels, width, box, minConfidence = 50) {
  if (!Number.isFinite(reading.confidence)
      || reading.confidence < Math.max(80, minConfidence)
      || (reading.symbols ?? []).some((symbol) => symbol.confidence < 50)) return true;
  const histogram = new Uint32Array(256);
  let count = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const offset = (y * width + x) * 4;
      const luminance = Math.round(pixels[offset] * 0.299 + pixels[offset + 1] * 0.587
        + pixels[offset + 2] * 0.114);
      histogram[luminance]++;
      count++;
    }
  }
  let low = 0;
  let high = 255;
  let cumulative = 0;
  for (let value = 0; value < 256; value++) {
    cumulative += histogram[value];
    if (cumulative < count * 0.1) low = value;
    if (cumulative >= count * 0.9) { high = value; break; }
  }
  return high - low < 32;
}

export function hasSubtitleGlyphs(mask, width, box) {
  const height = box.y1 - box.y0;
  const runs = [];
  let start = -1;
  for (let x = box.x0; x <= box.x1; x++) {
    let ink = 0;
    if (x < box.x1) {
      for (let y = box.y0; y < box.y1; y++) ink += mask[y * width + x];
    }
    const active = ink >= Math.max(2, height * 0.1);
    if (active && start < 0) start = x;
    if (!active && start >= 0) {
      runs.push(x - start);
      start = -1;
    }
  }
  const glyphs = runs.filter((span) => span >= height * 0.25 && span <= height * 1.4);
  return glyphs.length >= 2 && glyphs.length / runs.length >= 0.6;
}

export class OcrEngine {
  constructor(dict) {
    this.dict = dict;
    this.worker = null;
    this.workerKey = null;
    this.tabs = new Map();
    this.pythonTabs = new Map();
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
    this.native = new NativeOcr();
    this.prompt = new PromptOcr();
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
    this.pythonTabs.delete(tabId);
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

    if (['python', 'prompt', 'paddle-vision'].includes(opts.ocrEngine)) {
      const chromeVision = opts.ocrEngine !== 'python';
      const hybrid = opts.ocrEngine === 'paddle-vision';
      let fallback = false;
      const chineseReadings = [];
      const start = performance.now();
      const sourcePixels = this.ctx.getImageData(0, 0, w, h);
      const paddlePixels = chromeVision
        ? { data: new Uint8ClampedArray(sourcePixels.data), width: w, height: h }
        : sourcePixels;
      const geometry = subtitleGeometry(paddlePixels, w, h, opts, chromeVision, !chromeVision);
      const { ink, mask } = geometry;
      const lines = chromeVision
        ? refineLineBounds(geometry.lines, geometry.textMask, w, opts.ocrCenteredOnly)
        : geometry.lines;
      if (chromeVision) {
        if (opts.ocrPreprocess === 'binary') {
          for (let i = 0; i < mask.length; i++) {
            const value = mask[i] ? 0 : 255;
            paddlePixels.data[i * 4] = paddlePixels.data[i * 4 + 1] = paddlePixels.data[i * 4 + 2] = value;
            paddlePixels.data[i * 4 + 3] = 255;
          }
        }
        this.maskCanvas.width = w;
        this.maskCanvas.height = h;
        const enhanced = this.maskCtx.createImageData(w, h);
        enhanced.data.set(paddlePixels.data);
        this.maskCtx.putImageData(enhanced, 0, 0);
      }
      if (!lines.length || ink < MIN_INK || ink > MAX_INK) {
        this.pythonTabs.delete(tabId);
        const reason = !lines.length || ink < MIN_INK ? 'no subtitle pixels' : 'too bright, treated as background';
        const ms = Math.round(performance.now() - start);
        HSR_log('debug', 'ocr', `Python frame not sent: ${reason} (${lines.length} blocks, ${(ink * 100).toFixed(1)}% ink)`);
        return {
          text: '', raw: '', confidence: null, quality: 0, pythonTranslationReady: false,
          debug: debug ? { crop: cropUrl, bin: cropUrl, raw: '', ms, ink,
            paddleInput: null,
            decision: 'rejected', decisionReason: reason, finalCrop: null,
            size: `${w}x${h}, Python frame not sent: ${reason}` } : undefined,
        };
      }
      const key = JSON.stringify([this._frameKey(opts), w, h, opts.cropTop, opts.cropBottom,
        opts.subtitleColor, opts.textThreshold, opts.minConfidence, opts.translationContext?.story ?? '']);
      const previous = this.pythonTabs.get(tabId);
      const fingerprint = chromeVision ? subtitleFingerprint(geometry.textMask, w, lines) : null;
      const reusePaddle = chromeVision && !fresh && previous?.key === key
        && previous.frameReuses < MAX_FRAME_REUSES
        && identicalSubtitlePixels(previous.fingerprint, fingerprint);
      const frameReadings = [];
      const readings = [];
      const paddleScores = [];
      const selected = [];
      const paddleBoxes = [];
      const rows = lines.map((line, index) => {
        const height = line.y1 - line.y0;
        const margin = Math.max(4, Math.round(height * (chromeVision ? 0.15 : 0.5)));
        const horizontalMargin = Math.round(height * (chromeVision ? 0.25 : 2));
        const row = {
          x0: Math.max(0, line.x0 - horizontalMargin), x1: Math.min(w, line.x1 + horizontalMargin),
          y0: Math.max(0, line.y0 - margin, index ? lines[index - 1].y1 + 3 : 0),
          y1: Math.min(h, line.y1 + margin, index + 1 < lines.length ? lines[index + 1].y0 - 3 : h),
        };
        const blackRow = (y) => {
          let black = 0;
          for (let x = 0; x < w; x++) {
            const offset = (y * w + x) * 4;
            if (Math.max(sourcePixels.data[offset], sourcePixels.data[offset + 1],
              sourcePixels.data[offset + 2]) <= 12) black++;
          }
          return black / w >= 0.99;
        };
        while (row.y0 < line.y0 && blackRow(row.y0)) row.y0++;
        while (row.y1 > line.y1 && blackRow(row.y1 - 1)) row.y1--;
        return row;
      });
      for (const [index, row] of rows.entries()) {
        if (row.y1 <= row.y0) throw new Error('Subtitle rows overlap; cannot safely crop Chinese subtitles.');
        const reading = reusePaddle ? previous.frameReadings[index]
          : await this.paddle.recognize(chromeVision ? this.maskCanvas : this.srcCanvas,
            chromeVision ? lines[index] : row);
        frameReadings.push(reading);
        readings.push(reading.text);
        paddleScores.push(reading.confidence);
        const chinese = /\p{Script=Han}/u.test(reading.text);
        const unreliable = hybrid && needsVisionFallback(reading, sourcePixels.data, w,
          lines[index], opts.minConfidence);
        const emptyTextCandidate = unreliable && !reading.text.trim()
          && hasSubtitleGlyphs(mask, w, lines[index]);
        if (chinese || emptyTextCandidate) {
          selected.push(row);
          paddleBoxes.push(lines[index]);
          chineseReadings.push(reading);
          fallback ||= unreliable;
        }
      }
      const paddleText = cleanText(readings.join('\n'));
      if (!selected.length) {
        this.pythonTabs.delete(tabId);
        HSR_log('debug', 'ocr', 'Python frame not sent: local Paddle found no Chinese rows', readings.join('\n'));
        return { text: '', raw: readings.join('\n'), confidence: null, quality: 0,
          pythonTranslationReady: false,
          debug: debug ? { crop: cropUrl, bin: cropUrl, raw: readings.join('\n'),
            paddleInput: null,
            paddleText: readings.join('\n'),
            paddleConfidence: paddleScores.every(Number.isFinite) ? Math.min(...paddleScores) : null,
            decision: 'rejected', decisionReason: 'Paddle found no Chinese row', finalCrop: null,
            ms: Math.round(performance.now() - start), ink,
            size: `${w}x${h}, Python frame not sent: no Chinese row detected` } : undefined };
      }
      const identity = paddleText.replace(chromeVision ? /[^\p{L}\p{N}]/gu : /[^\p{L}\p{N}!?！？]/gu, '');
      const shorterFragment = identity.length >= 2 && previous?.identity.includes(identity)
        && identity.length < previous.identity.length;
      const reuseResult = identity && previous?.key === key
        && (previous.identity === identity || shorterFragment);
      const left = Math.min(...selected.map((row) => row.x0));
      const right = Math.max(...selected.map((row) => row.x1));
      for (let index = 1; index < selected.length; index++) {
        if (selected[index - 1].y1 > selected[index].y0) {
          const boundary = Math.floor((selected[index - 1].y1 + selected[index].y0) / 2);
          selected[index - 1].y1 = boundary;
          selected[index].y0 = boundary;
        }
      }
      this.lineCanvas.width = right - left;
      this.lineCanvas.height = selected.reduce((sum, row) => sum + row.y1 - row.y0, 0);
      let destinationY = 0;
      for (const row of selected) {
        this.lineCtx.drawImage(this.srcCanvas, left, row.y0, right - left, row.y1 - row.y0,
          0, destinationY, right - left, row.y1 - row.y0);
        destinationY += row.y1 - row.y0;
      }
      let paddleInput = null;
      if (debug && chromeVision) {
        const cleanedCrop = document.createElement('canvas');
        cleanedCrop.width = Math.max(...paddleBoxes.map((box) => box.x1 - box.x0));
        cleanedCrop.height = paddleBoxes.reduce((sum, box) => sum + box.y1 - box.y0, 0);
        const cleanedCtx = cleanedCrop.getContext('2d');
        if (!cleanedCtx) throw new Error('Could not create the cleaned Paddle crop preview.');
        let y = 0;
        for (const box of paddleBoxes) {
          cleanedCtx.drawImage(this.maskCanvas, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0,
            0, y, box.x1 - box.x0, box.y1 - box.y0);
          y += box.y1 - box.y0;
        }
        paddleInput = cleanedCrop.toDataURL('image/png');
      }
      const decision = reuseResult ? previous.decision : fallback ? 'fallback' : 'passed';
      const decisionReason = reuseResult ? previous.decisionReason
        : fallback ? 'Paddle rejected: low confidence or weak contrast; Chrome vision fallback'
        : hybrid ? 'Paddle passed; text translation' : 'Chinese rows selected; vision OCR';
      if (debug) {
        this.ctx.strokeStyle = decision === 'fallback' ? 'rgba(240,70,70,.9)' : 'rgba(0,200,100,.9)';
        for (const row of selected) this.ctx.strokeRect(left, row.y0, right - left, row.y1 - row.y0);
      }
      const frameDebug = debug ? {
        crop: cropUrl, bin: this.canvas.toDataURL('image/png'),
        finalCrop: this.lineCanvas.toDataURL('image/png'), decision, decisionReason,
        paddleInput,
        paddleText: readings.join('\n'),
        paddleConfidence: chineseReadings.every((reading) => Number.isFinite(reading.confidence))
          ? Math.min(...chineseReadings.map((reading) => reading.confidence)) : null,
      } : undefined;
      if (reuseResult) {
        previous.fingerprint = fingerprint;
        previous.frameReadings = frameReadings;
        previous.frameReuses = reusePaddle ? previous.frameReuses + 1 : 0;
        HSR_log('debug', 'ocr', `${reusePaddle ? 'Subtitle pixels unchanged; Paddle skipped' : 'Paddle subtitle unchanged'} "${paddleText}"`);
        return {
          text: previous.text, raw: previous.raw, confidence: previous.confidence, quality: previous.quality,
          pythonTranslationReady: previous.pythonTranslationReady, unchanged: true,
          pythonTranslation: previous.pythonTranslation,
          bundledTranslationProvider: chromeVision ? 'nano' : 'python',
          debug: debug ? { ...frameDebug, raw: previous.raw,
            outputText: previous.text, outputTranslation: previous.pythonTranslation,
            decision: previous.decision,
            decisionReason: `${previous.decisionReason}; ${reusePaddle
              ? 'identical subtitle pixels; Paddle and vision skipped' : 'same subtitle text; result reused'}`,
            outputEngine: previous.outputEngine,
            ms: Math.round(performance.now() - start), ink,
            size: `${w}x${h}, current Paddle crop; prior result reused, no new inference` } : undefined,
        };
      }
      const recognizeChrome = async () => {
        if (hybrid && !fallback) {
          const text = cleanText(chineseReadings.map((reading) => reading.text).join('\n'));
          return { text, raw: text,
            confidence: Math.min(...chineseReadings.map((reading) => reading.confidence)),
            timings: { total_ms: 0 } };
        }
        try {
          if (hybrid) HSR_log('info', 'ocr', 'Paddle unreliable: using Chrome vision fallback', paddleText);
          return await this.prompt.recognizeBilingual(this.lineCanvas, opts.translationContext);
        } catch (error) {
          throw new Error(`${error.message} | Paddle: ${JSON.stringify(readings.join('\n'))}`
            + ` | source band: ${w}x${h} | selected rows: ${selected.length}`, { cause: error });
        }
      };
      const result = chromeVision
        ? await recognizeChrome()
        : await chrome.runtime.sendMessage({
        type: 'PYTHON_OCR', image: this.lineCanvas.toDataURL('image/png'),
        opts: { ...opts, paddleText: readings.join('\n') },
      });
      if (!result || result.error) throw new Error(result?.error || 'Python bridge gave no response.');
      if (result.skipped) return result;
      const { text, raw, confidence, timings, roundTripMs } = result;
      await this.dict.ready();
      const ms = Math.round(performance.now() - start);
      const quality = text ? this.dict.quality(text) : 0;
      const pythonTranslationReady = !!text && typeof result.translation === 'string' && !!result.translation.trim();
      if (identity && text && (pythonTranslationReady || (hybrid && !fallback))) {
        this.pythonTabs.set(tabId, { key, identity, text, raw, confidence, quality, pythonTranslationReady,
          pythonTranslation: result.translation, fingerprint, frameReadings, frameReuses: 0,
          decision, decisionReason, outputEngine: hybrid && !fallback ? 'Paddle' : chromeVision ? 'Chrome vision' : 'Python' });
      } else {
        this.pythonTabs.delete(tabId);
      }
      HSR_log('debug', 'ocr', `${hybrid && !fallback ? 'Paddle text OCR' : chromeVision ? 'Chrome vision OCR+translation' : 'Python OCR+translation'} · ${ms} ms: raw "${raw}" → "${text}"`);
      return {
        text, raw, confidence, quality, pythonTranslationReady,
        ...(pythonTranslationReady && { pythonTranslation: result.translation }),
        pythonStages: timings, pythonRoundTripMs: roundTripMs,
        bundledTranslationProvider: chromeVision ? 'nano' : 'python',
        debug: debug ? { ...frameDebug, raw, ms,
          outputText: text, outputTranslation: result.translation,
          outputEngine: hybrid && !fallback ? 'Paddle' : chromeVision ? 'Chrome vision' : 'Python',
          size: `${w}x${h}, extension Paddle crop ${this.lineCanvas.width}x${this.lineCanvas.height} -> single-pass VLM, ${chromeVision ? `${ms} ms Chrome pipeline` : `${Math.round(timings.total_ms)} ms server / ${roundTripMs} ms round trip`}` } : undefined,
      };
    }

    if (opts.ocrEngine === 'native' || opts.ocrEngine === 'prompt') {
      const start = performance.now();
      const isPrompt = opts.ocrEngine === 'prompt';
      const engine = isPrompt ? this.prompt : this.native;
      const label = isPrompt ? 'Chrome Prompt API image OCR' : 'Chrome TextDetector';
      const { raw, boxes } = await engine.recognize(this.srcCanvas, opts.ocrCenteredOnly);
      await this.dict.ready();
      const text = cleanText(raw);
      const ms = Math.round(performance.now() - start);
      HSR_log('debug', 'ocr', `${label} · ${ms} ms: raw "${raw}" → "${text}" (confidence unavailable)`);
      if (debug) {
        this.ctx.strokeStyle = 'rgba(255,0,0,.8)';
        for (const box of boxes) this.ctx.strokeRect(box.x, box.y, box.width, box.height);
      }
      return {
        text, raw, confidence: null, quality: text ? this.dict.quality(text) : 0,
        debug: debug ? { crop: cropUrl, bin: this.canvas.toDataURL('image/png'), raw, ms, size: `${w}x${h}, ${isPrompt ? 'Prompt API; bounding boxes unavailable' : `${boxes.length} native box(es)`}; confidence unavailable` } : undefined,
      };
    }

    const img = this.ctx.getImageData(0, 0, w, h);
    const enhanced = opts.ocrPreprocess !== 'binary';
    const { mask, lines, ink } = subtitleGeometry(img, w, h, opts, true);

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
          recognize: (line) => this.paddle.recognize(this.maskCanvas, line),
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

function subtitleGeometry(img, w, h, opts, render = false, mergeUncentered = false) {
  let mask;
  let faintMask;
  let recoveryMask;
  if (opts.ocrPreprocess !== 'binary') {
    const strokeRadius = Math.min(10, Math.max(2, Math.round(h / 20)));
    const map = textMap(toGray(img.data, opts.subtitleColor), w, h, strokeRadius, opts.ocrEdgeBoost, opts.subtitleColor);
    mask = geometryMask(map);
    faintMask = Uint8Array.from(map, (value) => value > 40 ? 1 : 0);
    recoveryMask = Uint8Array.from(map, (value) => value > 15 ? 1 : 0);
    if (render) renderForOcr(map, w, h, img.data);
  } else {
    mask = makeMask(img.data, opts.textThreshold, opts.subtitleColor);
  }
  removeNoise(mask, w, h);
  let lines = findLines(mask, w, h, opts.ocrCenteredOnly);
  if (faintMask) {
    removeNoise(faintMask, w, h);
    lines = expandLineBounds(lines, findLines(faintMask, w, h, opts.ocrCenteredOnly));
    removeNoise(recoveryMask, w, h);
    const recovered = recoverFaintRows(lines, findLines(recoveryMask, w, h, true), w);
    for (const line of recovered) {
      if (lines.includes(line)) continue;
      // Include recovered text in change detection, not the weak mask's background noise.
      for (let y = line.y0; y < line.y1; y++) {
        for (let x = line.x0; x < line.x1; x++) {
          mask[y * w + x] |= recoveryMask[y * w + x];
          faintMask[y * w + x] |= recoveryMask[y * w + x];
        }
      }
    }
    lines = recovered;
  }
  if (mergeUncentered && opts.ocrCenteredOnly) {
    let unrestricted = findLines(mask, w, h, false);
    if (faintMask) unrestricted = expandLineBounds(unrestricted, findLines(faintMask, w, h, false));
    lines = lines.map((line) => {
      const candidate = unrestricted.find((box) => Math.min(box.y1, line.y1) > Math.max(box.y0, line.y0));
      return candidate ? { x0: Math.min(line.x0, candidate.x0), y0: Math.min(line.y0, candidate.y0),
        x1: Math.max(line.x1, candidate.x1), y1: Math.max(line.y1, candidate.y1) } : line;
    });
  }
  let inkCount = 0;
  for (let i = 0; i < mask.length; i++) inkCount += mask[i];
  return { mask, textMask: faintMask ?? mask, lines, ink: inkCount / mask.length };
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
