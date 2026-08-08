/* global api */

const textInput   = document.getElementById('text-input');
const dropZone     = document.getElementById('drop-zone');
const btnOpen      = document.getElementById('btn-open');
const urlInput     = document.getElementById('url-input');
const btnLoadUrl   = document.getElementById('btn-load-url');
const charCount    = document.getElementById('char-count');
const readTime     = document.getElementById('read-time');
const voiceSelect  = document.getElementById('voice-select');
const speedRange   = document.getElementById('speed-range');
const speedLabel   = document.getElementById('speed-label');
const btnPlay      = document.getElementById('btn-play');
const btnStop      = document.getElementById('btn-stop');
const btnExport    = document.getElementById('btn-export');
const statusEl     = document.getElementById('status');
const progressBar  = document.getElementById('progress-bar');
const progressFill = document.getElementById('progress-fill');

// Curated subset of Kokoro-82M's voices (id → label), picked for a spread of
// accent/gender at the higher end of the model's own quality grades.
const VOICES = [
  { id: 'af_heart',  label: 'Heart (US, Female) — best overall' },
  { id: 'af_bella',  label: 'Bella (US, Female)' },
  { id: 'af_nicole', label: 'Nicole (US, Female)' },
  { id: 'am_michael', label: 'Michael (US, Male)' },
  { id: 'am_fenrir', label: 'Fenrir (US, Male)' },
  { id: 'am_puck',   label: 'Puck (US, Male)' },
  { id: 'bf_emma',   label: 'Emma (UK, Female)' },
  { id: 'bm_george', label: 'George (UK, Male)' },
  { id: 'bm_fable',  label: 'Fable (UK, Male)' },
];

let state = 'idle'; // idle | loading | generating | playing | paused
let currentJobId = null;
let audioEl = new Audio();
let queue = new Map(); // index -> path
let nextIndexToPlay = 0;
let generationDone = false;
let hasPlayableAudio = false;

// ── Setup ────────────────────────────────────────────────────────────────────

for (const v of VOICES) {
  const opt = document.createElement('option');
  opt.value = v.id;
  opt.textContent = v.label;
  voiceSelect.appendChild(opt);
}

api.getSettings().then((s) => {
  voiceSelect.value = VOICES.some((v) => v.id === s.voice) ? s.voice : 'af_heart';
  speedRange.value = s.speed;
  speedLabel.textContent = `${Number(s.speed).toFixed(1)}×`;
});

function saveSettings() {
  api.setSettings({ voice: voiceSelect.value, speed: Number(speedRange.value) });
}
voiceSelect.addEventListener('change', saveSettings);
speedRange.addEventListener('input', () => {
  speedLabel.textContent = `${Number(speedRange.value).toFixed(1)}×`;
  saveSettings();
});

// ── Text stats ───────────────────────────────────────────────────────────────

function updateMeta() {
  const text = textInput.value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  charCount.textContent = text ? `${text.length.toLocaleString()} characters, ${words.toLocaleString()} words` : '';
  if (words > 0) {
    const minutes = Math.max(1, Math.round(words / 155));
    readTime.textContent = `~${minutes} min to read aloud`;
  } else {
    readTime.textContent = '';
  }
}
textInput.addEventListener('input', updateMeta);

// ── Status helpers ───────────────────────────────────────────────────────────

function setStatus(msg, isError) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', !!isError);
}

// ── Loading documents ────────────────────────────────────────────────────────

async function loadFile(filePath) {
  setStatus('Reading document…');
  try {
    const info = await api.getFileInfo(filePath);
    const result = await api.extractFile(filePath);
    if (!result.text.trim()) {
      setStatus(`No readable text found in ${info.name}.`, true);
      return;
    }
    textInput.value = result.text;
    updateMeta();
    setStatus(`Loaded "${result.title}".`);
  } catch (err) {
    setStatus(err.message || 'Failed to read that document.', true);
  }
}

btnOpen.addEventListener('click', async () => {
  const filePath = await api.chooseFile();
  if (filePath) loadFile(filePath);
});

api.onFileSelected((filePath) => loadFile(filePath));

btnLoadUrl.addEventListener('click', loadUrl);
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadUrl(); });

async function loadUrl() {
  const url = urlInput.value.trim();
  if (!url) return;
  setStatus('Fetching article…');
  try {
    const result = await api.extractUrl(url);
    textInput.value = result.text;
    updateMeta();
    setStatus(`Loaded "${result.title}".`);
  } catch (err) {
    setStatus(err.message || 'Failed to load that URL.', true);
  }
}

