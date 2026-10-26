const HAN = /\p{Script=Han}/u;
export const isHan = (ch) => HAN.test(ch);

const COST_WORD = 1;
const COST_KNOWN_CHAR = 1.1; // slight penalty so compounds win ties (研究/生命 over 研究生/命)
const COST_UNKNOWN_CHAR = 1.5;

/**
 * Splits text into word tokens: Han runs via min-cost dictionary DP, other runs kept whole.
 * @param {(word: string) => boolean} hasWord
 */
export function segment(text, hasWord, maxLen = 8) {
  const chars = Array.from(text);
  const out = [];
  let i = 0;
  while (i < chars.length) {
    const han = isHan(chars[i]);
    let j = i;
    while (j < chars.length && isHan(chars[j]) === han) j++;
    const run = chars.slice(i, j);
    if (han) out.push(...segmentHan(run, hasWord, maxLen));
    else {
      const s = run.join('').trim();
      if (s) out.push(s);
    }
    i = j;
  }
  return out;
}

function segmentHan(chars, hasWord, maxLen) {
  const n = chars.length;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const prev = new Int32Array(n + 1);
  cost[0] = 0;

  for (let end = 1; end <= n; end++) {
    for (let len = 1; len <= Math.min(maxLen, end); len++) {
      const start = end - len;
      const word = chars.slice(start, end).join('');
      let c;
      if (len === 1) c = hasWord(word) ? COST_KNOWN_CHAR : COST_UNKNOWN_CHAR;
      else if (hasWord(word)) c = COST_WORD;
      else continue;
      if (cost[start] + c < cost[end]) {
        cost[end] = cost[start] + c;
        prev[end] = start;
      }
    }
  }

  const words = [];
  for (let end = n; end > 0; end = prev[end]) words.push(chars.slice(prev[end], end).join(''));
  return words.reverse();
}
