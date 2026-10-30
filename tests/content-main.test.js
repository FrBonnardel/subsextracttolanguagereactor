import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../extension/content/main.js', import.meta.url), 'utf8');
const defaultsSource = readFileSync(new URL('../extension/shared/defaults.js', import.meta.url), 'utf8');
const smootherSource = readFileSync(new URL('../extension/content/subtitle-smoother.js', import.meta.url), 'utf8');

async function harness(hostname = 'www.youtube.com') {
  const timers = new Map();
  const messages = [];
  const displayed = [];
  const raw = [];
  const logs = [];
  let now = 0;
  let nextTimer = 0;
  const context = vm.createContext({
    window: {}, location: { hostname, href: `https://${hostname}/watch` },
    document: { title: 'Test video', createElement: () => ({ getContext: () => ({}) }) },
    performance: { now: () => now },
    HSR_log(...args) { logs.push(args); },
    setInterval() {},
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: {
      storage: { sync: { get: async (defaults) => defaults } },
      runtime: { sendMessage: async (msg) => {
        messages.push(msg);
        if (msg.type === 'TRANSLATE') return { translation: 'Translated' };
        return {};
      } },
    },
  });
  vm.runInContext('window.top = window;', context);
  vm.runInContext(defaultsSource, context);
  vm.runInContext(smootherSource, context);
  context.HSR.Overlay = class {
    constructor({ onSubtitleDisplay }) { this.onSubtitleDisplay = onSubtitleDisplay; }
    showRaw(text) { raw.push(text); } clear() {} setStatus() {}
    setTranslation(text) { displayed.push(text); } renderTokens() {}
    identifySubtitle() {} hasSubtitle() { return false; } rememberTranslation() {}
  };
  context.HSR.NativeSubtitleReader = class {};
  context.HSR.VideoTracker = class {};
  const startup = source.lastIndexOf('  smoother.configure(settings);');
  assert.ok(startup > 0);
  await vm.runInContext(`${source.slice(0, startup)}
    globalThis.api = {
      updateAdState, ad, onLine, resetLine,
      entries, checkReplay, translateLine, applyTranslation,
      overlay,
      setSettings(values) { settings = { ...settings, ...values }; },
      setStory(text) { story = { page: episode, text, pending: false, done: true }; },
      storySnapshot,
      clearOCR() { smoother.onClear(); },
      setVideo(value) { tracker.video = value; },
      get currentLine() { return currentLine; },
      get replaying() { return replaying; },
      native(value) { usingNative = value; },
      queued: () => trQueue.length,
      captureOnce,
      scheduleCapture(engine, direct, native = false) {
        settings = { ...settings, ocrEngine: engine };
        usingDirect = direct;
        usingNative = native;
        schedule();
      },
      applyOcrResult(res, translator = 'python', requestEpoch = epoch) {
        settings = { ...settings, translator, stableFrames: 1 };
        smoother.configure(settings);
        applyResult({
          seq: 1, epoch: requestEpoch, force: false, frameTime: 30,
          capturedAt: Date.now(), direct: true, video: tracker.video,
          rect: { width: 1280, height: 720 },
        }, res);
      },
      setupCapture(engine = 'python') {
        settings = { ...settings, ocrEngine: engine };
        tracker.contentRect = () => ({ left: 0, top: 0, width: 1280, height: 720 });
        grabFromVideo = () => 'data:image/png;base64,cropped';
      },
    };
  })();`, context);
  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  return {
    context, api: context.api, messages, displayed, raw, logs, flush, timers,
    advance(ms) { now += ms; },
    async displayDelay() {
      for (const [id, timer] of [...timers]) {
        if (timer.ms !== 500) continue;
        timers.delete(id);
        timer.fn();
      }
      await flush();
    },
    async settle() {
      for (const [id, timer] of [...timers]) {
        if (timer.ms !== 350) continue;
        timers.delete(id);
        timer.fn();
      }
      await flush();
    },
  };
}

