# Hanzi Subs Reactor

A Chrome extension (Manifest V3) that reads **burned-in Chinese subtitles** from any HTML5 `<video>` with OCR. It translates each line with a **local model** or **DeepL** and shows a Language Reactor-style interactive overlay: segmented words, Pinyin, and a hover dictionary (CC-CEDICT) with a breakdown of each character.

## Quick start

```bash
npm install
npm run setup          # Tesseract + PaddleOCR v4 (GPU) models, ONNX Runtime WebGPU, CC-CEDICT
# optional: npm run setup -- --model=best   (more accurate, larger and slower OCR models)
```

1. Open `chrome://extensions`, enable **Developer mode**, then click **Load unpacked** and select the `extension/` folder.
2. The options page opens. Pick a translator (see below) and click **Prepare model** or **Test translation**.
3. Play a video with hardcoded Chinese subtitles. Hover a word to see its dictionary card.

Requires Node 18 or later (for the built-in `fetch`).

## Translators

| Translator | Runs | Setup | Targets |
|---|---|---|---|
| **Chrome built-in** | On-device, Chrome's `Translator` API | Chrome 138+; click **Prepare model** once to download the language pack | Most languages |
| **Gemini Nano** (default) | On-device LLM, Chrome's Prompt API (`LanguageModel`) in the offscreen document | Chrome 138+, GPU with >4 GB VRAM or 16 GB RAM, ~22 GB free disk; click **Prepare model** once (~2 GB download). No key, no server. Until the model is ready (or on unsupported devices) lines fall back to Chrome built-in, uncached | Best in English, Spanish, Japanese |
| **Opus-MT** | On-device, Transformers.js + ONNX (WASM) in the offscreen document | Model (~100 MB) downloads from Hugging Face on first use, then is cached | English only |
| **Ollama** | Local LLM server | Install Ollama, `ollama pull qwen2.5:7b`, start it with `OLLAMA_ORIGINS=chrome-extension://*` | Any |
| **DeepL** | Cloud API | API key (Free keys end in `:fx`) | DeepL languages |

Translations are cached in `chrome.storage.local` per translator and target language.

Chrome built-in, Opus-MT and DeepL are machine translators and tend to be literal. The LLM translators (Gemini Nano, Ollama) follow a shared prompt (`shared/dialogue-prompt.js`) that asks for the speaker's intended meaning as natural dialogue.

Nano's session (instructions plus story background) is created as soon as a video is found and reused for every line. Right after each line is translated, a copy of it is given the dialogue context the next line will receive and processes it in the background, so when the next subtitle appears only that short line is left to process. Translations are shown whole, never streamed. If Nano answers in Chinese instead of translating, it is asked once more, then the line falls back to Chrome built-in (uncached). If it turns a Chinese statement into a question (no question mark, particle, question word or A-not-A form in the line), it is asked once more to keep it a statement. With *Keep the GPU ready during playback* (on by default), a one-token prompt runs whenever Nano has been idle for ~2 s while a video plays, so the GPU stays clocked up between subtitles; real translations abort it, and it stops when the video is paused or the tab is hidden.

With subtitle context enabled, earlier dialogue of the same video helps disambiguate the current line. It comes from this episode's replay timeline, so it survives seeks and reloads. An episode is identified by the page URL and tab title: when a player switches episodes without reloading (new URL or only a new title), the dialogue context, story background, translation queue and the side panel history all start fresh (earlier episodes stay stored for replay). Gemini Nano and Ollama get up to eight earlier lines from the last three minutes; DeepL and Chrome get up to two lines from the last 15 seconds. The LLMs are instructed to translate intended meaning into natural dialogue rather than word for word, preserving tone, relationships, and terminology supported by the subtitles without inventing scene or plot details. Only the current line is returned. Prompt changes bump a cache version so older literal translations are not reused.

The translators receive text, not video images. Chrome uses preceding lines only when its output preserves line boundaries; DeepL has a dedicated context field. Neither supports the custom dialogue instructions used for the LLMs. Opus-MT translates individual lines without context. Model choice still affects translation quality. The logs show which translator produced each line (`Translate via …`).

**Story context (Gemini Nano / Ollama, opt-in).** With *Use video background as story context* enabled, the extension reads the tab title (e.g. `全职法师第7季-02-免费在线观看-爱壹帆` → `全职法师`) and page description once per page, as soon as a video is found (typically before it starts) or when it is paused, and looks up a short matching Wikipedia summary (zh.wikipedia.org for Chinese titles, en.wikipedia.org otherwise; the cleaned title is sent to Wikipedia). The lookup runs in the background and never delays subtitles: lines translated before it arrives are not retranslated; later lines use it. The background is cached per page for the browser session and passed to the LLM as untrusted context for names, relationships and terminology. Scripts or transcripts are never fetched.

## Project structure

