(async () => {
  if (window.top !== window || globalThis.__hsrLoaded) return;
  globalThis.__hsrLoaded = true;

  const HSR = globalThis.HSR;
  const MIN_INTERVAL = 500; // captureVisibleTab is limited to ~2 calls/sec
  const MIN_DIRECT_INTERVAL = 250;
  const NATIVE_INTERVAL = 250;
  const NATIVE_CLEAR_DELAY_MS = 1500; // a native line stays this long after its cue ends, unless the next one comes
  const OCR_CLEAR_DELAY_MS = 500; // OCR already needs a few empty frames to see the line gone; hold it a bit more
  const MAX_INFLIGHT = 3; // frames queued for OCR at once (direct capture)
  const OCR_TIMEOUT_MS = 10_000;
  const THUMB_W = 160;
  const THUMB_H = 20;
  const REPLAY_MAX_LINE_S = 6; // cap for a line whose end was never observed
  const REPLAY_MATCH_S = 0.8; // same text within this many seconds = same dialog line
  const TRANSLATE_BACKLOG = 30; // older untranslated lines beyond this stay untranslated
  const CONTEXT_LINES = 8; // earlier dialog lines of this video sent as translation context
  const CONTEXT_WINDOW_S = 180; // only lines this close before the current one count as context
  const REVISE_WINDOW_S = 1; // overlapping reads closer than this are one subtitle in transition
  const AD_STALL_MS = 1500; // "playing" with a frozen clock for this long = ad over the video
  const AD_PAUSED_WINDOW_MS = 4000; // 2+ picture changes while paused within this window = ad
  const AD_EXIT_MS = 1000; // signals must be gone this long before OCR resumes
  const log = (level, ...parts) => HSR_log(level, `content ${location.hostname}`, ...parts);

  let settings = await chrome.storage.sync.get(globalThis.HSR_DEFAULTS);
  let visible = true;
  let timer = 0;
  let nativeClearTimer = 0;
  let ocrClearTimer = 0;
  let lineSeq = 0;
  let currentLine = null;
  let pausedByUs = false;
  let dead = false;
  let usingNative = false;
  let usingDirect = false;
  let translatedLine = null;
  let prevLine = null; // line shown just before the current one; can still receive a late translation
  let currentSeq = 0;
  let recentLines = []; // { text, time } of the last few dialog lines, oldest first
  let lastLive = null; // { seq, text, time, entry, quality } of the last line read live (not replayed)
  let currentContext = [];
  let story = { page: '', text: '', pending: false, done: false }; // video background for the LLMs, per episode

  // Episode identity: players switch episodes without reloading, changing the URL (pushState) or only the tab title.
  // Dialogue context, the replay timeline, the panel history and the story are all per episode.
  const episodeKey = () => `${location.href}\u0000${document.title.replace(/^\(\d+\)\s*/, '').trim()}`;
  let episode = episodeKey();

  const nativeReader = new HSR.NativeSubtitleReader(log);

  const enabledHere = () => settings.enabled && !settings.disabledDomains.includes(location.hostname);

  const overlay = new HSR.Overlay({
    onWordOpen: (token) => panel('word', { text: token.text }),
    onCardToggle(open) {
      const v = tracker.video;
      if (!v || !settings.pauseOnHover) return;
      if (open && !v.paused) {
        v.pause();
        pausedByUs = true;
      } else if (!open && pausedByUs) {
        pausedByUs = false;
        v.play().catch(() => {});
      }
    },
  });

  const smoother = new HSR.SubtitleSmoother({
    onLine: (text, time, quality) => onLine(text, time, { quality }),
    onClear: () => {
      closeOpenEntry(tracker.video?.currentTime ?? 0);
      dismissed = replaying; // OCR saw this cached line disappear; don't bring it back
      replaying = null;
      prevLine = currentLine;
      currentLine = null;
      clearLater();
    },
  });

  // Keep the text on screen a little longer for reading; a new line replaces it at once.
  function clearLater() {
    clearTimeout(ocrClearTimer);
    const seq = lineSeq;
    ocrClearTimer = setTimeout(() => {
      ocrClearTimer = 0;
      if (lineSeq !== seq || currentLine) return;
      overlay.clear();
      panel('clear');
    }, OCR_CLEAR_DELAY_MS);
  }

  const tracker = new HSR.VideoTracker({
    onVideoChange(video, old) {
      old?.removeEventListener('seeked', onSeeked);
      old?.removeEventListener('pause', onPaused);
      old?.removeEventListener('timeupdate', onTimeUpdate);
      ad.lastTime = -1;
      pausedThumb = null;
      resetLine();
      nativeReader.attach(video);
      if (video) {
        checkEpisode();
        log('info', `Tracking video ${video.videoWidth}x${video.videoHeight} (${video.currentSrc?.slice(0, 80) || 'no src'})`);
        video.addEventListener('seeked', onSeeked);
        video.addEventListener('pause', onPaused);
        video.addEventListener('timeupdate', onTimeUpdate);
        entries(); // starts seeding the replay timeline for this page
        overlay.mount(video);
        loadStoryContext();
        warmupTranslator();
      } else {
        if (old) log('info', 'Video gone');
        overlay.unmount();
      }
    },
    onLayoutChange: (rect) => overlay.layout(rect),
  });

  function send(msg) {
    if (dead) return Promise.resolve(null);
    return chrome.runtime.sendMessage(msg).catch((e) => {
      // Extension was reloaded/updated: this content script is orphaned.
      if (/context invalidated/i.test(String(e))) shutdown();
      return null;
    });
  }

  // Events for the side panel (it filters by tab); no-op when no panel is listening.
  function panel(kind, data) {
    send({ type: 'PANEL_EVENT', kind, data });
  }

  function ocrOpts() {
    const { ocrEngine, ocrLang, cropTop, cropBottom, textThreshold, subtitleColor, minConfidence, ocrUserWords, ocrCharWhitelist, ocrDictCorrection, ocrPreprocess, ocrEdgeBoost, ocrCenteredOnly } = settings;
    return { ocrEngine, ocrLang, cropTop, cropBottom, textThreshold, subtitleColor, minConfidence, ocrUserWords, ocrCharWhitelist, ocrDictCorrection, ocrPreprocess, ocrEdgeBoost, ocrCenteredOnly };
  }

  let lastState = null;
  // Logs only on change so the log isn't flooded every capture tick.
  function logState(state) {
    if (state === lastState) return;
    lastState = state;
    log('info', `Capture: ${state}`);
    panel('state', { text: state });
  }

  const grabCanvas = document.createElement('canvas');
  const grabCtx = grabCanvas.getContext('2d', { willReadFrequently: true });
  const thumbCanvas = Object.assign(document.createElement('canvas'), { width: THUMB_W, height: THUMB_H });
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
  const directBlocked = new WeakSet();
  let lastThumb = null;
  let epoch = 0; // bumped on tab hide / video change so in-flight results are dropped
  let pending = 0;
  let nextRequest = 0;
  let nextDelivery = 0;
  const results = new Map(); // request seq -> { req, res }, applied strictly in capture order

  // Cheap change check on a thumbnail of the band, so identical frames never reach the OCR queue.
  function bandChanged(force) {
    thumbCtx.drawImage(grabCanvas, 0, 0, THUMB_W, THUMB_H);
    const px = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data;
    const thumb = new Uint8Array(THUMB_W * THUMB_H);
    let sum = 0;
    let strong = 0;
    for (let i = 0; i < thumb.length; i++) {
      thumb[i] = px[i * 4 + 1];
      if (lastThumb) {
        const d = Math.abs(thumb[i] - lastThumb[i]);
        sum += d;
        if (d > 40) strong++;
      }
    }
    const changed = force || !lastThumb || sum / thumb.length > 1.5 || strong > 4;
    if (changed) lastThumb = thumb;
    return changed;
  }

  // Reads the subtitle band straight from the decoded frame: no screenshot, no rate limit, no overlay in the image.
  // Returns a PNG data URL, 'same' if the band didn't change, or null if direct capture isn't possible.
  function grabFromVideo(video, force) {
    if (directBlocked.has(video) || !video.videoWidth) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const sy = Math.round(vh * settings.cropTop);
    const sh = Math.round(vh * (settings.cropBottom - settings.cropTop));
    const scale = Math.min(1, 1280 / vw);
    grabCanvas.width = Math.round(vw * scale);
    grabCanvas.height = Math.round(sh * scale);
    try {
      grabCtx.drawImage(video, 0, sy, vw, sh, 0, 0, grabCanvas.width, grabCanvas.height);
      if (!bandChanged(force)) return 'same';
      return grabCanvas.toDataURL('image/png');
    } catch (e) {
      // Cross-origin video taints the canvas; fall back to tab screenshots for this video.
      directBlocked.add(video);
      log('info', `Direct frame capture blocked (${e.name}); using tab screenshots`);
      return null;
    }
  }

  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

  /**
   * Snaps a frame and queues it for OCR without waiting for earlier frames to finish, so the next
   * subtitle is captured while the previous one is still being recognized and translated.
   */
  function captureOnce(force = false) {
    if (dead) return Promise.resolve();
    const video = tracker.video;
    const rect = tracker.contentRect();
    if (!video || !rect || rect.width < 200 || rect.height < 100) {
      logState(`idle – video too small or detached (${rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : 'no rect'})`);
      return Promise.resolve();
    }
    const limit = directBlocked.has(video) ? 1 : MAX_INFLIGHT;
    if (!force && pending >= limit) return Promise.resolve(); // OCR saturated; a subtitle spans many ticks

    const frameTime = video.currentTime; // when the frame was snapped, not when OCR finishes
    const frame = grabFromVideo(video, force);
    if (frame === 'same') return Promise.resolve();
    const req = { seq: nextRequest++, epoch, force, frameTime, direct: Boolean(frame), rect, video };
    const msg = frame
      ? { type: 'OCR_FRAME', dataUrl: frame, opts: ocrOpts(), fresh: force }
      : {
        type: 'CAPTURE_OCR',
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        dpr: devicePixelRatio,
        opts: ocrOpts(),
        fresh: force,
      };
    pending++;
    return withTimeout(send(msg), OCR_TIMEOUT_MS)
      .then((res) => {
        results.set(req.seq, { req, res });
        while (results.has(nextDelivery)) {
          const r = results.get(nextDelivery);
          results.delete(nextDelivery++);
          applyResult(r.req, r.res);
        }
      })
      .finally(() => { pending--; });
  }

  function applyResult(req, res) {
    if (!res || req.epoch !== epoch || ad.active) return;
    if (res.skipped) {
      logState(`skipped – ${res.reason ?? 'unknown reason'}`);
      return;
    }
    if (res.error) {
      logState(`error – ${res.error}`);
      overlay.setStatus(`OCR: ${res.error}`);
      return;
    }
    const { video, rect } = req;
    logState(req.direct
      ? `running (direct video frame ${video.videoWidth}x${video.videoHeight}, up to ${MAX_INFLIGHT} frames in flight)`
      : `running (tab screenshot, video ${Math.round(rect.width)}x${Math.round(rect.height)} @ ${rect.left | 0},${rect.top | 0}, dpr ${devicePixelRatio})`);
    usingDirect = req.direct;
    if (!res.unchanged) log('debug', `OCR (${Math.round(res.confidence)}%) @${req.frameTime.toFixed(1)}s: ${res.text || '∅'}`);
    if (res.debug) {
      panel('frame', { ...res.debug, text: res.text, confidence: res.confidence, unchanged: !!res.unchanged, mode: req.direct ? 'direct' : 'screenshot' });
    }
    overlay.setStatus('');
    if (req.force) {
      log('info', `Paused frame OCR: ${res.text || '(no subtitle)'}`);
      smoother.force(res.text, req.frameTime, res.quality);
    } else {
      smoother.push(res.text, res.confidence, req.frameTime, res.quality ?? res.confidence / 100);
    }
  }

  function idleReason() {
    const v = tracker.video;
    if (!enabledHere()) return 'disabled on this site';
    if (!visible) return 'overlay hidden (hotkey)';
    if (!v) return 'no <video> found on page';
    if (v.ended) return 'video ended';
    if (v.paused) return 'video paused';
    if (document.hidden) return 'tab in background';
    if (overlay.cardOpen) return 'dictionary card open';
    return null;
  }

  function schedule() {
    clearTimeout(timer);
    if (!dead) {
      const ms = usingNative ? NATIVE_INTERVAL
        : Math.max(usingDirect ? MIN_DIRECT_INTERVAL : MIN_INTERVAL, settings.captureIntervalMs);
      timer = setTimeout(tick, ms);
    }
  }

  function cancelNativeClear() {
    clearTimeout(nativeClearTimer);
    nativeClearTimer = 0;
    clearTimeout(ocrClearTimer);
    ocrClearTimer = 0;
  }

  function scheduleNativeClear() {
    if (!currentLine || nativeClearTimer) return;
    const seq = lineSeq;
    nativeClearTimer = setTimeout(() => {
      nativeClearTimer = 0;
      if (!currentLine || lineSeq !== seq) return;
      prevLine = currentLine;
      currentLine = null;
      lineSeq++;
      overlay.clear();
      panel('clear');
    }, NATIVE_CLEAR_DELAY_MS);
  }

  /** @returns true if native subtitles handled this tick (no OCR needed) */
  function readNative() {
    if (settings.subtitleSource === 'ocr') return false;
    const nat = nativeReader.read(settings.subtitleSelector?.trim());
    if (!nat) {
      if (settings.subtitleSource !== 'native') return false;
      logState('idle – no native subtitles found (source is set to native only)');
      return true;
    }
    logState(`reading native subtitles (${nat.source})`);
    if (!nat.text) {
      scheduleNativeClear();
    } else {
      cancelNativeClear();
      if (nat.text !== currentLine) onLine(nat.text, tracker.video?.currentTime);
    }
    return true;
  }

  async function tick() {
    try {
      checkEpisode();
      const v = tracker.video;
      if (v && visible && enabledHere()) updateAdState(v, performance.now());
      const reason = ad.active ? `ad playing (${ad.reason})` : idleReason();
      if (reason) logState(`idle – ${reason}`);
      else {
        usingNative = readNative();
        if (!usingNative) captureOnce(); // not awaited: capture cadence never waits for OCR
      }
    } finally {
      schedule();
    }
  }

  // ---- ad detection ----
  // Ads either play over a stalled main video (time frozen while "playing"), run while the main
  // video reports paused (picture keeps changing), or replace it with a short clip.

  const ad = { active: false, reason: '', lastTime: -1, lastMoveAt: 0, pausedChanges: [], mainDuration: 0, calmSince: 0 };
  const frameThumb = Object.assign(document.createElement('canvas'), { width: 48, height: 27 });
  const frameThumbCtx = frameThumb.getContext('2d', { willReadFrequently: true });
  let pausedThumb = null;

  function pausedPictureChanged(video) {
    if (directBlocked.has(video) || !video.videoWidth) return false;
    try {
      frameThumbCtx.drawImage(video, 0, 0, frameThumb.width, frameThumb.height);
      const px = frameThumbCtx.getImageData(0, 0, frameThumb.width, frameThumb.height).data;
      const thumb = new Uint8Array(px.length / 4);
      let sum = 0;
      for (let i = 0; i < thumb.length; i++) {
        thumb[i] = px[i * 4 + 1];
        if (pausedThumb) sum += Math.abs(thumb[i] - pausedThumb[i]);
      }
      const changed = pausedThumb != null && sum / thumb.length > 4;
      pausedThumb = thumb;
      return changed;
    } catch {
      return false;
    }
  }

  function updateAdState(video, now) {
    const t = video.currentTime;
    if (Math.abs(t - ad.lastTime) > 0.05) {
      ad.lastTime = t;
      ad.lastMoveAt = now;
    }
    if (Number.isFinite(video.duration) && video.duration > 300) ad.mainDuration = Math.max(ad.mainDuration, video.duration);

    if (video.paused) {
      if (pausedPictureChanged(video)) ad.pausedChanges.push(now);
    } else {
      pausedThumb = null;
    }
    ad.pausedChanges = ad.pausedChanges.filter((x) => now - x < AD_PAUSED_WINDOW_MS);

    let reason = null;
    // readyState >= 3 excludes ordinary buffering, where time also stops.
    if (!video.paused && !video.seeking && video.readyState >= 3 && now - ad.lastMoveAt > AD_STALL_MS) {
      reason = 'playing but time frozen';
    } else if (video.paused && ad.pausedChanges.length >= 2) {
      reason = 'paused but picture changing';
    } else if (ad.mainDuration && Number.isFinite(video.duration) && video.duration < 120 && video.duration < ad.mainDuration * 0.3) {
      reason = `short clip (${Math.round(video.duration)} s)`;
    }

    if (reason) {
      ad.calmSince = 0;
      if (!ad.active) enterAd(reason);
      else ad.reason = reason;
    } else if (ad.active) {
      ad.calmSince ||= now;
      if (now - ad.calmSince > AD_EXIT_MS) exitAd();
    }
  }

  function enterAd(reason) {
    ad.active = true;
    ad.reason = reason;
    log('info', `Ad detected (${reason}) – OCR suspended`);
    closeOpenEntry(lastPlayTime);
    resetLine();
    overlay.setStatus('Ad – subtitles paused');
  }

  function exitAd() {
    ad.active = false;
    ad.calmSince = 0;
    ad.pausedChanges = [];
    log('info', 'Ad finished – OCR resumed');
    overlay.setStatus('');
  }

  function onSeeked() {
    const paused = tracker.video?.paused;
    closeOpenEntry(lastPlayTime);
    dismissed = null;
    resetLine();
    checkReplay();
    if (visible && enabledHere() && !overlay.cardOpen && !usingNative) captureOnce(paused);
  }

  // ---- replay timeline: dialog lines already captured for this page, by video time ----

  let timeline = { key: null, entries: [] }; // entries: { start, end, text, tokens?, translation? }
  let replaying = null; // timeline entry currently shown from cache
  let dismissed = null;
  let lastPlayTime = 0;

  function entries() {
    if (timeline.key !== episode) {
      timeline = { key: episode, entries: [] };
      seedTimeline();
    }
    return timeline.entries;
  }

  function closeOpenEntry(time) {
    for (const e of entries()) if (e.end == null) e.end = Math.max(e.start + 0.3, Math.min(time, e.start + REPLAY_MAX_LINE_S));
  }

  function recordEntry(text, start) {
    if (start == null || !Number.isFinite(start)) return null;
    const list = entries();
    closeOpenEntry(start);
    let e = list.find((x) => x.text === text && Math.abs(x.start - start) < REPLAY_MATCH_S);
    if (!e) {
      e = { start, end: null, text };
      list.push(e);
      list.sort((a, b) => a.start - b.start);
    }
    return e;
  }

  function entryAt(t) {
    let found = null;
    for (const e of entries()) {
      if (e.end == null) continue; // still being captured live
      if (e.start <= t + 0.05 && t < e.end) found = e;
    }
    return found;
  }

  // Lines from an earlier visit (e.g. before the extension reloaded) come from the tab's history.
  async function seedTimeline() {
    const key = timeline.key;
    const res = await send({ type: 'GET_HISTORY' });
    if (timeline.key !== key || !res?.items) return;
    const items = res.items.filter((i) => i.page === key && Number.isFinite(i.time)).sort((a, b) => a.time - b.time);
    items.forEach((item, k) => {
      if (timeline.entries.some((e) => e.text === item.text && Math.abs(e.start - item.time) < REPLAY_MATCH_S)) return;
      const next = items[k + 1];
      const end = next && next.time - item.time < REPLAY_MAX_LINE_S ? next.time : item.time + 3;
      timeline.entries.push({ start: item.time, end, text: item.text, translation: !item.error && item.translation ? item.translation : undefined });
    });
    timeline.entries.sort((a, b) => a.start - b.start);
    if (items.length) log('info', `Replay timeline: ${timeline.entries.length} known lines for this page`);
  }

  /** Shows an already-captured line the moment the playhead enters it; OCR keeps running and wins if it disagrees. */
  function checkReplay() {
    const v = tracker.video;
    if (!v || usingNative || !visible || !enabledHere() || ad.active) return;
    const e = entryAt(v.currentTime);
    // Never override a line OCR is reading live right now; only fill gaps or advance a replay.
    if (e && e !== dismissed && e.text !== currentLine && (!currentLine || replaying)) {
      log('debug', `Replay from cache @${v.currentTime.toFixed(1)}s: ${e.text}`);
      smoother.adopt(e.text);
      onLine(e.text, e.start, { cached: e });
    } else if (!e && replaying && currentLine === replaying.text) {
      replaying = null;
      prevLine = currentLine;
      currentLine = null;
      smoother.reset();
      clearLater();
    }
  }

  function onTimeUpdate() {
    const v = tracker.video;
    if (!v || v.seeking) return;
    lastPlayTime = v.currentTime;
    checkReplay();
  }

  async function onPaused() {
    loadStoryContext();
    if (pausedByUs || !visible || !enabledHere() || dead || ad.active) return;
    if (!usingNative) {
      epoch++; // results for frames captured before the pause are stale
      if (tracker.video?.paused) await captureOnce(true);
    }
    // The paused line may match the current one (no new line emitted) while its translation never arrived.
    if (currentLine && settings.showTranslation && translatedLine !== currentLine) {
      log('debug', `Paused: re-requesting translation for "${currentLine}"`);
      translateLine(currentLine, currentSeq);
    }
  }

  const storyEnabled = () => settings.storyContext && ['ollama', 'nano'].includes(settings.translator);
  const storyText = () => (storyEnabled() && story.page === episode ? story.text : '');

  function pageText(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const text = (el?.content ?? el?.innerText ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function readPageInfo() {
    // SPA players (YouTube, Bilibili) keep the first video's <meta> tags after navigation; trust them only if they match.
    const ogUrl = document.querySelector('meta[property="og:url"]')?.content;
    const metaFresh = !ogUrl || new URL(ogUrl, location.href).pathname === location.pathname;
    const meta = (sels) => (metaFresh ? pageText(sels) : '');
    return {
      page: location.href,
      // The tab title names the show on almost every site ("全职法师第7季-02-免费在线观看-爱壹帆").
      title: document.title,
      altTitle: meta(['meta[property="og:title"]', 'meta[name="twitter:title"]']) || pageText(['ytd-watch-metadata h1', 'h1']),
      description:
        pageText(['ytd-watch-metadata #description-inline-expander', '.desc-info-text', '.basic-desc-info'])
        || meta(['meta[property="og:description"]', 'meta[name="description"]']),
    };
  }

  // Runs in the background when the video is found (usually before it starts) or paused, never on the subtitle path:
  // lines translated before it arrives keep their translation, later lines use the context.
  async function loadStoryContext() {
    if (!storyEnabled() || story.pending || (story.page === episode && story.done)) return;
    const info = readPageInfo();
    if (!info.title && !info.altTitle) return;
    const page = episode;
    const had = story.page === page ? story.text : '';
    story = { page, text: had, pending: true, done: false };
    const res = await send({ type: 'STORY_CONTEXT', info });
    if (story.page !== page || !story.pending) return; // episode changed meanwhile
    // Incomplete (Wikipedia unreachable): keep the page details and try again on the next pause.
    story = { page, text: res?.story || had, pending: false, done: !!res?.complete };
    if (story.text && story.text !== had) {
      log('info', `Story context: ${res.wikiTitle ? `Wikipedia "${res.wikiTitle}"` : 'page title/description only'}`);
      warmupTranslator();
    }
  }

  // Gemini Nano: build its session (system prompt + story) before the first subtitle needs it.
  function warmupTranslator() {
    if (settings.translator !== 'nano' || !settings.showTranslation || !enabledHere()) return;
    const t0 = performance.now();
    send({ type: 'NANO_WARMUP', story: storyText() }).then((res) => {
      if (res?.ok) log('debug', `Gemini Nano warmed up in ${Math.round(performance.now() - t0)} ms`);
      else if (res?.reason) log('info', `Gemini Nano not ready: ${res.reason}`);
    });
  }

  // Gemini Nano keep-alive while playing: the offscreen side only prompts when the model has been idle.
  const KEEPALIVE_MS = 2000;
  setInterval(() => {
    const video = tracker.video;
    if (!video || video.paused || video.ended || document.hidden) return;
    if (settings.translator !== 'nano' || !settings.nanoKeepalive || !settings.showTranslation || !enabledHere()) return;
    send({ type: 'NANO_KEEPALIVE', story: storyText() });
  }, KEEPALIVE_MS);

  function checkEpisode() {
    const key = episodeKey();
    if (key === episode) return;
    episode = key;
    log('info', `New episode: "${document.title}" – dialogue context and history reset`);
    resetLine();
    trQueue.length = 0; // older lines of the previous episode are not worth translating any more
    story = { page: '', text: '', pending: false, done: false };
    panel('episode', { page: episode });
    if (tracker.video) {
      entries(); // seeds the replay timeline if this episode was watched before
      loadStoryContext();
      warmupTranslator();
    }
  }

  function resetLine() {
    cancelNativeClear();
    epoch++;
    lineSeq++;
    currentLine = null;
    prevLine = null;
    recentLines = []; // after a seek the previous lines are no longer the preceding dialog
    lastLive = null;
    smoother.reset();
    overlay.clear();
    panel('clear');
  }

  /**
   * Earlier dialog of this video, oldest first, as { text, ago } (seconds before the current line).
   * Uses the replay timeline (survives seeks and reloads) plus the lines just read live.
   */
  function contextFor(text, time) {
    const known = time != null && Number.isFinite(time);
    const lines = [];
    if (known && !usingNative) {
      for (const e of entries()) {
        if (e.start < time - 0.05 && time - e.start <= CONTEXT_WINDOW_S) lines.push({ text: e.text, time: e.start });
      }
    }
    for (const l of recentLines) {
      if (known && l.time != null && (l.time > time || time - l.time > CONTEXT_WINDOW_S)) continue;
      if (!lines.some((x) => x.text === l.text && (x.time == null || l.time == null || Math.abs(x.time - l.time) < REPLAY_MATCH_S))) {
        lines.push(l);
      }
    }
    return lines
      .sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity))
      .filter((l, i, all) => l.text !== text && l.text !== all[i + 1]?.text)
      .slice(-CONTEXT_LINES)
      .map((l) => ({ text: l.text, ago: known && l.time != null ? Math.round(time - l.time) : 0 }));
  }

  // Share of the shorter line's characters found in the longer one (punctuation ignored).
  function charOverlap(a, b) {
    const [short, long] = Array.from(a).length <= Array.from(b).length ? [a, b] : [b, a];
    const pool = Array.from(long);
    let hit = 0;
    let n = 0;
    for (const c of short) {
      if (/[\s\p{P}]/u.test(c)) continue;
      n++;
      const i = pool.indexOf(c);
      if (i >= 0) {
        hit++;
        pool.splice(i, 1);
      }
    }
    return n ? hit / n : 0;
  }

  /**
   * Another read of the same subtitle: either it follows the previous one quickly with overlapping
   * characters (fade, typing), or it is a close variant of the line still on screen (OCR noise).
   */
  function revisionOf(text, time) {
    const last = lastLive;
    if (!last || time == null || last.time == null) return null;
    const dt = time - last.time;
    const overlap = charOverlap(last.text, text);
    if (dt >= 0 && dt < REVISE_WINDOW_S && overlap >= 0.5) return last;
    if (last.text === currentLine && overlap >= 0.7) return last;
    return null;
  }

  /** Revise only with a better read (higher quality), or a longer one that is not clearly worse (typing). */
  function isBetterRead(text, quality, last) {
    if (quality == null || last.quality == null) return true;
    const longer = Array.from(text).length > Array.from(last.text).length;
    return quality > last.quality + 0.05 || (longer && quality >= last.quality - 0.1);
  }

  /**
   * @param {{cached?: object, quality?: number}} [opts] cached = timeline entry when replayed from
   *   cache; quality = 0..1 read quality from OCR
   */
  async function onLine(text, time = tracker.video?.currentTime, { cached = null, quality = null } = {}) {
    cancelNativeClear();
    const revises = cached ? null : revisionOf(text, time);
    if (revises && !isBetterRead(text, quality, revises)) {
      log('debug', `Kept "${revises.text}" (q ${revises.quality?.toFixed(2)}) over worse read "${text}" (q ${quality?.toFixed(2)})`);
      smoother.adopt(revises.text, revises.quality ?? 1);
      return;
    }
    const seq = ++lineSeq;
    if (revises) {
      time = revises.time; // the dialog line started with the earlier, partial read
      recentLines = recentLines.filter((l) => l.text !== revises.text);
      const queued = trQueue.findIndex((j) => j.seq === revises.seq);
      if (queued >= 0) trQueue.splice(queued, 1);
    } else if (currentLine) {
      prevLine = currentLine;
    }
    currentLine = text;
    currentSeq = seq;
    translatedLine = null;
    currentContext = contextFor(text, time);
    recentLines = [...recentLines, { text, time: time ?? null }].slice(-5);
    let entry = cached;
    if (!cached && !usingNative) {
      if (revises?.entry) {
        entry = Object.assign(revises.entry, { text, end: null, tokens: undefined, translation: undefined });
      } else {
        entry = recordEntry(text, time);
      }
    }
    replaying = cached;
    lastLive = cached ? null : { seq, text, time: time ?? null, entry, quality };
    if (!cached) log('info', `Line${revises ? ' (revised)' : ''}: ${text}`);
    overlay.showRaw(text);
    panel('line', {
      seq,
      text,
      source: cached ? 'replay' : usingNative ? 'native' : 'ocr',
      time: time ?? null,
      page: episode,
      replay: !!cached,
      replaces: revises?.seq,
    });

    if (entry?.tokens) {
      overlay.renderTokens(entry.tokens);
      panel('tokens', { seq, tokens: entry.tokens });
    } else {
      send({ type: 'SEGMENT', text }).then((res) => {
        if (res?.tokens && entry) entry.tokens = res.tokens;
        if (seq !== lineSeq || !res) return;
        if (res.tokens) {
          overlay.renderTokens(res.tokens);
          panel('tokens', { seq, tokens: res.tokens });
        } else if (res.error) {
          log('error', 'Segment:', res.error);
          overlay.setStatus(res.error);
        }
      });
    }
    if (!settings.showTranslation) return;
    if (entry?.translation) {
      translatedLine = text;
      overlay.setTranslation(entry.translation);
      panel('translation', { seq, text: entry.translation, error: false });
    } else {
      translateLine(text, seq, entry, currentContext);
    }
  }

  // One translation in flight, newest line first: the line on screen never waits behind a backlog.
  // Older lines are translated afterwards for the history only, never pushed onto the overlay.
  const trQueue = [];
  let trBusy = false;

  function translateLine(text, seq, entry = null, context = currentContext) {
    const i = trQueue.findIndex((j) => j.text === text);
    if (i >= 0) trQueue.splice(i, 1);
    trQueue.push({ text, seq, entry, context, attempt: 1 });
    if (trQueue.length > TRANSLATE_BACKLOG) {
      const dropped = trQueue.splice(0, trQueue.length - TRANSLATE_BACKLOG);
      log('debug', `Translation stack full: abandoned ${dropped.map((j) => `"${j.text}"`).join(', ')}`);
    }
    pumpTranslations();
  }

  async function pumpTranslations() {
    if (trBusy || dead) return;
    const job = trQueue.pop();
    if (!job) return;
    trBusy = true;
    const t0 = performance.now();
    let res;
    try {
      res = await send({ type: 'TRANSLATE', text: job.text, context: job.context, story: storyText() });
    } finally {
      trBusy = false;
    }
    if (!res) {
      log('warn', `No translation response for "${job.text}" (attempt ${job.attempt})`);
      if (job.attempt < 2) trQueue.unshift({ ...job, attempt: job.attempt + 1 });
    } else {
      applyTranslation(job, res, performance.now() - t0);
    }
    pumpTranslations();
  }

  function applyTranslation({ text, seq, entry }, res, ms) {
    const translation = res.error ?? res.translation;
    if (!res.error && entry) entry.translation = translation;
    const onScreen = text === currentLine;
    log('debug', `Translated via ${res.via?.provider ?? '?'}${res.via?.model ? ` (${res.via.model})` : ''} in ${Math.round(ms)} ms${res.cached ? ' (cached)' : ''}${onScreen ? '' : ' (history only)'}: "${text}" → "${translation}"`);
    panel('translation', { seq, text: translation, error: !!res.error });
    if (res.error) log('error', 'Translate:', res.error);
    if (onScreen) {
      overlay.setTranslation(translation, !!res.error, text);
      if (!res.error) translatedLine = text;
    }
  }

  function applyActive() {
    const on = visible && enabledHere();
    overlay.setVisible(on);
    nativeReader.setHideNative(on && settings.hideNativeSubs);
    if (!on) {
      cancelNativeClear();
      smoother.reset();
      currentLine = null;
      prevLine = null;
      overlay.clear();
    }
  }

  // ---- key bindings ---------------------------------------------------------

  function matchKey(e, combo) {
    if (!combo) return false;
    const parts = combo.toLowerCase().split('+').map((p) => p.trim());
    const key = parts.pop();
    const mods = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey };
    for (const m of Object.keys(mods)) if (mods[m] !== parts.includes(m)) return false;
    const code = e.code.toLowerCase();
    return code === `key${key}` || code === `digit${key}` || e.key.toLowerCase() === key;
  }

  function isTyping(e) {
    const t = e.composedPath()[0];
    return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }

  function onKeyDown(e) {
    if (isTyping(e) || !enabledHere()) return;
    if (matchKey(e, settings.keyToggleOverlay)) {
      visible = !visible;
      applyActive();
    } else if (matchKey(e, settings.keyToggleTranslation)) {
      chrome.storage.sync.set({ showTranslation: !settings.showTranslation });
    } else if (matchKey(e, settings.keyTogglePinyin)) {
      chrome.storage.sync.set({ showPinyin: !settings.showPinyin });
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // ---- settings sync --------------------------------------------------------

  function onStorageChanged(changes, area) {
    if (area !== 'sync') return;
    const before = settings;
    settings = { ...settings };
    for (const [k, { newValue }] of Object.entries(changes)) {
      settings[k] = newValue === undefined ? globalThis.HSR_DEFAULTS[k] : newValue;
    }
    smoother.configure(settings);
    overlay.applySettings(settings);
    applyActive();
    const retranslate = ['targetLang', 'translator', 'ollamaModel', 'deeplKey'].some((k) => settings[k] !== before[k]);
    if (tracker.video) loadStoryContext(); // no-op unless story context just became enabled for this page
    if (tracker.video && settings.translator !== before.translator) warmupTranslator();
    if (currentLine && settings.showTranslation && (retranslate || !before.showTranslation)) {
      translateLine(currentLine, currentSeq);
    }
  }

  function shutdown() {
    dead = true;
    clearTimeout(timer);
    cancelNativeClear();
    nativeReader.setHideNative(false);
    tracker.stop();
    overlay.unmount();
    removeEventListener('keydown', onKeyDown, true);
  }

  smoother.configure(settings);
  overlay.applySettings(settings);
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'HSR_SEEK' && tracker.video && Number.isFinite(msg.time)) {
      tracker.video.currentTime = msg.time;
      if (msg.play) tracker.video.play().catch(() => {});
    }
    return false;
  });
  addEventListener('keydown', onKeyDown, true);
  document.addEventListener('fullscreenchange', () => tracker.video && overlay.mount(tracker.video));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetLine();
    else if (!dead) tick();
  });
  tracker.start();
  applyActive();
  schedule();
  log('info', `Content script started (enabled here: ${enabledHere()})`);
})();
