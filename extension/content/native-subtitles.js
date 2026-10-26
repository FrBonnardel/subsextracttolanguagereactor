(() => {
  const HSR = (globalThis.HSR ??= {});
  const HAN = /\p{Script=Han}/u;
  const MARK = 'data-hsr-native-sub';
  const CONFIRM_TEXTS = 3;
  const CONFIRM_SPREAD_S = 3; // the distinct texts must be seen over at least this much playback time
  // Page UI that sits over the player but is never dialog (uploader cards, counters, danmaku, menus).
  // Matched per class/id segment (split on - and _), so "subtitle" or "sub-title" are not caught by "title".
  const UI_WORDS = new Set(['publisher', 'author', 'uploader', 'user', 'avatar', 'intro', 'stat', 'stats', 'count',
    'fans', 'follow', 'like', 'likes', 'comment', 'comments', 'danmu', 'danmaku', 'barrage', 'bullet', 'title',
    'tooltip', 'menu', 'setting', 'settings', 'episode', 'playlist', 'ad', 'ads']);
  const SKIP = 'hsr-overlay, button, a, select, option, input, textarea, ul, li, [role="button"], [role="menu"], [role="menuitem"], [role="listbox"], [role="slider"], [role="tooltip"]';

  /** Dialog-like: mostly Hanzi, not a "label: number" counter, few digits. */
  function isSubtitleLike(text) {
    const chars = Array.from(text.replace(/\s/g, ''));
    const han = chars.filter((c) => HAN.test(c)).length;
    const digits = chars.filter((c) => /\d/.test(c)).length;
    return han >= 2 && han / chars.length >= 0.6 && digits <= 2 && !/[:：]\s*\d/.test(text);
  }

  function isUiElement(el, container) {
    for (let n = el; n && n !== container; n = n.parentElement) {
      const names = [...n.classList, n.id].filter(Boolean);
      if (names.some((name) => name.toLowerCase().split(/[-_]/).some((seg) => UI_WORDS.has(seg)))) return true;
    }
    return false;
  }

  function cleanCueText(raw) {
    return raw
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, '') // ASS override tags like {\an8}
      .split(/\n+/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => HAN.test(l))
      .join(' ');
  }

  function describe(el) {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += `#${n.id}`;
      if (n.classList.length) s += `.${[...n.classList].slice(0, 3).join('.')}`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  }

  // Largest ancestor that is still roughly the video's size (allows a control bar below it).
  function playerContainer(video) {
    const vr = video.getBoundingClientRect();
    let best = video.parentElement ?? video;
    for (let el = best; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width > vr.width * 1.3 || r.height > vr.height * 1.6) break;
      best = el;
    }
    return best;
  }

  /**
   * Reads player-rendered subtitles without OCR: native TextTracks first, then visible Han text
   * positioned over the lower part of the video (or a user-provided CSS selector).
   */
  HSR.NativeSubtitleReader = class NativeSubtitleReader {
    constructor(log) {
      this.log = log;
      this.video = null;
      this.container = null;
      this.hiddenTracks = new Set();
      this.lastSource = null;
      this.lastElements = '';
      this.lastDomHit = 0;
      this.candidates = new Map(); // element descriptor -> Map(text -> video time first seen)
      this.confirmed = new Set();
      this.style = document.createElement('style');
      this.style.textContent = `[${MARK}] { opacity: 0 !important; }`;
    }

    attach(video) {
      this.restoreTracks();
      this.video = video;
      this.container = null;
      this.lastSource = null;
      this.candidates.clear();
      this.confirmed.clear();
    }

    setHideNative(on) {
      this.hideNative = on;
      if (on && !this.style.isConnected) (document.head ?? document.documentElement).append(this.style);
      if (!on) {
        this.style.remove();
        this.restoreTracks();
      }
    }

    restoreTracks() {
      for (const t of this.hiddenTracks) if (t.mode === 'hidden') t.mode = 'showing';
      this.hiddenTracks.clear();
    }

    /** @returns {{source: 'track'|'dom', text: string} | null} null = nothing native found */
    read(selector) {
      const v = this.video;
      if (!v) return null;
      const result = this._readTracks(v) ?? this._readDom(v, selector);
      const source = result?.source ?? null;
      if (source !== this.lastSource) {
        this.lastSource = source;
        if (source) this.log('info', `Native subtitles detected via ${source}`);
      }
      return result;
    }

    _readTracks(v) {
      for (const t of v.textTracks) {
        if (t.mode === 'disabled' || !['subtitles', 'captions'].includes(t.kind)) continue;
        if (!t.cues?.length) continue;
        if (this.hideNative && t.mode === 'showing') {
          t.mode = 'hidden'; // cues stay active but the browser stops rendering them
          this.hiddenTracks.add(t);
        }
        const text = cleanCueText([...(t.activeCues ?? [])].map((c) => c.text ?? '').join('\n'));
        return { source: 'track', text };
      }
      return null;
    }

    _readDom(v, selector) {
      let elements;
      if (selector) {
        try {
          elements = [...document.querySelectorAll(selector)];
        } catch {
          this.log('warn', `Invalid subtitle selector: ${selector}`);
          return null;
        }
        const text = elements.map((el) => cleanCueText(el.innerText ?? el.textContent)).filter(Boolean).join(' ');
        if (this.hideNative) elements.forEach((el) => el.setAttribute(MARK, ''));
        return { source: 'dom', text };
      }

      if (!this.container?.isConnected || !this.container.contains(v)) this.container = playerContainer(v);
      const vr = v.getBoundingClientRect();
      const top = vr.top + vr.height * 0.4;
      const bottom = vr.bottom + vr.height * 0.05;

      const found = new Set();
      const walker = document.createTreeWalker(this.container, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (HAN.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || found.has(el) || el.closest(SKIP)) continue;
        const marked = el.closest(`[${MARK}]`);
        if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: !marked })) continue;
        const r = el.getBoundingClientRect();
        const cy = r.top + r.height / 2;
        if (cy < top || cy > bottom || r.left < vr.left - 10 || r.right > vr.right + 10) continue;
        if (getComputedStyle(el).cursor === 'pointer') continue; // controls / menus
        if (isUiElement(el, this.container)) continue;
        found.add(el);
      }

      // A real subtitle element keeps changing to new dialog as the video plays; static labels (广告),
      // counters (粉丝：0) or a card that loads in a few steps never get confirmed.
      const confirmed = [];
      for (const el of found) {
        const desc = describe(el);
        if (this.confirmed.has(desc)) {
          confirmed.push(el);
          continue;
        }
        const text = cleanCueText(el.innerText ?? el.textContent);
        if (!text || !isSubtitleLike(text) || v.paused) continue;
        const seen = this.candidates.get(desc) ?? new Map(); // text -> video time first seen
        if (!seen.has(text)) seen.set(text, v.currentTime);
        this.candidates.set(desc, seen);
        const times = [...seen.values()];
        if (seen.size >= CONFIRM_TEXTS && Math.max(...times) - Math.min(...times) >= CONFIRM_SPREAD_S) {
          this.confirmed.add(desc);
          this.log('info', `Subtitle element confirmed: ${desc}`);
          confirmed.push(el);
        }
      }

      if (!confirmed.length) {
        // Between lines the subtitle element is empty; stay on the DOM source instead of falling back to OCR.
        return this.lastSource === 'dom' && Date.now() - this.lastDomHit < 60_000 ? { source: 'dom', text: '' } : null;
      }
      this.lastDomHit = Date.now();

      const key = confirmed.map(describe).join(' | ');
      if (key !== this.lastElements) {
        this.lastElements = key;
        this.log('debug', `Subtitle elements: ${key}`);
      }
      if (this.hideNative) confirmed.forEach((el) => el.setAttribute(MARK, ''));
      const text = confirmed.map((el) => cleanCueText(el.innerText ?? el.textContent)).filter(Boolean).join(' ');
      return { source: 'dom', text };
    }
  };
})();