```
extension/                  <- load this folder unpacked
  manifest.json
  shared/defaults.js        default settings (shared by every context)
  shared/dialogue-prompt.js natural-dialogue prompt shared by the LLM translators (Gemini Nano, Ollama)
  background/
    service-worker.js       message router, captureVisibleTab, offscreen lifecycle
    translate.js            translator routing + chrome.storage.local cache, Ollama client
    story-context.js        video title/description + Wikipedia synopsis used as Ollama story context
    deepl.js                DeepL /v2/translate
  offscreen/
    offscreen.html/.js      long-lived document: OCR worker + dictionary in memory
    translator.js           on-device translation (Chrome Translator API, Opus-MT)
    ocr.js                  crop -> preprocess -> change detection -> PaddleOCR / Tesseract
    ocr-geometry.js         noise removal and text-dense subtitle line detection
    dictionary.js           CC-CEDICT index, token analysis, character breakdown
    segmenter.js            dictionary-driven DP word segmenter
    pinyin.js               numbered pinyin -> tone marks
  content/
    video-observer.js       finds the main <video>, tracks resize/fullscreen/aspect ratio
    subtitle-smoother.js    debounce / dedupe of OCR lines (Levenshtein similarity)
    overlay.js              Shadow-DOM subtitle overlay + dictionary card
    main.js                 capture loop, wiring, key bindings
  popup/                    quick toggles for the current site, opens the side panel
  sidepanel/                side panel: captured frame, OCR text, translation, history, Hanzi explorer
    sections/index.js       section registry – add { id, title, mount(container, ctx) } modules here
  options/                  DeepL key, OCR tuning, appearance, per-domain list
  vendor/   (generated)     tesseract.js, tesseract core wasm, traineddata, transformers.js + ORT wasm
  data/     (generated)     cedict.json (+ optional hsk.json)
scripts/setup.mjs           asset/dictionary build script
```

## Architecture

```mermaid
sequenceDiagram
  participant CS as Content script
  participant SW as Service worker
  participant OD as Offscreen doc
  participant DL as DeepL
  CS->>SW: CAPTURE_OCR {video rect, dpr, opts}
  SW->>SW: chrome.tabs.captureVisibleTab
  SW->>OD: OCR {dataUrl, rect}
  OD->>OD: crop lower band, binarize, skip if frame unchanged
  OD-->>CS: {text, confidence}
  CS->>CS: SubtitleSmoother (stable N frames, similarity dedupe)
  CS->>SW: SEGMENT {text}
  SW->>OD: segment + CC-CEDICT lookup
  OD-->>CS: tokens [{text, pinyin, entries, chars}]
  CS->>SW: TRANSLATE {text}
  SW->>DL: /v2/translate (cache miss only)
  SW-->>CS: {translation}
```

**Why `captureVisibleTab` instead of `canvas.drawImage(video)`?** Most video hosts serve frames from another origin, which taints the canvas so its pixels can't be read. A screenshot of the tab works on every site. The capture is cropped to the video's *content rect*, which accounts for `object-fit` letterboxing. Chrome limits this call to about 2 per second, so the minimum capture interval is 500 ms.

**Overlay vs. OCR region:** the overlay is placed above the OCR crop band by default, so it never ends up in the screenshot. Capturing pauses while the dictionary card is open.

**Moving subtitles / hiding burned-in ones:** drag the generated subtitles up or down on the video; the position is saved as a fraction of the video height (choosing a preset position in Options, or "Reset dragged position", undoes it). The *Blur subtitles already in the video* option (also in the toolbar popup as *Blur video subs*) adds a frosted band, e.g. over burned-in English subtitles; drag it to move it, drag its top/bottom edge to resize. With direct video-frame capture neither is seen by OCR; in tab-screenshot fallback mode keep them off the Chinese OCR band.

**OCR line detection:** text-dense rows are isolated before recognition so sparse background artwork does not stretch a subtitle's bounding box. The density threshold is relative to each row group's peak, allowing short subtitles as well as long lines.

Run `npm test` for OCR geometry regression tests, including a binary text-mask fixture derived from a subtitle over detailed artwork.

## Settings (options page)

| Group | Settings |
|---|---|
| Translation | translator (Chrome / Opus-MT / Ollama / DeepL), target language, DeepL key + plan, Ollama URL + model, story context, cache clear |
| OCR | language (`chi_sim`, `chi_tra`, both), capture interval, crop band (top/bottom %), brightness threshold, subtitle color, min confidence, stable frames |
| Appearance | font sizes, position (above OCR band / top / below video, or dragged), show pinyin / translation, blur band for burned-in subtitles (strength, width) |
| Behaviour | hover vs. click, pause on hover, key bindings |
| Sites | global enable, disabled domains list |

Default keys: `Alt+Shift+S` toggles the overlay, `Alt+Shift+T` toggles the translation, and `Alt+Shift+P` toggles Pinyin.

## HSK levels (optional)

Put `extension/data/hsk.json` in place as `{ "爱": 1, "爱好": 2, ... }` (simplified word → level). It is loaded automatically if present.

## Known limitations

- **DRM video** (Netflix, Disney+, etc.) often appears black in tab captures, so OCR sees nothing. These services usually provide text subtitle tracks anyway.
- Only top-level frames are supported. Videos inside cross-origin iframes are not tracked yet.
- If a site puts the `<video>` element itself into fullscreen (rather than its container), the overlay can't be shown on top of it.
- OCR accuracy depends on subtitle contrast. Adjust the crop band, threshold, and color in the options.

## Roadmap

- [ ] iframe support (frame offset resolution)
- [ ] Optional `jieba-wasm` segmenter
- [ ] Saved words / export to Anki
- [ ] Subtitle history sidebar with replay of the previous line
- [ ] Move the dictionary into IndexedDB to make offscreen startup faster
