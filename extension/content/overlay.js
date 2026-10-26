(() => {
  const HSR = (globalThis.HSR ??= {});

  const CSS = `
    :host { all: initial; }
    .box {
      position: fixed; left: 0; top: 0; max-width: 92vw;
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      text-align: center; pointer-events: auto;
      font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Noto Sans TC", sans-serif;
    }
    .box.empty, .box.hidden { display: none; }
    .zh, .tr {
      display: inline-block; border-radius: 6px; padding: .08em .45em;
      text-shadow: 0 1px 2px #000;
    }
    .zh { background: rgba(0,0,0,.75); color: #fff; font-size: var(--zh-size, 30px); line-height: 1.6; }
    .tr { background: rgba(0,0,0,.6); color: #ddd; font-size: var(--tr-size, 20px); line-height: 1.35; }
    .tr:empty, .box.no-tr .tr { display: none; }
    .zh:empty { display: none; }
    .tr.error { color: #ff9e9e; font-size: 13px; }
    .word { cursor: pointer; border-radius: 4px; padding: 0 .03em; transition: background .1s; }
    .word:hover, .word.active { background: rgba(255, 205, 60, .35); }
    .word.unknown { text-decoration: underline dotted rgba(255,255,255,.4); }
    .punct { opacity: .85; }
    ruby { ruby-position: over; }
    rt { font-size: .42em; color: #ffd27a; letter-spacing: .02em; }
    .box.no-py rt { display: none; }
    .status { font: 11px system-ui, sans-serif; color: #fbb; background: rgba(0,0,0,.6); padding: 1px 6px; border-radius: 4px; }
    .status:empty { display: none; }

    .card {
      position: fixed; width: 340px; max-height: 60vh; overflow: auto; pointer-events: auto;
      background: #1e1f23; color: #e8e8e8; border: 1px solid #3a3b40; border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,.5); padding: 14px 16px;
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; text-align: left;
    }
    .card[hidden] { display: none; }
    .head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
    .hz { font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 32px; color: #fff; }
    .trad { font-size: 20px; color: #aaa; }
    .hsk { font-size: 11px; background: #3b6ef5; color: #fff; padding: 1px 6px; border-radius: 9px; }
    .py { color: #ffd27a; font-size: 16px; margin: 2px 0 8px; }
    .entry + .entry { border-top: 1px solid #333; margin-top: 8px; padding-top: 8px; }
    .entry-py { color: #ffd27a; font-size: 13px; }
    ol { margin: 4px 0 0; padding-left: 20px; }
    li { margin: 1px 0; }
    .sec { margin-top: 12px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #888; }
    .char { display: grid; grid-template-columns: 34px 70px 1fr; gap: 6px; align-items: baseline; margin-top: 4px; }
    .char .c { font-size: 22px; color: #fff; font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif; }
    .char .p { color: #ffd27a; font-size: 13px; }
    .char .d { color: #ccc; font-size: 13px; }
    .muted { color: #888; }
  `;

  const PUNCT = /^[\p{P}\s]+$/u;
  const STOP_EVENTS = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'contextmenu'];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  HSR.Overlay = class Overlay {
    constructor({ onCardToggle, onWordOpen }) {
      this.onCardToggle = onCardToggle;
      this.onWordOpen = onWordOpen;
      this.settings = { ...globalThis.HSR_DEFAULTS };
      this.rect = null;
      this.video = null;
      this.tokens = [];
      this.cardOpen = false;
      this.activeWord = null;
      this.openT = 0;
      this.closeT = 0;

      this.host = document.createElement('hsr-overlay');
      this.host.style.cssText =
        'all:initial; position:fixed; left:0; top:0; width:0; height:0; z-index:2147483647; pointer-events:none;';
      const root = this.host.attachShadow({ mode: 'closed' });
      root.append(el('style', null, CSS));

      this.box = el('div', 'box empty');
      this.zh = el('div', 'zh');
      this.tr = el('div', 'tr');
      this.lineText = '';
      this.status = el('div', 'status');
      this.box.append(this.zh, this.tr, this.status);
      this.card = el('div', 'card');
      this.card.hidden = true;
      root.append(this.box, this.card);

      this._bindEvents();
    }

    // ---- mounting / layout -------------------------------------------------

    mount(video) {
      this.video = video;
      // In fullscreen only descendants of the fullscreen element are rendered.
      const fs = document.fullscreenElement;
      const parent = fs && fs !== video && fs.contains(video) ? fs : document.documentElement;
      if (this.host.parentNode !== parent) parent.appendChild(this.host);
    }

    unmount() {
      this.closeCard();
      this.host.remove();
    }

    applySettings(s) {
      this.settings = s;
      this.box.style.setProperty('--zh-size', `${s.fontSize}px`);
      this.box.style.setProperty('--tr-size', `${s.translationFontSize}px`);
      this.box.classList.toggle('no-py', !s.showPinyin);
      this.box.classList.toggle('no-tr', !s.showTranslation);
      this.layout(this.rect);
    }

    setVisible(visible) {
      this.box.classList.toggle('hidden', !visible);
      if (!visible) this.closeCard();
    }

    layout(rect) {
      this.rect = rect;
      if (this.video) this.mount(this.video);
      if (!rect) {
        this.box.style.visibility = 'hidden';
        return;
      }
      this.box.style.visibility = '';
      const s = this.settings;
      const cx = rect.left + rect.width / 2;
      let y;
      let ty = '-100%';
      if (s.overlayPosition === 'top') {
        y = rect.top + rect.height * 0.04;
        ty = '0';
      } else if (s.overlayPosition === 'below-video' && rect.top + rect.height + 120 < innerHeight) {
        y = rect.top + rect.height + 8;
        ty = '0';
      } else {
        // Sit just above the OCR band so our own text never gets captured.
        y = rect.top + rect.height * s.cropTop - 6;
      }
      this.box.style.maxWidth = `${Math.min(rect.width * 0.96, innerWidth * 0.96)}px`;
      this.box.style.transform = `translate(${cx}px, ${y}px) translate(-50%, ${ty})`;
    }

    // ---- content -----------------------------------------------------------

    showRaw(text) {
      this.closeCard();
      this.lineText = text;
      this.tokens = [];
      this.zh.replaceChildren(document.createTextNode(text));
      this.tr.textContent = '';
      this.tr.classList.remove('error');
      this._updateEmpty();
    }

    renderTokens(tokens) {
      this.tokens = tokens;
      const frag = document.createDocumentFragment();
      tokens.forEach((t, i) => {
        if (!t.hanzi) {
          frag.append(el('span', PUNCT.test(t.text) ? 'punct' : 'latin', t.text));
          return;
        }
        const span = el('span', `word${t.entries.length ? '' : ' unknown'}`);
        span.dataset.i = String(i);
        const ruby = el('ruby');
        ruby.append(document.createTextNode(t.text), el('rt', null, t.pinyin));
        span.append(ruby);
        frag.append(span);
      });
      this.zh.replaceChildren(frag);
    }

    /** @param {string} forLine  the Chinese line this translation belongs to; ignored unless it is on screen */
    setTranslation(text, isError = false, forLine = this.lineText) {
      if (forLine !== this.lineText) return;
      this.tr.textContent = text;
      this.tr.classList.toggle('error', isError);
    }

    setStatus(text) {
      this.status.textContent = text || '';
      this._updateEmpty();
    }

    clear() {
      this.closeCard();
      this.lineText = '';
      this.tokens = [];
      this.zh.replaceChildren();
      this.tr.textContent = '';
      this._updateEmpty();
    }

    _updateEmpty() {
      this.box.classList.toggle('empty', !this.lineText && !this.status.textContent);
    }

    // ---- dictionary card ---------------------------------------------------

    openCard(wordEl) {
      const token = this.tokens[Number(wordEl.dataset.i)];
      if (!token) return;
      this.activeWord?.classList.remove('active');
      this.activeWord = wordEl;
      wordEl.classList.add('active');
      this._fillCard(token);
      this.onWordOpen?.(token);
      this.card.hidden = false;
      this._positionCard(wordEl);
      if (!this.cardOpen) {
        this.cardOpen = true;
        this.onCardToggle?.(true);
      }
    }

    closeCard() {
      clearTimeout(this.openT);
      clearTimeout(this.closeT);
      this.activeWord?.classList.remove('active');
      this.activeWord = null;
      this.card.hidden = true;
      if (this.cardOpen) {
        this.cardOpen = false;
        this.onCardToggle?.(false);
      }
    }

    _fillCard(t) {
      const main = t.entries[0];
      const head = el('div', 'head');
      head.append(el('span', 'hz', main?.simp ?? t.text));
      if (main && main.trad !== main.simp) head.append(el('span', 'trad', main.trad));
      if (t.hsk) head.append(el('span', 'hsk', `HSK ${t.hsk}`));

      const parts = [head, el('div', 'py', t.pinyin)];

      if (!t.entries.length) {
        parts.push(el('div', 'muted', 'No dictionary entry found.'));
      } else {
        const multiReading = new Set(t.entries.map((e) => e.pinyin)).size > 1;
        for (const e of t.entries) {
          const entry = el('div', 'entry');
          if (multiReading) entry.append(el('div', 'entry-py', e.pinyin));
          const ol = el('ol');
          for (const d of e.defs.slice(0, 8)) ol.append(el('li', null, d));
          entry.append(ol);
          parts.push(entry);
        }
      }

      if (t.chars.length) {
        parts.push(el('div', 'sec', 'Characters'));
        for (const c of t.chars) {
          const e = c.entries[0];
          const row = el('div', 'char');
          row.append(
            el('span', 'c', c.char),
            el('span', 'p', e?.pinyin ?? ''),
            el('span', 'd', e ? e.defs.slice(0, 3).join('; ') : '—'),
          );
          parts.push(row);
        }
      }
      this.card.replaceChildren(...parts);
      this.card.scrollTop = 0;
    }

    _positionCard(anchor) {
      const a = anchor.getBoundingClientRect();
      const c = this.card.getBoundingClientRect();
      const margin = 8;
      let left = a.left + a.width / 2 - c.width / 2;
      left = Math.max(margin, Math.min(left, innerWidth - c.width - margin));
      let top = a.top - c.height - margin;
      if (top < margin) top = Math.min(a.bottom + margin, innerHeight - c.height - margin);
      this.card.style.left = `${left}px`;
      this.card.style.top = `${Math.max(margin, top)}px`;
    }

    // ---- events ------------------------------------------------------------

    _bindEvents() {
      // Keep the host page's player from treating our clicks as play/pause.
      const stop = (e) => e.stopPropagation();
      for (const t of STOP_EVENTS) {
        this.box.addEventListener(t, stop);
        this.card.addEventListener(t, stop);
      }

      const wordOf = (n) => (n instanceof Element ? n.closest('.word') : null);
      const isHover = () => this.settings.hoverMode === 'hover';

      this.zh.addEventListener('mouseover', (e) => {
        const w = wordOf(e.target);
        if (!w || !isHover()) return;
        clearTimeout(this.closeT);
        clearTimeout(this.openT);
        this.openT = setTimeout(() => this.openCard(w), this.cardOpen ? 0 : 120);
      });
      this.zh.addEventListener('mouseout', (e) => {
        const w = wordOf(e.target);
        if (!w || !isHover() || w.contains(e.relatedTarget)) return;
        clearTimeout(this.openT);
        this._scheduleClose();
      });
      this.card.addEventListener('mouseenter', () => clearTimeout(this.closeT));
      this.card.addEventListener('mouseleave', () => isHover() && this._scheduleClose());

      this.zh.addEventListener('click', (e) => {
        const w = wordOf(e.target);
        if (!w) return;
        if (this.cardOpen && this.activeWord === w && !isHover()) this.closeCard();
        else this.openCard(w);
      });

      document.addEventListener('pointerdown', (e) => {
        if (this.cardOpen && !e.composedPath().includes(this.host)) this.closeCard();
      }, true);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.cardOpen) this.closeCard();
      }, true);
    }

    _scheduleClose() {
      clearTimeout(this.closeT);
      this.closeT = setTimeout(() => this.closeCard(), 250);
    }
  };
})();
