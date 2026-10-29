(() => {
  const HSR = (globalThis.HSR ??= {});
  const SAME_LINE = 0.8;
  const UPGRADE_MARGIN = 0.1;
  const normalize = (text) => text.replace(/[\s\p{P}]/gu, '');

  function isFragment(text, full) {
    if (!full) return false;
    const part = normalize(text);
    const whole = normalize(full);
    return part.length > 0 && part.length < whole.length && whole.includes(part);
  }

  function levenshtein(a, b) {
    const s = Array.from(a);
    const t = Array.from(b);
    let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
    for (let i = 1; i <= s.length; i++) {
      const cur = [i];
      for (let j = 1; j <= t.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[t.length];
  }

  HSR.similarity = (a, b) => {
    if (a === b) return 1;
    const max = Math.max(Array.from(a).length, Array.from(b).length);
    return max ? 1 - levenshtein(a, b) / max : 1;
  };

  /**
   * Turns a noisy stream of per-frame OCR results into discrete subtitle lines.
   * A line is emitted after `stableFrames` similar reads; near-duplicates of the current line are ignored;
   * the line is cleared after `clearAfterEmptyFrames` empty reads.
   */
  HSR.SubtitleSmoother = class SubtitleSmoother {
    constructor({ onLine, onClear }) {
      this.onLine = onLine;
      this.onClear = onClear;
      this.configure({});
      this.reset();
    }

    configure({ stableFrames = 2, clearAfterEmptyFrames = 3 }) {
      this.stableFrames = Math.max(1, stableFrames);
      this.clearAfter = Math.max(1, clearAfterEmptyFrames);
    }

    reset() {
      this.current = null;
      this.currentQuality = 0;
      this.candidate = null; // { text, confidence, count, time, quality }
      this.empty = 0;
    }

    /**
     * @param {number} [time] video time of the frame this read came from
     * @param {number} [quality] 0..1 read quality (dictionary coverage × confidence); best variant wins
     */
    push(text, confidence = 0, time = null, quality = confidence / 100, timing = null) {
      if (!text) {
        this.candidate = null;
        if (this.current && ++this.empty >= this.clearAfter) {
          this.current = null;
          this.onClear();
        }
        return;
      }
      this.empty = 0;
      if (isFragment(text, this.current)) {
        this.candidate = null;
        return;
      }
      if (this.current && HSR.similarity(text, this.current) >= SAME_LINE) {
        // Same line; only a clearly better read of it is worth re-emitting (fixes an early misread).
        if (quality > this.currentQuality + UPGRADE_MARGIN) this._emit(text, time, quality, timing);
        return;
      }

      const c = this.candidate;
      if (c && HSR.similarity(text, c.text) >= SAME_LINE) {
        c.count++;
        if (quality > c.quality && !isFragment(text, c.text)) Object.assign(c, { text, confidence, quality, timing });
      } else {
        this.candidate = { text, confidence, count: 1, time, quality, timing };
      }

      if (this.candidate.count >= this.stableFrames) {
        const { text: line, time: firstSeen, quality: q, timing: captured } = this.candidate;
        this.candidate = null;
        this._emit(line, firstSeen, q, captured);
      }
    }

    _emit(text, time, quality, timing) {
      this.current = text;
      this.currentQuality = quality;
      this.onLine(text, time, quality, timing);
    }

    /** Accept a line shown from another source (replay cache, a kept better read) as current, without emitting it. */
    adopt(text, quality = 1) {
      this.current = text;
      this.currentQuality = quality;
      this.candidate = null;
      this.empty = 0;
    }

    /** Apply a single trusted read immediately (e.g. the frame the user paused on), skipping debounce. */
    force(text, time = null, quality = 0.5, timing = null) {
      this.candidate = null;
      this.empty = 0;
      if (!text) {
        if (this.current) {
          this.current = null;
          this.onClear();
        }
        return;
      }
      if (isFragment(text, this.current)) return;
      if (this.current && HSR.similarity(text, this.current) >= SAME_LINE && quality <= this.currentQuality + UPGRADE_MARGIN) return;
      this._emit(text, time, quality, timing);
    }
  };
})();