['dragover', 'dragenter'].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
});
['dragleave', 'dragend'].forEach((evt) => {
  dropZone.addEventListener(evt, () => dropZone.classList.remove('dragover'));
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const filePath = api.getPathForFile(file);
  if (filePath) loadFile(filePath);
});

// ── Playback ─────────────────────────────────────────────────────────────────

function updateControlsUI() {
  if (state === 'idle') {
    btnPlay.textContent = '▶ Read Aloud';
    btnPlay.disabled = false;
    btnStop.style.display = 'none';
    progressBar.style.display = 'none';
  } else if (state === 'loading' || state === 'generating') {
    btnPlay.textContent = 'Loading…';
    btnPlay.disabled = true;
    btnStop.style.display = '';
    progressBar.style.display = state === 'loading' ? '' : 'none';
  } else if (state === 'playing') {
    btnPlay.textContent = '⏸ Pause';
    btnPlay.disabled = false;
    btnStop.style.display = '';
  } else if (state === 'paused') {
    btnPlay.textContent = '▶ Resume';
    btnPlay.disabled = false;
    btnStop.style.display = '';
  }
  btnExport.disabled = !hasPlayableAudio;
}

function resetJobState() {
  currentJobId = null;
  queue = new Map();
  nextIndexToPlay = 0;
  generationDone = false;
}

async function startPlayback() {
  const text = textInput.value.trim();
  if (!text) return;

  resetJobState();
  hasPlayableAudio = false;
  state = 'loading';
  updateControlsUI();
  setStatus('Preparing voice… (first run downloads the model, ~90MB)');

  const { jobId } = await api.speak(text, {
    voice: voiceSelect.value,
    speed: Number(speedRange.value),
  });
  currentJobId = jobId;
  state = 'generating';
  updateControlsUI();
  setStatus('Generating speech…');
}

function playChunk(index) {
  const path = queue.get(index);
  if (!path) return;
  audioEl.src = api.toFileUrl(path);
  audioEl.playbackRate = 1; // speed is baked into generation via the `speed` option
  audioEl.play();
  state = 'playing';
  updateControlsUI();
}

audioEl.addEventListener('ended', () => {
  nextIndexToPlay++;
  if (queue.has(nextIndexToPlay)) {
    playChunk(nextIndexToPlay);
  } else if (generationDone) {
    state = 'idle';
    setStatus('Done.');
    updateControlsUI();
  } else {
    setStatus('Buffering…');
  }
});

api.onSpeechChunk(({ jobId, index, path }) => {
  if (jobId !== currentJobId) return;
  queue.set(index, path);
  hasPlayableAudio = true;
  if (index === nextIndexToPlay && (state === 'generating' || state === 'playing')) {
    if (state === 'generating') setStatus('');
    playChunk(index);
  }
  updateControlsUI();
});

api.onSpeechDone(({ jobId }) => {
  if (jobId !== currentJobId) return;
  generationDone = true;
  if (!queue.has(nextIndexToPlay) && state !== 'playing') {
    state = 'idle';
    updateControlsUI();
  }
});

api.onSpeechError(({ jobId, message }) => {
  if (jobId !== currentJobId) return;
  setStatus(message, true);
  state = 'idle';
  updateControlsUI();
});

btnPlay.addEventListener('click', () => {
  if (state === 'idle') startPlayback();
  else if (state === 'playing') { audioEl.pause(); state = 'paused'; updateControlsUI(); }
  else if (state === 'paused') { audioEl.play(); state = 'playing'; updateControlsUI(); }
});

btnStop.addEventListener('click', async () => {
  audioEl.pause();
  audioEl.removeAttribute('src');
  await api.stopSpeech();
  state = 'idle';
  setStatus('');
  updateControlsUI();
});

btnExport.addEventListener('click', async () => {
  if (!currentJobId) return;
  setStatus('Saving audio…');
  try {
    const filename = (textInput.value.trim().split(/\s+/).slice(0, 6).join('-') || 'narration')
      .toLowerCase().replace(/[^a-z0-9-]/g, '');
    const savedPath = await api.exportAudio(currentJobId, filename);
    setStatus(savedPath ? `Saved to ${savedPath}` : '');
  } catch (err) {
    setStatus(err.message || 'Failed to save audio.', true);
  }
});

api.onModelDownloadProgress((p) => {
  if (state !== 'loading') return;
  if (p && p.status === 'progress' && typeof p.progress === 'number') {
    progressBar.style.display = '';
    progressFill.style.width = `${Math.round(p.progress)}%`;
    setStatus(`Downloading voice model… ${Math.round(p.progress)}%`);
  }
});

updateControlsUI();
