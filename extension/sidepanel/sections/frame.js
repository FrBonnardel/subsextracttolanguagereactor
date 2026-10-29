export default {
  id: 'frame',
  title: 'Captured frame',
  open: false,
  mount(root, { bus, el }) {
    const hint = el('div', 'muted', 'The OCR input appears here while OCR is running. Native subtitle mode reads text directly and skips this.');
    const crop = el('img', 'frame');
    const bin = el('img', 'frame bin');
    const meta = el('div', 'muted');
    const raw = el('div', 'raw');
    crop.alt = 'subtitle band';
    bin.alt = 'binarized OCR input';
    root.append(hint, crop, bin, meta, raw);

    const reset = () => {
      hint.hidden = false;
      crop.hidden = bin.hidden = true;
      meta.textContent = raw.textContent = '';
    };
    reset();
    bus.on('tab', reset);

    bus.on('frame', (f) => {
      hint.hidden = true;
      crop.hidden = bin.hidden = false;
      if (f.crop) crop.src = f.crop;
      if (f.bin) bin.src = f.bin;
      meta.textContent = [
        f.mode === 'direct' ? 'direct video frame' : 'tab screenshot',
        f.size,
        `ink ${(f.ink * 100).toFixed(1)}%`,
        f.unchanged ? 'unchanged (OCR skipped)' : `OCR ${f.ms} ms`,
        `conf ${Math.round(f.confidence)}`,
      ].join(' · ');
      raw.textContent = f.raw ? `Raw OCR: ${f.raw}` : 'Raw OCR: (nothing)';
    });
  },
};
