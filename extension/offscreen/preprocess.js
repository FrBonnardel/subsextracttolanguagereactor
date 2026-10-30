// Grayscale subtitle enhancement: keeps soft stroke edges instead of cutting the image to pure black/white.

/** Grayscale "subtitle-ness": luma for white/any subtitles, yellowness for yellow ones. */
export function toGray(d, color) {
  const out = new Uint8ClampedArray(d.length / 4);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    out[p] = color === 'yellow' ? Math.min(r, g) - b * 0.6 + 60 : 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return out;
}

// Separable min/max filter with a (2r+1) window.
function rankFilter(src, w, h, r, takeMax) {
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = takeMax ? 0 : 255;
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) {
        const s = src[row + k];
        if (takeMax ? s > v : s < v) v = s;
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = takeMax ? 0 : 255;
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let k = y0; k <= y1; k++) {
        const s = tmp[k * w + x];
        if (takeMax ? s > v : s < v) v = s;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

const erode = (s, w, h, r) => rankFilter(s, w, h, r, false);
const dilate = (s, w, h, r) => rankFilter(s, w, h, r, true);

function percentile(arr, pct) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < arr.length; i++) hist[arr[i]]++;
  const target = arr.length * pct;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

function stretch(arr, lo, hi) {
  const out = new Uint8ClampedArray(arr.length);
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < arr.length; i++) out[i] = ((arr[i] - lo) * 255) / range;
  return out;
}

// Sharpen kernel [0 -k 0; -k 1+4k -k; 0 -k 0]: crisper stroke edges without widening them (unlike blur-based
// unsharp). k < 1 keeps it from ringing on 2–3 px strokes of low-resolution video.
function sharpen3(src, w, h, k = SHARPEN_STRENGTH) {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = src[i];
      const up = y > 0 ? src[i - w] : c;
      const down = y < h - 1 ? src[i + w] : c;
      const left = x > 0 ? src[i - 1] : c;
      const right = x < w - 1 ? src[i + 1] : c;
      out[i] = c + k * (4 * c - up - down - left - right);
    }
  }
  return out;
}

/**
 * Text-likelihood map (0..255, high = subtitle stroke), still in soft grayscale.
 * White top-hat (gray − opening) isolates bright strokes thinner than the window, so white text stays
 * visible on a light background where a global threshold would erase it; wide bright areas (sky, walls) vanish.
 */
export function textMap(gray, w, h, strokeRadius, edgeBoost, color = 'white') {
  const opened = dilate(erode(gray, w, h, strokeRadius), w, h, strokeRadius);
  const tophat = new Uint8ClampedArray(gray.length);
  // Subtitle strokes are near-white: weighting by whiteness stops a light background squeezed between two dark
  // outlines from being mistaken for a stroke.
  for (let i = 0; i < gray.length; i++) {
    const white = color === 'any' ? 1 : Math.min(1, Math.max(0, (gray[i] - WHITE_LO) / (WHITE_HI - WHITE_LO)));
    tophat[i] = (gray[i] - opened[i]) * white;
  }

  // High percentile (99.9) so only stroke cores reach full strength; a lower one saturated the anti-aliased
  // edge pixels too and made strokes look bold.
  const th = stretch(tophat, percentile(tophat, 0.5), Math.max(percentile(tophat, 0.999), 24));
  const gs = stretch(gray, percentile(gray, 0.01), percentile(gray, 0.99));
  const map = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < map.length; i++) map[i] = 0.85 * th[i] + 0.15 * gs[i] * (th[i] / 255);

  if (edgeBoost) {
    // Optional outline evidence adds a small boost; unoutlined strokes are never penalized.
    const closed = erode(dilate(gray, w, h, strokeRadius), w, h, strokeRadius);
    const bt = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) bt[i] = closed[i] - gray[i];
    const outline = dilate(stretch(bt, percentile(bt, 0.5), Math.max(percentile(bt, 0.995), 24)), w, h, Math.max(1, strokeRadius >> 1));
    // Boost only (never damp, never re-normalise): faint outlined strokes gain, full-strength cores are unchanged.
    for (let i = 0; i < map.length; i++) map[i] = map[i] * (1 + 0.1 * (outline[i] / 255));
  }
  return map;
}

const STROKE_GAMMA = 1.8; // > 1 darkens the soft stroke edges in the text map, i.e. thinner strokes after inversion
const SHARPEN_STRENGTH = 0.5;
const WHITE_LO = 190; // grey level ramp: below = not subtitle-white, above WHITE_HI = fully white
const WHITE_HI = 240;

/** Dark-on-light grayscale image for Tesseract: gamma (thin strokes) → 3×3 sharpen → invert (RGBA into `rgba`). */
export function renderForOcr(map, w, h, rgba) {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = 255 * (v / 255) ** STROKE_GAMMA;
  const thin = new Uint8ClampedArray(map.length);
  for (let i = 0; i < map.length; i++) thin[i] = lut[map[i]];
  const sharp = sharpen3(thin, w, h);
  for (let i = 0; i < sharp.length; i++) {
    const v = 255 - sharp[i];
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
}

/** Otsu threshold on the text map; only used for geometry (line boxes, change detection), never for OCR pixels. */
export function geometryMask(map, minThreshold = 90) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < map.length; i++) hist[map[i]]++;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = map.length - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = v; }
  }
  const t = Math.max(threshold, minThreshold);
  const mask = new Uint8Array(map.length);
  for (let i = 0; i < map.length; i++) mask[i] = map[i] > t ? 1 : 0;
  return mask;
}
