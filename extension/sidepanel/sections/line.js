export default {
  id: 'line',
  title: 'Current line',
  mount(root, { bus, el, tokenChip, explore, request }) {
    const label = el('div', 'muted');
    const text = el('div', 'line-text');
    const translation = el('div', 'translation');
    const backToLive = el('button', null, 'Back to live');
    backToLive.hidden = true;
    root.append(label, text, translation, backToLive);

    let seq = null;
    let live = { text: '', tokens: null, translation: '', error: false, source: '' };

    function render(line, isHistory = false) {
      label.textContent = isHistory ? 'From history' : line.text ? `Live · ${line.source || 'ocr'}` : 'Live · no subtitle on screen';
      backToLive.hidden = !isHistory;
      text.replaceChildren(
        ...(line.tokens ? line.tokens.map((t) => tokenChip(t, onPick)) : [document.createTextNode(line.text)]),
      );
      translation.textContent = line.translation ?? '';
      translation.classList.toggle('error', !!line.error);
    }

    function onPick(word, chip) {
      text.querySelectorAll('.chip.active').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      explore(word);
    }

    let showingHistory = false;
    const update = () => !showingHistory && render(live);

    bus.on('tab', () => {
      seq = null;
      live = { text: '', tokens: null, translation: '' };
      showingHistory = false;
      update();
    });
    bus.on('line', (d) => {
      seq = d.seq;
      live = { text: d.text, tokens: null, translation: '', source: d.source };
      update();
    });
    bus.on('tokens', (d) => { if (d.seq === seq) { live.tokens = d.tokens; update(); } });
    bus.on('translation', (d) => {
      if (d.seq !== seq) return;
      live.translation = d.text;
      live.error = d.error;
      update();
    });
    bus.on('clear', () => {
      seq = null;
      live = { text: '', tokens: null, translation: '' };
      update();
    });
    bus.on('show-line', async (item) => {
      showingHistory = true;
      render(item, true);
      if (item.tokens) return;
      try {
        const { tokens } = await request({ type: 'SEGMENT', text: item.text });
        if (showingHistory) render({ ...item, tokens }, true);
      } catch { /* keep plain text */ }
    });
    backToLive.addEventListener('click', () => {
      showingHistory = false;
      update();
    });

    update();
  },
};
