// Classic script: loaded by content scripts and pages, and imported for side effects by ES modules.
globalThis.HSR_DEFAULTS = Object.freeze({
  enabled: true,
  disabledDomains: [],

  translator: 'chrome', // 'chrome' (built-in on-device) | 'opus' (Transformers.js) | 'ollama' | 'deepl'
  targetLang: 'EN-US',
  translationContext: true, // send the previous subtitle lines as context (DeepL, Ollama, Chrome)
  deeplKey: '',
  deeplPlan: 'auto', // 'auto' | 'free' | 'pro'
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'qwen2.5:7b',

  subtitleSource: 'auto', // 'auto' (native text if found, else OCR) | 'native' | 'ocr'
  subtitleSelector: '', // optional CSS selector for player-rendered subtitle text
  hideNativeSubs: true,

  ocrEngine: 'paddle', // 'paddle' (PP-OCRv4 on GPU via WebGPU, CPU fallback) | 'tesseract'
  ocrLang: 'chi_sim', // Tesseract only: 'chi_sim' | 'chi_tra' | 'chi_sim+chi_tra'
  ocrPreprocess: 'enhanced', // 'enhanced' (grayscale top-hat + contrast + sharpen) | 'binary' (legacy threshold)
  ocrEdgeBoost: true, // strengthen strokes that have a dark outline/shadow
  ocrCenteredOnly: true, // ignore text blocks away from the centre (danmaku, comments, credits)
  ocrUserWords: true, // CC-CEDICT/HSK word list loaded into Tesseract as user-words
  ocrCharWhitelist: true, // restrict output to dictionary Hanzi, digits and CJK punctuation
  ocrDictCorrection: true, // re-pick glyphs from Tesseract's alternatives to form dictionary words
  captureIntervalMs: 300, // tab screenshots are clamped to >= 500 ms
  cropTop: 0.75,
  cropBottom: 0.97,
  textThreshold: 185,
  subtitleColor: 'white', // 'white' | 'yellow' | 'any'
  minConfidence: 50,
  stableFrames: 1,
  clearAfterEmptyFrames: 2,

  fontSize: 30,
  translationFontSize: 20,
  overlayPosition: 'above-crop', // 'above-crop' | 'top' | 'below-video'
  showPinyin: true,
  showTranslation: true,

  hoverMode: 'hover', // 'hover' | 'click'
  pauseOnHover: true,
  keyToggleOverlay: 'Alt+Shift+S',
  keyToggleTranslation: 'Alt+Shift+T',
  keyTogglePinyin: 'Alt+Shift+P',
});

// DeepL-style target code ('EN-US') + OCR script -> BCP 47 pair for local translators.
globalThis.HSR_langPair = ({ targetLang, ocrLang }) => ({
  source: ocrLang === 'chi_tra' ? 'zh-Hant' : 'zh',
  target: targetLang.split('-')[0].toLowerCase(),
});
