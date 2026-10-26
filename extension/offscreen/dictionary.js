import { numberedToMarked } from './pinyin.js';
import { segment, isHan } from './segmenter.js';

const MAX_WORD_LEN = 8;
const VARIANT_RE = /^(old )?variant of|^see |^used in /i;
const HAN_ONLY = /^\p{Script=Han}$/u;
const OCR_EXTRA_CHARS = '0123456789，。！？、：；“”‘’《》（）…—·「」『』!?.,:;';

export class Dictionary {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.entries = [];
    this.index = new Map(); // word (simp or trad) -> entry indices
    this.hsk = new Map();
    this._ready = null;
  }

  ready() {
    this._ready ??= this._load();
    return this._ready;
  }

  async _load() {
    const res = await fetch(`${this.baseUrl}cedict.json`);
    if (!res.ok) throw new Error('Dictionary missing – run `npm run setup`.');
    const { entries } = await res.json();
    this.entries = entries;
    entries.forEach(([trad, simp], i) => {
      this._add(simp, i);
      if (trad !== simp) this._add(trad, i);
    });

    try {
      const hskRes = await fetch(`${this.baseUrl}hsk.json`);
      if (hskRes.ok) this.hsk = new Map(Object.entries(await hskRes.json()));
    } catch { /* optional */ }
  }

  _add(word, i) {
    const list = this.index.get(word);
    if (list) list.push(i);
    else this.index.set(word, [i]);
  }

  has(word) {
    return this.index.has(word);
  }

  lookup(word) {
    const ids = this.index.get(word) ?? [];
    return ids.map((i) => this._format(this.entries[i])).sort((a, b) => rank(a, word) - rank(b, word));
  }

  _format([trad, simp, py, defs]) {
    return {
      trad,
      simp,
      pinyin: numberedToMarked(py),
      defs: defs.split('/').filter(Boolean),
      hsk: this.hsk.get(simp) ?? null,
    };
  }

  analyze(text) {
    return segment(text, (w) => this.has(w), MAX_WORD_LEN).map((word) => this._token(word));
  }

  /** 0..1: how much of the Hanzi in `text` forms dictionary words (multi-char words 1, known single chars 0.5). */
  quality(text) {
    let han = 0;
    let score = 0;
    for (const w of segment(text, (x) => this.has(x), MAX_WORD_LEN)) {
      const chars = Array.from(w);
      if (!isHan(chars[0])) continue;
      han += chars.length;
      if (chars.length > 1) score += chars.length;
      else if (this.has(w)) score += 0.5;
    }
    return han ? score / han : 0;
  }

  /**
   * Vocabulary to guide Tesseract. Without frequency data, a character's productivity (how many
   * CC-CEDICT words use it) stands in for how common it is.
   * @returns {{chars: string, words: string[]}}
   */
  ocrVocabulary(lang, maxWords = 40000) {
    const key = `${lang}|${maxWords}`;
    if (this._vocab?.key === key) return this._vocab;

    const freq = new Map();
    for (const [trad, simp] of this.entries) {
      for (const w of new Set([trad, simp])) {
        const chars = Array.from(w);
        if (chars.length < 2) continue;
        for (const c of new Set(chars)) freq.set(c, (freq.get(c) ?? 0) + 1);
      }
    }
    const charSet = new Set([...freq].filter(([, n]) => n >= 2).map(([c]) => c));
    for (const w of this.hsk.keys()) for (const c of w) charSet.add(c);

    const useSimp = lang.includes('chi_sim');
    const useTrad = lang.includes('chi_tra');
    const candidates = new Map(); // word -> rank score
    for (const [trad, simp] of this.entries) {
      for (const w of [useSimp && simp, useTrad && trad]) {
        if (!w || candidates.has(w)) continue;
        const chars = Array.from(w);
        if (chars.length < 2 || chars.length > 4 || !chars.every((c) => HAN_ONLY.test(c))) continue;
        const minFreq = Math.min(...chars.map((c) => freq.get(c) ?? 0));
        if (minFreq < 10) continue;
        candidates.set(w, (this.hsk.has(w) ? 1e6 : 0) + minFreq / chars.length);
      }
    }
    const words = [...candidates].sort((a, b) => b[1] - a[1]).slice(0, maxWords).map(([w]) => w);

    this._vocab = { key, chars: [...charSet].join('') + OCR_EXTRA_CHARS, words };
    return this._vocab;
  }

  /** Full lookup for the side panel explorer: the word, words containing it, and a segmentation fallback. */
  explore(word, limit = 40) {
    const token = this._token(word);
    const containing = [];
    const seen = new Set();
    if (token.hanzi) {
      for (const [key, ids] of this.index) {
        if (key === word || !key.includes(word) || seen.has(ids[0])) continue;
        seen.add(ids[0]);
        const [, simp, py, defs] = this.entries[ids[0]];
        containing.push({ word: key, simp, pinyin: py, def: defs.split('/')[0], hsk: this.hsk.get(simp) ?? 99 });
      }
      containing.sort((a, b) => a.hsk - b.hsk || a.word.length - b.word.length);
    }
    return {
      token,
      containing: containing.slice(0, limit).map((c) => ({ ...c, pinyin: numberedToMarked(c.pinyin), hsk: c.hsk === 99 ? null : c.hsk })),
      containingTotal: containing.length,
      segments: !token.entries?.length && Array.from(word).length > 1 ? this.analyze(word) : [],
    };
  }

  _token(text) {
    const chars = Array.from(text);
    if (!isHan(chars[0])) return { text, hanzi: false };

    const entries = this.lookup(text);
    const charInfo = chars.map((c) => ({ char: c, entries: this.lookup(c).slice(0, 3) }));
    return {
      text,
      hanzi: true,
      pinyin: entries[0]?.pinyin ?? charInfo.map((c) => c.entries[0]?.pinyin ?? '?').join(' '),
      hsk: entries.find((e) => e.hsk)?.hsk ?? null,
      entries: entries.slice(0, 6),
      chars: chars.length > 1 ? charInfo : [],
    };
  }
}

// Lower is better: exact script match, common (lowercase) readings, non-variant entries first.
function rank(entry, word) {
  let r = 0;
  if (entry.simp !== word) r += 1;
  if (/^\p{Lu}/u.test(entry.pinyin)) r += 2; // proper nouns / surnames
  if (VARIANT_RE.test(entry.defs[0] ?? '')) r += 4;
  return r;
}
