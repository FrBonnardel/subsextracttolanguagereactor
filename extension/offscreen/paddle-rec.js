// PP-OCRv4 Chinese text-line recognition on the GPU (ONNX Runtime Web, WebGPU EP; WASM fallback).
const ORT_MODULE = '../vendor/ort/ort.webgpu.min.mjs';
const MODEL_URL = chrome.runtime.getURL('vendor/paddle/ch_PP-OCRv4_rec_infer.onnx');
const KEYS_URL = chrome.runtime.getURL('vendor/paddle/ppocr_keys_v1.txt');
const H = 48; // model input height
const W_STEP = 64; // width bucket: fewer distinct shapes = fewer WebGPU shader compilations
const W_MAX = 1920;
const TOP_K = 3;

export class PaddleRecognizer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this._loading = null;
    this.backend = null;
  }

  load() {
    this._loading ??= this._load().catch((e) => {
      this._loading = null;
      throw e;
    });
    return this._loading;
  }

  async _load() {
    const t0 = performance.now();
    const ort = await import(ORT_MODULE);
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/ort/');
    ort.env.wasm.numThreads = 1; // no cross-origin isolation in extension pages
    const [model, keys] = await Promise.all([
      fetch(MODEL_URL).then((r) => {
        if (!r.ok) throw new Error('PaddleOCR model missing – run `npm run setup:paddle`.');
        return r.arrayBuffer();
      }),
      fetch(KEYS_URL).then((r) => r.text()),
    ]);
    // Class 0 = CTC blank, 1..N = dictionary, N+1 = space.
    this.chars = keys.split(/\r?\n/);
    if (this.chars[this.chars.length - 1] === '') this.chars.pop();
    this.chars.push(' ');

    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    const providers = adapter ? ['webgpu', 'wasm'] : ['wasm'];
    this.session = await ort.InferenceSession.create(model, { executionProviders: providers, graphOptimizationLevel: 'all' });
    this.ort = ort;
    this.backend = adapter ? 'webgpu' : 'wasm';
    this.input = this.session.inputNames[0];
    this.output = this.session.outputNames[0];
    HSR_log('info', 'ocr', `PaddleOCR ready on ${this.backend.toUpperCase()} in ${Math.round(performance.now() - t0)} ms${adapter ? '' : ' (no WebGPU adapter – CPU fallback)'}`);
  }

  /**
   * @param {CanvasImageSource} source  original (colour) subtitle band
   * @param {{x0:number,y0:number,x1:number,y1:number}} box  line box in source pixels
   * @returns {Promise<{text: string, confidence: number, symbols: Array<{text: string, confidence: number, choices: Array<{text: string, confidence: number}>}>}>}
   */
  async recognize(source, box) {
    await this.load();
    const bw = box.x1 - box.x0;
    const bh = box.y1 - box.y0;
    const w = Math.min(W_MAX, Math.max(8, Math.round((H * bw) / bh)));
    const paddedW = Math.ceil(w / W_STEP) * W_STEP;

    this.canvas.width = w;
    this.canvas.height = H;
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(source, box.x0, box.y0, bw, bh, 0, 0, w, H);
    const px = this.ctx.getImageData(0, 0, w, H).data;

    // NCHW, BGR (Paddle trains on cv2 images), normalised to [-1, 1]; right padding stays 0.
    const plane = H * paddedW;
    const data = new Float32Array(3 * plane);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const o = y * paddedW + x;
        data[o] = px[i + 2] / 127.5 - 1;
        data[plane + o] = px[i + 1] / 127.5 - 1;
        data[2 * plane + o] = px[i] / 127.5 - 1;
      }
    }

    const tensor = new this.ort.Tensor('float32', data, [1, 3, H, paddedW]);
    const out = await this.session.run({ [this.input]: tensor });
    const probs = out[this.output];
    const result = this._decode(probs.data, probs.dims[1], probs.dims[2]);
    tensor.dispose?.();
    probs.dispose?.();
    return result;
  }

  // Greedy CTC decode, keeping the top-k alternatives of each emitted step for dictionary correction.
  _decode(p, steps, classes) {
    const symbols = [];
    let prev = 0;
    let confSum = 0;
    for (let t = 0; t < steps; t++) {
      const row = t * classes;
      const top = [];
      for (let c = 0; c < classes; c++) {
        const v = p[row + c];
        if (top.length < TOP_K || v > top[top.length - 1].v) {
          top.push({ c, v });
          top.sort((a, b) => b.v - a.v);
          if (top.length > TOP_K) top.pop();
        }
      }
      const best = top[0].c;
      if (best !== 0 && best !== prev) {
        const char = (c) => this.chars[c - 1] ?? '';
        symbols.push({
          text: char(best),
          confidence: top[0].v * 100,
          choices: top.filter((k) => k.c !== 0).map((k) => ({ text: char(k.c), confidence: k.v * 100 })),
        });
        confSum += top[0].v;
      }
      prev = best;
    }
    return {
      text: symbols.map((s) => s.text).join('').trim(),
      confidence: symbols.length ? (confSum / symbols.length) * 100 : 0,
      symbols,
    };
  }
}
