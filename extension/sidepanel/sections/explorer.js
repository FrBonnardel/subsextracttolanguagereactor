export default {
  id: 'explorer',
  title: 'Hanzi explorer',
  mount(root, { bus, el, request, tokenChip, explore }) {
    const input = el('input');
    input.type = 'search';
    input.placeholder = 'Look up a word or character…';
    const back = el('button', null, '←');
    const forward = el('button', null, '→');
    back.title = 'Back';
    forward.title = 'Forward';
    const result = el('div', null);
    const bar = el('div', 'row');
    bar.append(back, forward, input);
    root.append(bar, result);
    result.append(el('div', 'muted', 'Click a word in the current line, the video overlay, or search here.'));

    const stack = [];
    let pos = -1;
    let reqId = 0;

    function navButtons() {
      back.disabled = pos <= 0;
      forward.disabled = pos >= stack.length - 1;
    }
    navButtons();

    async function show(word, push = true) {
      word = word.trim();
      if (!word) return;
      if (push) {
        stack.splice(pos + 1);
        if (stack[pos] !== word) stack.push(word);
        pos = stack.length - 1;
      }
      navButtons();
      input.value = word;
      const id = ++reqId;
      result.replaceChildren(el('div', 'muted', 'Looking up…'));
      try {
        const data = await request({ type: 'EXPLORE', word });
        if (id === reqId) result.replaceChildren(...renderResult(data));
      } catch (e) {
        if (id === reqId) result.replaceChildren(el('div', 'error', e.message));
      }
    }

    function renderResult({ token, containing, containingTotal, segments }) {
      const out = [];
      const main = token.entries?.[0];
      const head = el('div', 'word-head');
      head.append(el('span', 'big', main?.simp ?? token.text));
      if (main && main.trad !== main.simp) head.append(el('span', 'trad', main.trad));
      if (token.hsk) head.append(el('span', 'badge', `HSK ${token.hsk}`));
      out.push(head);
      if (token.pinyin) out.push(el('div', 'py', token.pinyin));

      if (token.entries?.length) {
        const multi = new Set(token.entries.map((e) => e.pinyin)).size > 1;
        for (const e of token.entries) {
          const entry = el('div', 'entry');
          if (multi) entry.append(el('div', 'py', e.pinyin));
          const ol = el('ol');
          for (const d of e.defs) ol.append(el('li', null, d));
          entry.append(ol);
          out.push(entry);
        }
      } else if (segments.length) {
        out.push(el('h4', null, 'Not a single dictionary word – segmented'));
        const line = el('div', 'line-text');
        line.append(...segments.map((t) => tokenChip(t, (w) => explore(w))));
        out.push(line);
      } else {
        out.push(el('div', 'muted', 'No dictionary entry.'));
      }

      if (token.chars?.length) {
        out.push(el('h4', null, 'Characters'));
        for (const c of token.chars) {
          const e = c.entries[0];
          const row = el('div', 'char-row');
          row.append(el('span', 'c', c.char), el('span', 'p', e?.pinyin ?? ''), el('span', 'd', e ? e.defs.slice(0, 3).join('; ') : '—'));
          row.addEventListener('click', () => explore(c.char));
          out.push(row);
        }
      }

      if (containing.length) {
        out.push(el('h4', null, `Words containing ${token.text} (${containingTotal})`));
        for (const w of containing) {
          const row = el('div', 'word-row');
          const d = el('span', 'd', w.def);
          row.append(el('span', 'w', w.word), el('span', 'p', w.pinyin), d);
          row.title = w.def;
          row.addEventListener('click', () => explore(w.word));
          out.push(row);
        }
      }
      return out;
    }

    bus.on('explore', (word) => show(word));
    bus.on('word', ({ text }) => show(text));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') show(input.value); });
    back.addEventListener('click', () => { if (pos > 0) show(stack[--pos], false); });
    forward.addEventListener('click', () => { if (pos < stack.length - 1) show(stack[++pos], false); });
  },
};