function video(overrides = {}) {
  return {
    currentTime: 30, duration: 1800, paused: false, ended: false,
    seeking: false, readyState: 4, closest: () => null,
    ...overrides,
  };
}

test('only Python direct capture uses 100 ms; screenshots and other engines keep existing limits', async () => {
  const h = await harness();
  for (const [engine, direct, expected] of [['python', true, 100], ['python', false, 500], ['paddle', true, 300]]) {
    h.api.scheduleCapture(engine, direct);
    assert.equal([...h.timers.values()].at(-1).ms, expected);
  }
  h.api.scheduleCapture('python', true, true);
  assert.equal([...h.timers.values()].at(-1).ms, 250);
});

test('Python captures and translation jobs receive the existing episode story and preceding dialogue', async () => {
  const h = await harness();
  h.api.setVideo(video());
  h.api.setupCapture();
  h.api.setSettings({ translator: 'python', storyContext: true });
  h.api.setStory('Video title: Example\nWikipedia synopsis: 谢时 (Xie Shi).');
  await h.api.onLine('大家好', 28);
  await h.settle();
  await h.api.captureOnce();
  const captured = h.messages.find((msg) => msg.type === 'OCR_FRAME').opts.translationContext;
  assert.equal(captured.context[0].text, '大家好');
  assert.match(captured.story, /Xie Shi/);
  assert.equal(h.api.storySnapshot().enabled, true);
  await h.api.onLine('我是谢时', 30);
  await h.settle();
  const translated = h.messages.filter((msg) => msg.type === 'TRANSLATE').at(-1);
  assert.equal(translated.context[0].text, '大家好');
  assert.equal(translated.story, captured.story);
});

test('Python reloads keep history text as context but do not replay legacy context-free translations', async () => {
  for (const translator of ['python', 'nano']) {
    const h = await harness();
    h.api.setSettings({ translator });
    h.context.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type !== 'GET_HISTORY') return {};
      return { items: [{
        text: '我是谢时', translation: "I'm grateful", time: 30,
        page: 'https://www.youtube.com/watch\u0000Test video',
      }] };
    };
    h.api.entries();
    await h.flush();
    const [entry] = h.api.entries();
    assert.equal(entry.text, '我是谢时');
    assert.equal(entry.translation, translator === 'python' ? undefined : "I'm grateful");
  }
});

test('Python displayed timing summaries retain a bounded rolling window and exclude duplicate display events', async () => {
  const h = await harness();
  for (let seq = 0; seq < 35; seq++) {
    const item = { seq, text: '快点', timing: {
      capturedAt: Date.now() - 150, ocrCompletedAt: Date.now() - 20,
      pythonStages: { total_ms: 100, geometry_ms: 20, ocr_ms: 60, translation_ms: 20 },
      pythonRoundTripMs: 110,
    } };
    h.api.overlay.onSubtitleDisplay(item, 'translation');
    h.api.overlay.onSubtitleDisplay(item, 'translation');
  }
  const summaries = h.logs.filter((log) => log[2].startsWith('Python latency summary '));
  assert.equal(summaries.length, 35);
  const summary = JSON.parse(summaries.at(-1)[2].replace('Python latency summary ', ''));
  assert.equal(summary.samples, 30);
  assert.equal(summary.serverMs.mean, 100);
  assert.equal(summary.bridgeRoundTripMs.p95, 110);
  h.api.resetLine();
  const timing = { capturedAt: Date.now() - 50, ocrCompletedAt: Date.now(), pythonStages: { total_ms: 30 } };
  h.api.overlay.onSubtitleDisplay({ seq: 40, text: '走吧', timing }, 'translation');
  const last = h.logs.filter((log) => log[2].startsWith('Python latency summary ')).at(-1)[2];
  assert.equal(JSON.parse(last.replace('Python latency summary ', '')).samples, 1);
});

