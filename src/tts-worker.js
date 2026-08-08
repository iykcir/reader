// Runs Kokoro synthesis on its own thread. ONNX inference is synchronous
// CPU-bound JS/WASM work that doesn't yield to the event loop, so running it
// on Electron's main thread freezes every window in the app for the duration
// of each chunk. Isolating it here keeps the UI responsive.
const { parentPort } = require('worker_threads');
const { streamSpeech } = require('./tts');

let currentJobId = null;
let stopped = false;

parentPort.on('message', async (msg) => {
  if (msg.type === 'stop') {
    if (msg.jobId === currentJobId) stopped = true;
    return;
  }

  if (msg.type !== 'speak') return;

  const jobId = msg.jobId;
  currentJobId = jobId;
  stopped = false;

  try {
    let index = 0;
    for await (const chunk of streamSpeech(msg.text, {
      ...msg.options,
      cacheDir: msg.cacheDir,
      shouldStop: () => stopped || currentJobId !== jobId,
      onProgress: (progress) => parentPort.postMessage({ type: 'progress', jobId, progress }),
    })) {
      if (stopped || currentJobId !== jobId) break;
      parentPort.postMessage({
        type: 'chunk',
        jobId,
        index,
        text: chunk.text,
        wav: chunk.wav,
        samples: chunk.samples,
        sampleRate: chunk.sampleRate,
      });
      index++;
    }
    if (!stopped && currentJobId === jobId) {
      parentPort.postMessage({ type: 'done', jobId });
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', jobId, message: err.message || String(err) });
  }
});
