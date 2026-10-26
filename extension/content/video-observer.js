(() => {
  const HSR = (globalThis.HSR ??= {});
  const MIN_W = 200;
  const MIN_H = 100;
  const SCAN_MS = 2000;

  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return 0;
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  }

  function shadowVideos(root, out = []) {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        out.push(...el.shadowRoot.querySelectorAll('video'));
        shadowVideos(el.shadowRoot, out);
      }
    }
    return out;
  }

  /** Tracks the "main" video on the page and reports layout changes (resize, scroll, fullscreen, aspect ratio). */
  HSR.VideoTracker = class VideoTracker {
    constructor({ onVideoChange, onLayoutChange }) {
      this.onVideoChange = onVideoChange;
      this.onLayoutChange = onLayoutChange;
      this.video = null;
      this._raf = 0;
      this._resizeObs = new ResizeObserver(() => this.requestLayout());
      this.scan = this.scan.bind(this);
      this.requestLayout = this.requestLayout.bind(this);
      this._onVideoEvent = this.requestLayout;
    }

    start() {
      this.scan();
      this._mutationObs = new MutationObserver(() => {
        clearTimeout(this._mutT);
        this._mutT = setTimeout(this.scan, 300);
      });
      this._mutationObs.observe(document.documentElement, { childList: true, subtree: true });
      this._interval = setInterval(this.scan, SCAN_MS);
      addEventListener('resize', this.requestLayout);
      addEventListener('scroll', this.requestLayout, { capture: true, passive: true });
      document.addEventListener('fullscreenchange', this.requestLayout);
    }

    stop() {
      this._mutationObs?.disconnect();
      clearInterval(this._interval);
      removeEventListener('resize', this.requestLayout);
      removeEventListener('scroll', this.requestLayout, { capture: true });
      document.removeEventListener('fullscreenchange', this.requestLayout);
      this._setVideo(null);
    }

    scan() {
      let videos = Array.from(document.querySelectorAll('video'));
      if (!videos.length) videos = shadowVideos(document);
      let best = null;
      let bestScore = 0;
      for (const v of videos) {
        let score = visibleArea(v);
        if (!score) continue;
        if (!v.paused && !v.ended) score *= 2;
        // Ad clips are short; the episode is long. Prefer the latter when both are on screen.
        if (Number.isFinite(v.duration)) score *= v.duration > 300 ? 1.5 : v.duration < 120 ? 0.5 : 1;
        if (v === this.video) score *= 1.2; // hysteresis against flip-flopping
        if (score > bestScore) { best = v; bestScore = score; }
      }
      if (best !== this.video) this._setVideo(best);
    }

    _setVideo(video) {
      const old = this.video;
      if (old) {
        this._resizeObs.unobserve(old);
        for (const t of ['loadedmetadata', 'resize']) old.removeEventListener(t, this._onVideoEvent);
      }
      this.video = video;
      if (video) {
        this._resizeObs.observe(video);
        // 'resize' fires when intrinsic size (aspect ratio) changes, e.g. ad -> content.
        for (const t of ['loadedmetadata', 'resize']) video.addEventListener(t, this._onVideoEvent);
      }
      this.onVideoChange?.(video, old);
      this.requestLayout();
    }

    requestLayout() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this.onLayoutChange?.(this.contentRect());
      });
    }

    /** Viewport rect of the actual picture inside the <video> element (excludes object-fit letterboxing). */
    contentRect() {
      const v = this.video;
      if (!v || !v.isConnected) return null;
      const r = v.getBoundingClientRect();
      const base = { left: r.left, top: r.top, width: r.width, height: r.height };
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      const fit = getComputedStyle(v).objectFit;
      if (!vw || !vh || fit === 'fill' || fit === 'cover') return base;

      let scale = Math.min(r.width / vw, r.height / vh);
      if (fit === 'none') scale = 1;
      else if (fit === 'scale-down') scale = Math.min(1, scale);
      const w = vw * scale;
      const h = vh * scale;
      return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
    }
  };
})();
