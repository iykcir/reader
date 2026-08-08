# Reader

A macOS desktop app that reads text, documents, and web articles aloud
using free, local, natural-sounding voices ([Kokoro TTS](https://github.com/hexgrad/kokoro),
via [kokoro-js](https://github.com/hexgrad/kokoro-js)). Synthesis runs
entirely on-device — no API keys, no network calls once the model is
cached.

## Features

- Paste text directly, open a document, or load a web article by URL
- Document formats: PDF, EPUB, DOCX, Markdown, TXT
- Web articles are extracted with [Readability](https://github.com/mozilla/readability)
- 7 built-in voices (US/UK, male/female) and adjustable playback speed
- Streams audio sentence-by-sentence so playback starts almost
  immediately, even on long documents
- Export the generated narration as a WAV file

## Requirements

- macOS
- Node.js

## Development

```bash
npm install
npm start   # launch the app
npm run lint
```

On first use, the Kokoro model weights are downloaded from Hugging
Face and cached under the app's `userData` directory; after that,
speech generation is fully offline.

## Build

```bash
npm run build   # packaged app via electron-builder
npm run pack    # unpacked build, for quick local testing
```

## Architecture notes

Speech synthesis (`src/tts.js`) runs in a dedicated worker thread
(`src/tts-worker.js`) rather than on Electron's main process. Kokoro's
ONNX inference is synchronous, CPU-bound work — running it on the main
thread would freeze every window in the app for the duration of each
chunk.
