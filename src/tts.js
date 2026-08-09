// Wraps kokoro-js (Kokoro-82M running locally via ONNX/transformers.js) so the
// rest of the app never touches the model directly. Weights are downloaded
// once from Hugging Face on first use and cached under the app's userData
// dir, the same pattern Transcriber uses for whisper models — after that
// first download, generation is fully offline and free.

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const SAMPLE_RATE = 24000;

let ttsPromise = null;

async function getTTS(cacheDir, onProgress) {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const { KokoroTTS } = require('kokoro-js');
      // kokoro-js re-exports its own `env`, but that binding is a distinct
      // object from @huggingface/transformers' actual singleton (an ESM/CJS
      // dual-instance split) — mutating it here is a silent no-op, so the
      // model always fell back to caching inside node_modules instead of
      // userData. Requiring transformers directly gets the real instance.
      const { env } = require('@huggingface/transformers');
      env.cacheDir = cacheDir;
      return KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: 'q8',
        device: 'cpu',
        progress_callback: (p) => onProgress && onProgress(p),
      });
    })();
  }
  return ttsPromise;
}

// Encodes a Float32 PCM buffer (range -1..1) as a 16-bit mono WAV file buffer.
// Written by hand rather than relying on RawAudio's own serialization so the
// format is known and controllable (needed for clean concatenation on export).
function encodeWav(float32Data, sampleRate) {
  const numSamples = float32Data.length;
  const buffer = Buffer.alloc(44 + numSamples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32Data[i]));
    buffer.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buffer;
}

// Streams speech for `text`, yielding one { text, wav: Buffer, samples: Float32Array }
// per sentence/clause as soon as it's ready, rather than waiting for the whole
// document to synthesize — important for long articles/books so playback can
// start almost immediately. `shouldStop` is polled between chunks so the
// caller can cancel a long job.
async function* streamSpeech(text, { voice = 'af_heart', speed = 1, shouldStop, onProgress, cacheDir } = {}) {
  const { TextSplitterStream } = require('kokoro-js');
  const tts = await getTTS(cacheDir, onProgress);

  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, { voice, speed });
  splitter.push(text);
  splitter.close();

  for await (const chunk of stream) {
    if (shouldStop && shouldStop()) break;
    const samples = chunk.audio.audio;
    const sampleRate = chunk.audio.sampling_rate || SAMPLE_RATE;
    yield { text: chunk.text, wav: encodeWav(samples, sampleRate), samples, sampleRate };
  }
}

function concatToWav(chunks) {
  const sampleRate = chunks[0]?.sampleRate || SAMPLE_RATE;
  const totalLength = chunks.reduce((sum, c) => sum + c.samples.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c.samples, offset);
    offset += c.samples.length;
  }
  return encodeWav(merged, sampleRate);
}

module.exports = { streamSpeech, concatToWav, getTTS };