test('timing logs correlate capture metadata, identification, translation dispatch, response and display', async () => {
  const h = await harness();
  const capturedAt = Date.now() - 100;
  await h.api.onLine('快点', 30, { timing: { frame: 7, capturedAt, videoTime: 30, ocrCompletedAt: capturedAt + 80 } });
  await h.settle();
  const timingLogs = h.logs.filter((log) => log[2].startsWith('Subtitle timing #'));
  assert.equal(timingLogs.length, 3);
  assert.match(timingLogs[0][2], /identified/);
  assert.match(timingLogs[1][2], /sent to translation/);
  assert.match(timingLogs[2][2], /translation returned/);
  const snapshot = JSON.parse(timingLogs[2][2].slice(timingLogs[2][2].indexOf('{')));
  assert.equal(snapshot.frame, 7);
  assert.equal(snapshot.capturedAt, new Date(capturedAt).toISOString());
  assert.ok(snapshot.sentAt && snapshot.translatedAt);
  assert.ok(snapshot.captureToIdentifyMs >= 100);
  const timing = { ...snapshot, capturedAt, identifiedAt: capturedAt + 100, sentAt: capturedAt + 100, translatedAt: Date.now() };
  h.api.overlay.onSubtitleDisplay({ seq: 1, text: '快点', timing }, 'translation');
  assert.ok(timing.translationDisplayedAt);
  assert.match(h.logs.at(-1)[2], /translation displayed/);
  assert.match(h.logs.at(-1)[2], /captureToDisplayMs/);
});

test('Python captures only one frame in flight and takes a fresh paused frame after busy work finishes', async () => {
  const h = await harness();
  const v = video();
  h.api.setVideo(v);
  h.api.setupCapture();
  const resolvers = [];
  h.context.chrome.runtime.sendMessage = async (msg) => {
    h.messages.push(msg);
    if (msg.type === 'OCR_FRAME') return new Promise((resolve) => resolvers.push(resolve));
    return {};
  };
  const initial = h.api.captureOnce();
  await h.api.captureOnce();
  assert.equal(h.messages.filter((msg) => msg.type === 'OCR_FRAME').length, 1);
  v.paused = true;
  v.currentTime = 31;
  await h.api.captureOnce(true);
  assert.equal(resolvers.length, 1);
  resolvers[0]({ skipped: true, reason: 'test' });
  await initial;
  await h.flush();
  assert.equal(resolvers.length, 2, 'Paused capture must be retried after the busy request completes');
  assert.equal(h.messages.filter((msg) => msg.type === 'OCR_FRAME').length, 2);
  resolvers[1]({ skipped: true, reason: 'test' });
  await h.flush();
});

test('a translation returned with Python OCR skips settling and releases the previous subtitle display hold', async () => {
  const h = await harness();
  h.api.setVideo(video());
  h.api.applyOcrResult({ text: '快点', confidence: 95, quality: 1, pythonTranslationReady: true,
    pythonTranslation: 'Hurry up' });
  await h.flush();
  assert.equal(h.messages.filter((msg) => msg.type === 'TRANSLATE').length, 0);
  assert.deepEqual(h.displayed, ['Hurry up']);
  h.api.setStory('Background changed after the capture');
  h.api.applyOcrResult({ text: '走吧', confidence: 95, quality: 1, pythonTranslationReady: true,
    pythonTranslation: "Let's go" });
  await h.flush();
  assert.equal(h.messages.filter((msg) => msg.type === 'TRANSLATE').length, 0);
  assert.deepEqual(h.raw, ['快点', '走吧']);
  assert.deepEqual(h.displayed, ['Hurry up', "Let's go"]);
  await h.settle();
  assert.equal(h.messages.filter((msg) => msg.type === 'TRANSLATE').length, 0);
  assert.equal(h.api.entries().at(-1).translation, "Let's go");
});

