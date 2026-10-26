const TONES = {
  a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', ü: 'ǖǘǚǜ',
};

// "ni3 hao3" -> "nǐ hǎo"; "lu:4" -> "lǜ"
export function numberedToMarked(pinyin) {
  return pinyin.split(' ').map(markSyllable).join(' ');
}

function markSyllable(syl) {
  const s = syl.replace(/u:/g, 'ü').replace(/U:/g, 'Ü');
  const m = /^([a-zA-ZüÜ]+)([1-5])$/.exec(s);
  if (!m) return s;
  const [, base, toneStr] = m;
  const tone = Number(toneStr);
  if (tone === 5) return base;

  const lower = base.toLowerCase();
  let idx = lower.indexOf('a');
  if (idx < 0) idx = lower.indexOf('e');
  if (idx < 0) idx = lower.indexOf('ou');
  if (idx < 0) {
    for (let k = lower.length - 1; k >= 0; k--) {
      if ('iouü'.includes(lower[k])) { idx = k; break; }
    }
  }
  if (idx < 0) return base; // e.g. "m2", "r5"

  let marked = TONES[lower[idx]][tone - 1];
  if (base[idx] !== lower[idx]) marked = marked.toUpperCase();
  return base.slice(0, idx) + marked + base.slice(idx + 1);
}
