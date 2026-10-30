export default {
  id: 'frame',
  title: 'Captured frame',
  open: false,
  mount(root, { bus, el }) {
    const hint = el('div', 'muted', 'The OCR input appears here while OCR is running. Native subtitle mode reads text directly and skips this.');
    const crop = el('img', 'frame');
    const bin = el('img', 'frame bin');
    const finalTitle = el('div', 'muted', 'Final crop (original pixels)');
    const finalCrop = el('img', 'frame');
    const paddleTitle = el('div', 'muted', 'Paddle cleaned crop (before model resizing)');
    const paddleInput = el('img', 'frame');
    const decision = el('div', 'frame-decision');
    const recognition = el('div', 'raw crop-recognition');
    const meta = el('div', 'muted');
    const raw = el('div', 'raw');
    crop.alt = 'subtitle band';
    bin.alt = 'OCR detection or preprocessing preview';
    finalCrop.alt = 'Final cropped Chinese rows used for recognition';
    paddleInput.alt = 'Enhanced Chinese rows cropped and stacked';
    root.append(hint, crop, bin, paddleTitle, paddleInput, decision, finalTitle, finalCrop, recognition, meta, raw);

    const reset = () => {
      hint.hidden = false;
      crop.hidden = bin.hidden = true;
      finalCrop.hidden = finalTitle.hidden = decision.hidden = true;
      finalCrop.removeAttribute('src');
      paddleInput.hidden = paddleTitle.hidden = true;
      paddleInput.removeAttribute('src');
      decision.textContent = '';
      recognition.textContent = '';
      recognition.hidden = true;
      meta.textContent = raw.textContent = '';
    };
    reset();
    bus.on('tab', reset);

    bus.on('frame', (f) => {
      hint.hidden = true;
      crop.hidden = bin.hidden = false;
      if (f.crop) crop.src = f.crop;
      if (f.bin) bin.src = f.bin;
      paddleInput.hidden = paddleTitle.hidden = !f.paddleInput;
      if (f.paddleInput) paddleInput.src = f.paddleInput;
      else paddleInput.removeAttribute('src');
      finalCrop.hidden = finalTitle.hidden = !f.finalCrop;
      if (f.finalCrop) finalCrop.src = f.finalCrop;
      else finalCrop.removeAttribute('src');
      decision.hidden = !f.decision;
      decision.className = `frame-decision ${f.decision === 'passed' ? 'passed' : 'rejected'}`;
      decision.textContent = f.decision
        ? `${f.decision === 'passed' ? 'PASS' : f.decision === 'fallback' ? 'FALLBACK' : 'REJECTED'}: ${f.decisionReason ?? ''}${f.unchanged ? ' (result reused)' : ''}`
        : '';
      finalCrop.style.borderColor = f.decision === 'passed' ? '#35c66b' : '#f06a6a';
      recognition.hidden = !f.decision;
      recognition.textContent = [
        `Paddle confidence: ${Number.isFinite(f.paddleConfidence) ? `${f.paddleConfidence.toFixed(1)}% (lowest selected row)` : 'unavailable'}`,
        `Paddle output: ${f.paddleText || '(nothing)'}`,
        ...(f.outputEngine ? [
          `${f.outputEngine} Chinese: ${f.outputText || '(nothing)'}`,
          ...(f.outputTranslation ? [`English: ${f.outputTranslation}`] : []),
        ] : []),
      ].join('\n');
      meta.textContent = [
        f.mode === 'direct' ? 'direct video frame' : 'tab screenshot',
        f.size,
        Number.isFinite(f.ink) ? `ink ${(f.ink * 100).toFixed(1)}%` : '',
        f.unchanged ? 'unchanged (OCR skipped)' : `OCR ${f.ms} ms`,
        f.confidence == null ? 'confidence unavailable' : `conf ${Math.round(f.confidence)}`,
      ].filter(Boolean).join(' · ');
      raw.textContent = f.raw ? `Raw OCR: ${f.raw}` : 'Raw OCR: (nothing)';
    });
  },
};
