// Dictionary-guided reconstruction of one OCR'd subtitle line from Tesseract's per-symbol choices.
const HAN = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]$/u; // CJK basic (incl. \u4e00-\u9fa5) + ext. A + compat
const DIGIT = /^[0-9０-９]$/u;
const PUNCT = /^[，。！？、：；“”‘’《》〈〉（）…—·「」『』,.!?:;'"()\-~～]$/u;

const MAX_WORD = 4;
const MAX_CANDIDATES = 3;
const MAX_COMBOS = 81;
const WORD_BONUS = 1.5; // log-score per extra char in a dictionary word: lets a word beat a ~4x more confident glyph
const UNKNOWN_CHAR_PENALTY = 2.5;
const DROP_CONFIDENCE = 0.35; // isolated, non-word characters below this are treated as hallucinations

/** Flattens tesseract.js `data.blocks` into its symbol list. */
export function flattenSymbols(blocks) {
  const out = [];
  for (const b of blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        for (const w of l.words ?? []) out.push(...(w.symbols ?? []));
      }
    }
  }
  return out;
}

function kindOf(ch) {
  if (HAN.test(ch)) return 'han';
  if (DIGIT.test(ch)) return 'digit';
  if (PUNCT.test(ch)) return 'punct';
  return 'junk';
}

function candidatesOf(symbol) {
  const seen = new Map();
  const add = (text, conf) => {
    const t = (text ?? '').trim();
    if (!t || Array.from(t).length !== 1 || !HAN.test(t)) return;
    const p = Math.min(1, Math.max(0.01, (conf ?? 0) / 100));
    if (!seen.has(t) || seen.get(t) < p) seen.set(t, p);
  };
  add(symbol.text, symbol.confidence);
  for (const c of symbol.choices ?? []) add(c.text, c.confidence);
  return [...seen].map(([ch, p]) => ({ ch, p })).sort((a, b) => b.p - a.p).slice(0, MAX_CANDIDATES);
}

function* combos(cands, start, end, prefix = '', logp = 0) {
  if (start === end) {
    yield { text: prefix, logp };
    return;
  }
  for (const c of cands[start]) yield* combos(cands, start + 1, end, prefix + c.ch, logp + Math.log(c.p));
}

/** Best dictionary-consistent reading of a run of Han positions (DP over word segmentations × candidate glyphs). */
function solveRun(cands, dict) {
  const n = cands.length;
  const best = new Array(n + 1).fill(null);
  best[0] = { score: 0, words: [] };
  for (let end = 1; end <= n; end++) {
    for (let len = 1; len <= Math.min(MAX_WORD, end); len++) {
      const start = end - len;
      if (!best[start]) continue;
      let count = 1;
      for (let k = start; k < end; k++) count *= cands[k].length;
      if (count > MAX_COMBOS) continue;
      for (const { text, logp } of combos(cands, start, end)) {
        let score;
        if (len === 1) score = logp - (dict.has(text) ? 0 : UNKNOWN_CHAR_PENALTY);
        else if (dict.has(text)) score = logp + WORD_BONUS * (len - 1);
        else continue;
        score += best[start].score;
        if (!best[end] || score > best[end].score) {
          best[end] = { score, words: [...best[start].words, { text, start, len }] };
        }
      }
    }
  }
  return best[n].words;
}

/**
 * @param {Array<{text: string, confidence: number, choices?: Array<{text: string, confidence: number}>}>} symbols
 * @param {{has(word: string): boolean}} dict
 * @returns {{text: string, changes: string[]}}
 */
export function correctLine(symbols, dict) {
  const changes = [];
  const parts = []; // { kind, text } in reading order
  let run = [];

  const flushRun = () => {
    if (!run.length) return;
    const cands = run.map(candidatesOf);
    const words = solveRun(cands, dict);
    for (const w of words) {
      const original = run.slice(w.start, w.start + w.len).map((s) => s.text).join('');
      if (w.len === 1) {
        const conf = cands[w.start].find((c) => c.ch === w.text)?.p ?? 0;
        if (conf < DROP_CONFIDENCE && !dict.has(w.text)) {
          changes.push(`drop ${original}`);
          continue;
        }
      }
      if (w.text !== original) changes.push(`${original}→${w.text}`);
      parts.push({ kind: 'han', text: w.text, single: w.len === 1, p: cands[w.start][0]?.p ?? 0 });
    }
    run = [];
  };

  for (const s of symbols) {
    const ch = (s.text ?? '').trim();
    if (!ch) continue;
    const kind = kindOf(ch);
    if (kind === 'han') {
      run.push(s);
      continue;
    }
    flushRun();
    if (kind === 'junk') changes.push(`drop ${ch}`); // Latin letters / stray symbols inside a Chinese line
    else parts.push({ kind, text: ch });
  }
  flushRun();

  // A lone low-confidence Hanzi between punctuation is almost always noise (e.g. a stroke fragment).
  const text = parts
    .filter((p, i) => {
      if (p.kind !== 'han' || !p.single || p.p >= 0.6) return true;
      const neighbourHan = parts[i - 1]?.kind === 'han' || parts[i + 1]?.kind === 'han';
      if (!neighbourHan) changes.push(`drop isolated ${p.text}`);
      return neighbourHan;
    })
    .map((p) => p.text)
    .join('')
    .replace(/^[，。！？、：；,.!?:;]+/u, '');
  return { text, changes };
}
