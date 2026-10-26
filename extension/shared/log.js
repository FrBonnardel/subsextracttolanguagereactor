// Classic script shared by every context. Entries are funneled to the service worker, which persists them.
(() => {
  const LEVELS = ['debug', 'info', 'warn', 'error'];

  function format(part) {
    if (part instanceof Error) return part.stack || `${part.name}: ${part.message}`;
    if (typeof part === 'string') return part;
    try { return JSON.stringify(part); } catch { return String(part); }
  }

  globalThis.HSR_LOG_KEY = 'hsr:logs';

  globalThis.HSR_log = (level, source, ...parts) => {
    if (!LEVELS.includes(level)) level = 'info';
    (console[level] ?? console.log)(`[HSR ${source}]`, ...parts);
    const entry = { t: Date.now(), level, source, msg: parts.map(format).join(' ') };
    if (globalThis.HSR_logSink) {
      globalThis.HSR_logSink(entry);
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'LOG', entry }).catch(() => {});
    } catch { /* context invalidated */ }
  };

  // Only for extension pages: in content scripts these events would also catch the host page's errors.
  globalThis.HSR_captureErrors = (source) => {
    addEventListener('error', (e) => {
      // Capture phase also sees resource load failures (e.g. a missing <script>), which don't bubble.
      if (e.target && e.target !== globalThis && e.target.src) HSR_log('error', source, `Failed to load ${e.target.src}`);
      else HSR_log('error', source, e.error ?? e.message);
    }, true);
    addEventListener('unhandledrejection', (e) => HSR_log('error', source, 'Unhandled rejection:', e.reason));
  };
})();