test('Chrome vision bundled English reaches overlay and history without text translation', async () => {
  const h = await harness();
  h.api.setVideo(video());
  h.api.applyOcrResult({ text: '我们明天见', confidence: null, quality: 1,
    pythonTranslationReady: true, pythonTranslation: 'See you tomorrow.',
    bundledTranslationProvider: 'nano' }, 'nano');
  await h.flush();
  assert.deepEqual(h.displayed, ['See you tomorrow.']);
  assert.equal(h.messages.filter((msg) => msg.type === 'TRANSLATE').length, 0);
  assert.equal(h.api.entries().at(-1).translation, 'See you tomorrow.');
});

test('missing ready translations and other translator choices retain the OCR settling wait', async () => {
  for (const [translator, pythonTranslationReady] of [['python', false], ['nano', true]]) {
    const h = await harness();
    h.api.setVideo(video());
    h.api.applyOcrResult({ text: '快点', confidence: 95, quality: 1, pythonTranslationReady,
      pythonTranslation: 'Bundled Python output' }, translator);
    await h.flush();
    assert.equal(h.messages.filter((msg) => msg.type === 'TRANSLATE').length, 0);
    await h.settle();
    assert.equal(h.messages.filter((msg) => msg.type === 'TRANSLATE').length, 1);
  }
});

test('ready Python translations cannot bypass stale-frame rejection', async () => {
  const h = await harness();
  h.api.setVideo(video());
  h.api.applyOcrResult({ text: '快点', confidence: 95, quality: 1, pythonTranslationReady: true,
    pythonTranslation: 'Stale translation' }, 'python', -1);
  await h.flush();
  assert.equal(h.messages.filter((msg) => msg.type === 'TRANSLATE').length, 0);
  assert.deepEqual(h.raw, []);
});

test('new OCR keeps the previous translation for at most 500 ms, or replaces it when ready', async () => {
  const h = await harness();
  await h.api.onLine('快点', 30);
  await h.settle();
  await h.api.onLine('走吧', 32);
  assert.deepEqual(h.raw, ['快点']);
  await h.settle();
  assert.deepEqual(h.raw, ['快点', '走吧']);
  await h.api.onLine('你干什么', 34);
  assert.equal(h.raw.at(-1), '走吧');
  await h.displayDelay();
  assert.equal(h.raw.at(-1), '你干什么');
});

test('hybrid Nano starts translation without settling while retaining the previous subtitle until ready', async () => {
  const h = await harness();
  h.api.setVideo(video());
  h.api.setSettings({ ocrEngine: 'paddle-vision' });
  h.api.applyOcrResult({ text: '快点', confidence: 95, quality: 1,
    pythonTranslationReady: true, pythonTranslation: 'Hurry up',
    bundledTranslationProvider: 'nano' }, 'nano');
  await h.flush();
  let resolveTranslation;
  h.context.chrome.runtime.sendMessage = async (msg) => {
    h.messages.push(msg);
    if (msg.type === 'TRANSLATE') return new Promise((resolve) => { resolveTranslation = resolve; });
    return {};
  };
  h.api.setVideo(video({ currentTime: 32 }));
  await h.api.onLine('走吧', 32);
  assert.equal(h.messages.filter((msg) => msg.type === 'TRANSLATE').length, 1);
  assert.equal([...h.timers.values()].some((timer) => timer.ms === 350), false);
  assert.deepEqual(h.raw, ['快点']);
  assert.deepEqual(h.displayed, ['Hurry up']);
  resolveTranslation({ translation: "Let's go" });
  await h.flush();
  assert.deepEqual(h.raw, ['快点', '走吧']);
  assert.deepEqual(h.displayed, ['Hurry up', "Let's go"]);
  await h.displayDelay();
  assert.deepEqual(h.raw, ['快点', '走吧']);
});

test('hybrid Nano retains the 500 ms display deadline when translation is slow', async () => {
  const h = await harness();
  h.api.setSettings({ ocrEngine: 'paddle-vision', translator: 'nano' });
  await h.api.onLine('快点', 30);
  await h.flush();
  let resolveTranslation;
  h.context.chrome.runtime.sendMessage = async (msg) => {
    h.messages.push(msg);
    if (msg.type === 'TRANSLATE') return new Promise((resolve) => { resolveTranslation = resolve; });
    return {};
  };
  await h.api.onLine('走吧', 32);
  assert.deepEqual(h.raw, ['快点']);
  await h.displayDelay();
  assert.deepEqual(h.raw, ['快点', '走吧']);
  resolveTranslation({ translation: "Let's go" });
  await h.flush();
  assert.deepEqual(h.displayed, ['Translated', "Let's go"]);
});

