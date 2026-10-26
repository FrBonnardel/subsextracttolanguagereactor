// Copies Tesseract runtime into extension/vendor and builds extension/data/cedict.json.
import { copyFile, mkdir, readdir, writeFile, readFile, access } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const nm = path.join(root, 'node_modules');
const cacheDir = path.join(root, '.cache');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]),
);
const model = args.model === 'best' ? 'best' : 'fast';
const LANGS = ['chi_sim', 'chi_tra'];
const CEDICT_URL = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz';
const PADDLE_REC_URL = 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx';
const PADDLE_KEYS_URL = 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/ppocr_keys_v1.txt';

const exists = (p) => access(p).then(() => true, () => false);

async function download(url) {
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function cached(name, url) {
  await mkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, name);
  if (await exists(file)) return readFile(file);
  const buf = await download(url);
  await writeFile(file, buf);
  return buf;
}

async function setupOcr() {
  console.log('OCR runtime');
  const tessDist = path.join(nm, 'tesseract.js', 'dist');
  const coreDir = path.join(nm, 'tesseract.js-core');
  if (!(await exists(tessDist)) || !(await exists(coreDir))) {
    throw new Error('tesseract.js not installed – run `npm install` first');
  }

  const vendorTess = path.join(ext, 'vendor', 'tesseract');
  const vendorCore = path.join(ext, 'vendor', 'tesseract-core');
  const vendorData = path.join(ext, 'vendor', 'tessdata');
  await Promise.all([vendorTess, vendorCore, vendorData].map((d) => mkdir(d, { recursive: true })));

  for (const f of ['tesseract.min.js', 'worker.min.js']) {
    await copyFile(path.join(tessDist, f), path.join(vendorTess, f));
  }
  for (const f of await readdir(coreDir)) {
    if (/^tesseract-core.*\.(js|wasm)$/.test(f)) await copyFile(path.join(coreDir, f), path.join(vendorCore, f));
  }
  console.log('  copied tesseract.js + core');

  const repo = model === 'best' ? 'tessdata_best' : 'tessdata_fast';
  for (const lang of LANGS) {
    const raw = await cached(
      `${repo}-${lang}.traineddata`,
      `https://raw.githubusercontent.com/tesseract-ocr/${repo}/main/${lang}.traineddata`,
    );
    await writeFile(path.join(vendorData, `${lang}.traineddata.gz`), gzipSync(raw));
    console.log(`  ${lang} (${repo}) ready`);
  }
}

async function setupTransformers() {
  console.log('Transformers.js (local Opus-MT translation)');
  const dist = path.join(nm, '@huggingface', 'transformers', 'dist');
  if (!(await exists(dist))) throw new Error('@huggingface/transformers not installed – run `npm install` first');
  const dest = path.join(ext, 'vendor', 'transformers');
  await mkdir(dest, { recursive: true });
  // transformers.min.js is the self-contained browser ESM build; ORT loads the jsep wasm pair at runtime.
  for (const f of ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
    await copyFile(path.join(dist, f), path.join(dest, f));
  }
  console.log('  copied transformers.js + onnxruntime wasm');
}

async function setupPaddle() {
  console.log('PaddleOCR (GPU recognition via ONNX Runtime WebGPU)');
  const ortDist = path.join(nm, 'onnxruntime-web', 'dist');
  if (!(await exists(ortDist))) throw new Error('onnxruntime-web not installed – run `npm install` first');
  const ortDest = path.join(ext, 'vendor', 'ort');
  const modelDest = path.join(ext, 'vendor', 'paddle');
  await mkdir(ortDest, { recursive: true });
  await mkdir(modelDest, { recursive: true });
  for (const f of ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
    await copyFile(path.join(ortDist, f), path.join(ortDest, f));
  }
  await writeFile(path.join(modelDest, 'ch_PP-OCRv4_rec_infer.onnx'), await cached('ch_PP-OCRv4_rec_infer.onnx', PADDLE_REC_URL));
  await writeFile(path.join(modelDest, 'ppocr_keys_v1.txt'), await cached('ppocr_keys_v1.txt', PADDLE_KEYS_URL));
  console.log('  copied ONNX Runtime WebGPU + PP-OCRv4 recognition model');
}

async function setupDictionary() {
  console.log('CC-CEDICT');
  const text = gunzipSync(await cached('cedict.txt.gz', CEDICT_URL)).toString('utf8');
  const re = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/;
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const m = re.exec(line);
    if (m) entries.push([m[1], m[2], m[3], m[4]]);
  }
  await mkdir(path.join(ext, 'data'), { recursive: true });
  await writeFile(path.join(ext, 'data', 'cedict.json'), JSON.stringify({ entries }));
  console.log(`  ${entries.length} entries -> extension/data/cedict.json`);
}

try {
  if (!args.only || args.only === 'ocr') await setupOcr();
  if (!args.only || args.only === 'ocr' || args.only === 'paddle') await setupPaddle();
  if (!args.only || args.only === 'mt') await setupTransformers();
  if (!args.only || args.only === 'dict') await setupDictionary();
  console.log('Done. Load extension/ via chrome://extensions → Load unpacked.');
} catch (err) {
  console.error(`Setup failed: ${err.message}`);
  process.exit(1);
}
