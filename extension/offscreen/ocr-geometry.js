const CENTER_TOLERANCE = 0.15;

/** A faint second row may be absent from the strong mask in bilingual subtitles. */
export function recoverFaintRows(lines, faintLines, width) {
  const recovered = faintLines.filter((candidate) => {
    const height = candidate.y1 - candidate.y0;
    const span = candidate.x1 - candidate.x0;
    if (Math.abs((candidate.x0 + candidate.x1) / 2 - width / 2) > width * 0.1
      || span < height * 2 || span > width * 0.8) return false;
    if (lines.some((line) => candidate.y0 < line.y1 && candidate.y1 > line.y0)) return false;
    return lines.some((line) => {
      const referenceHeight = line.y1 - line.y0;
      const gap = candidate.y0 - line.y1;
      return gap >= 0 && gap <= referenceHeight * 2
        && height >= referenceHeight * 0.85 && height <= referenceHeight * 1.6;
    });
  });
  return [...lines, ...recovered].sort((a, b) => a.y0 - b.y0);
}

/** Recover faint neighbouring strokes without accepting new lines from a weaker mask. */
export function expandLineBounds(lines, faintLines) {
  return lines.map((line) => {
    const height = line.y1 - line.y0;
    const candidate = faintLines.find((faint) => {
      const overlapY = Math.min(line.y1, faint.y1) - Math.max(line.y0, faint.y0);
      return overlapY >= height * 0.6
        && faint.x0 <= line.x0 && faint.x1 >= line.x1
        && faint.y1 - faint.y0 <= height * 1.6
        && faint.x1 - faint.x0 <= line.x1 - line.x0 + height * 8;
    });
    return candidate ? {
      x0: Math.min(line.x0, candidate.x0), y0: Math.min(line.y0, candidate.y0),
      x1: Math.max(line.x1, candidate.x1), y1: Math.max(line.y1, candidate.y1),
    } : line;
  });
}

// Drops connected components that can't be subtitle strokes: specks, blobs touching the band edge, oversized shapes.
export function removeNoise(mask, w, h) {
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
export function findLines(mask, w, h, centeredOnly = false) {
  const rows = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0, p = y * w; x < w; x++, p++) rows[y] += mask[p];
  }
  const runs = [];
  let start = -1;
  for (let y = 0; y <= h; y++) {
    const on = y < h && rows[y] >= 2;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      // Sparse artwork can bridge the entire band. Find text-dense rows relative to
      // this run's peak, not the image width, so short subtitles still qualify.
      let peak = 0;
      for (let row = start; row < y; row++) peak = Math.max(peak, rows[row]);
      const threshold = Math.max(2, Math.ceil(peak * 0.3));
      let denseStart = -1;
      for (let row = start; row <= y; row++) {
        const dense = row < y && rows[row] >= threshold;
        if (dense && denseStart < 0) denseStart = row;
        if (!dense && denseStart >= 0) {
          const prev = runs[runs.length - 1];
          if (prev && denseStart - prev.y1 <= 3) prev.y1 = row;
          else runs.push({ y0: denseStart, y1: row });
          denseStart = -1;
        }
      }
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