test('hybrid Nano discards an in-flight partial OCR translation and translates its correction next', async () => {
  const h = await harness();
  h.api.setSettings({ ocrEngine: 'paddle-vision', translator: 'nano' });
  const resolvers = [];
  h.context.chrome.runtime.sendMessage = async (msg) => {
    h.messages.push(msg);
    if (msg.type === 'TRANSLATE') return new Promise((resolve) => resolvers.push(resolve));
    return {};
  };
  await h.api.onLine('业务水', 30, { quality: 0.9 });
  await h.api.onLine('业务水平', 30.6, { quality: 1 });
  assert.equal(resolvers.length, 1);
  resolvers[0]({ translation: 'Partial' });
  await h.flush();
  assert.deepEqual(h.displayed, []);
  assert.deepEqual(h.messages.filter((msg) => msg.type === 'TRANSLATE').map((msg) => msg.text),
    ['业务水', '业务水平']);
  resolvers[1]({ translation: 'Professional skills' });
  await h.flush();
  assert.deepEqual(h.displayed, ['Professional skills']);
});

test('translation arriving during the OCR reading hold is displayed, but not after its deadline', async () => {
  const h = await harness();
  const v = video();
  h.api.setVideo(v);
  await h.api.onLine('那还崂嗑啊', 30);
  const seq = h.messages.find((m) => m.kind === 'line').data.seq;
  const entry = h.api.entries()[0];
  v.currentTime = 31;
  h.api.clearOCR();
  assert.equal(h.api.currentLine, null);
  h.advance(200);
  h.api.applyTranslation({ text: entry.text, seq, entry }, { translation: 'Then what are we waiting for?' }, 925);
  assert.deepEqual(h.displayed, ['Then what are we waiting for?']);
  h.advance(301);
  h.api.applyTranslation({ text: entry.text, seq, entry }, { translation: 'Too late' }, 1226);
  assert.deepEqual(h.displayed, ['Then what are we waiting for?']);
  assert.equal(entry.translation, 'Too late');
});

test('a replaced subtitle cannot regain display eligibility during an OCR reading hold', async () => {
  const h = await harness();
  await h.api.onLine('快点', 30);
  await h.settle();
  const seq = h.messages.find((m) => m.kind === 'line').data.seq;
  await h.api.onLine('走吧', 32);
  h.api.clearOCR();
  h.api.applyTranslation({ text: '快点', seq }, { translation: 'Old result' }, 925);
  assert.deepEqual(h.displayed, ['Translated']);
});

test('reset cancels a held OCR display and first/untranslated lines display immediately', async () => {
  const h = await harness();
  await h.api.onLine('快点', 30);
  assert.deepEqual(h.raw, ['快点']);
  await h.api.onLine('走吧', 32);
  assert.equal(h.raw.at(-1), '走吧');
  await h.settle();
  await h.api.onLine('你干什么', 34);
  assert.equal(h.raw.at(-1), '走吧');
  h.api.resetLine();
  await h.displayDelay();
  assert.equal(h.raw.at(-1), '走吧');
});

test('late translations stay in history, including when a later occurrence has identical text', async () => {
  const h = await harness();
  await h.api.onLine('快点', 30);
  const first = h.messages.find((m) => m.kind === 'line').data.seq;
  await h.api.onLine('走吧', 32);
  await h.api.onLine('快点', 34);
  const current = h.messages.filter((m) => m.kind === 'line').at(-1).data.seq;
  const entry = { text: '快点', start: 30, end: 31 };
  h.api.applyTranslation({ text: '快点', seq: first, entry }, { translation: 'Old hurry' }, 1000);
  assert.equal(entry.translation, 'Old hurry');
  assert.equal(h.messages.filter((m) => m.kind === 'translation').at(-1).data.seq, first);
  assert.deepEqual(h.displayed, []);
  h.api.setVideo(video({ currentTime: 35 }));
  h.api.applyTranslation({ text: '快点', seq: current, entry: { end: 34.5 } }, { translation: 'Expired' }, 500);
  assert.deepEqual(h.displayed, []);
  h.api.applyTranslation({ text: '快点', seq: current, entry: { end: 36 } }, { translation: 'Hurry up' }, 200);
  assert.deepEqual(h.displayed, ['Hurry up']);
});

test('a translation for an older line may update a visible fast-dialogue group, but not after eviction', async () => {
  const h = await harness();
  await h.api.onLine('快点', 30);
  const first = h.messages.find((m) => m.kind === 'line').data.seq;
  await h.api.onLine('走吧', 30.4);
  await h.settle();
  h.displayed.length = 0;
  h.api.overlay.hasSubtitle = () => true;
  h.api.applyTranslation({ text: '快点', seq: first, entry: { end: 30.4 } }, { translation: 'Hurry up' }, 600);
  assert.deepEqual(h.displayed, ['Hurry up']);
  h.api.overlay.hasSubtitle = () => false;
  h.api.applyTranslation({ text: '快点', seq: first, entry: { end: 30.4 } }, { translation: 'Evicted' }, 1200);
  assert.deepEqual(h.displayed, ['Hurry up']);
});

test('YouTube stalls and short clips are not ads without a player ad indicator', async () => {
  const { api } = await harness();
  const v = video();
  api.updateAdState(v, 0);
  api.updateAdState(v, 5000);
  assert.equal(api.ad.active, false);
  v.duration = 20;
  api.updateAdState(v, 6000);
  assert.equal(api.ad.active, false);
  v.closest = () => ({ matches: () => true });
  api.updateAdState(v, 7000);
  assert.equal(api.ad.active, true);
  assert.match(api.ad.reason, /YouTube/);
  v.closest = () => null;
  api.updateAdState(v, 8000);
  api.updateAdState(v, 9100);
  assert.equal(api.ad.active, false);
});

test('pause, seeking and buffering do not count towards a generic playback stall', async () => {
  for (const stopped of [{ paused: true }, { seeking: true }, { readyState: 2 }]) {
    const { api } = await harness('example.com');
    const v = video(stopped);
    api.updateAdState(v, 0);
    api.updateAdState(v, 10000);
    Object.assign(v, { paused: false, seeking: false, readyState: 4 });
    api.updateAdState(v, 10100);
    assert.equal(api.ad.active, false);
    api.updateAdState(v, 11000);
    assert.equal(api.ad.active, false);
    api.updateAdState(v, 12000);
    assert.equal(api.ad.active, true);
  }
});

test('OCR fragments settle into one translation; native subtitles translate immediately', async () => {
  const h = await harness();
  await h.api.onLine('业务水', 30);
  await h.api.onLine('业务水平', 30.6);
  assert.equal(h.messages.filter((m) => m.type === 'TRANSLATE').length, 0);
  await h.settle();
  assert.deepEqual(h.messages.filter((m) => m.type === 'TRANSLATE').map((m) => m.text), ['业务水平']);
  h.api.native(true);
  await h.api.onLine('快点', 32);
  await h.flush();
  assert.equal(h.messages.filter((m) => m.type === 'TRANSLATE').at(-1).text, '快点');
});

test('shared words in fast dialogue do not merge separate subtitles or invalidate their translations', async () => {
  const h = await harness();
  await h.api.onLine('当一般人对待', 30);
  await h.api.onLine('不能当一般人对待', 30.328);
  await h.api.onLine('反正就是不能当一般', 30.996);
  const lines = h.messages.filter((m) => m.kind === 'line').map((m) => m.data);
  assert.equal(lines[1].replaces, lines[0].seq);
  assert.equal(lines[2].replaces, undefined);
  await h.settle();
  assert.deepEqual(h.messages.filter((m) => m.type === 'TRANSLATE').map((m) => m.text),
    ['反正就是不能当一般', '不能当一般人对待']);
});

test('native lines and similar OCR text outside the revision window remain distinct', async () => {
  const h = await harness();
  await h.api.onLine('快点', 30);
  await h.api.onLine('快点快点', 32);
  h.api.native(true);
  await h.api.onLine('快点快点快点', 32.3);
  const lines = h.messages.filter((m) => m.kind === 'line');
  assert.ok(lines.every((m) => m.data.replaces === undefined));
});

test('distinct fast dialogue survives settling and is translated newest first', async () => {
  const h = await harness();
  await h.api.onLine('哎呦', 30);
  await h.api.onLine('你干什么', 30.31);
  await h.api.onLine('吓我一跳', 30.64);
  await h.settle();
  assert.deepEqual(h.messages.filter((m) => m.type === 'TRANSLATE').map((m) => m.text),
    ['吓我一跳', '你干什么', '哎呦']);
});

test('OCR confirmation of a known line keeps replay advancing through cached subtitles', async () => {
  const h = await harness();
  const v = video();
  h.api.setVideo(v);
  h.api.entries().push(
    { start: 30, end: 30.4, text: '你干什么', translation: 'What are you doing?' },
    { start: 30.4, end: 31, text: '吓我一跳', translation: 'You scared me!' },
  );
  await h.api.onLine('你干什么', 30);
  assert.ok(h.api.replaying);
  v.currentTime = 30.5;
  h.api.checkReplay();
  assert.equal(h.api.currentLine, '吓我一跳');
  await h.flush();
  assert.equal(h.messages.filter((m) => m.type === 'TRANSLATE').length, 0);
});

test('paused-frame OCR translates immediately without duplicating an active request', async () => {
  const h = await harness();
  let resolve;
  h.context.chrome.runtime.sendMessage = (msg) => {
    h.messages.push(msg);
    return msg.type === 'TRANSLATE' ? new Promise((r) => { resolve = r; }) : Promise.resolve({});
  };
  await h.api.onLine('你干什么', 30, { immediate: true });
  const line = h.messages.find((m) => m.kind === 'line');
  h.api.translateLine('你干什么', line.data.seq);
  assert.equal(h.messages.filter((m) => m.type === 'TRANSLATE').length, 1);
  resolve({ translation: 'What are you doing?' });
  await h.flush();
});

test('a late translation cannot overwrite a revised OCR entry', async () => {
  const h = await harness();
  let resolve;
  h.context.chrome.runtime.sendMessage = (msg) => {
    h.messages.push(msg);
    return msg.type === 'TRANSLATE'
      ? new Promise((r) => { resolve = r; })
      : Promise.resolve({});
  };
  await h.api.onLine('当一般人对待', 30);
  await h.settle();
  await h.api.onLine('不能当一般人对待', 30.3);
  resolve({ translation: 'Old incorrect result' });
  await h.flush();
  assert.equal(h.messages.filter((m) => m.kind === 'translation').length, 0);
});

test('reset cancels pending OCR translation and ignores old in-flight responses', async () => {
  const h = await harness();
  await h.api.onLine('快点', 30);
  h.api.resetLine();
  await h.settle();
  assert.equal(h.messages.filter((m) => m.type === 'TRANSLATE').length, 0);
  let resolve;
  h.context.chrome.runtime.sendMessage = (msg) => {
    h.messages.push(msg);
    return msg.type === 'TRANSLATE'
      ? new Promise((r) => { resolve = r; })
      : Promise.resolve({});
  };
  await h.api.onLine('快点', 32);
  await h.settle();
  h.api.resetLine();
  resolve({ translation: 'Old episode' });
  await h.flush();
  assert.equal(h.messages.filter((m) => m.kind === 'translation').length, 0);
});
