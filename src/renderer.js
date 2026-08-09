/* global api */

const textInput   = document.getElementById('text-input');
const textDisplay  = document.getElementById('text-display');
const dropZone     = document.getElementById('drop-zone');
const btnOpen      = document.getElementById('btn-open');
const btnOutline   = document.getElementById('btn-outline');
const outlinePanel = document.getElementById('outline-panel');
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
let queue = new Map(); // index -> { path, text }
let nextIndexToPlay = 0;
let generationDone = false;
let hasPlayableAudio = false;
let headings = [];
let highlightCursor = 0;

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
textInput.addEventListener('input', () => {
  updateMeta();
  // Edits invalidate heading offsets, so drop the outline rather than risk
  // jumping to the wrong spot.
  if (headings.length) setHeadings([]);
});

// ── Status helpers ───────────────────────────────────────────────────────────

function setStatus(msg, isError) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', !!isError);
}

// ── Outline ──────────────────────────────────────────────────────────────────

function setHeadings(list) {
  headings = list;
  btnOutline.style.display = headings.length ? '' : 'none';
  outlinePanel.style.display = 'none';
  outlinePanel.innerHTML = '';
  for (const h of headings) {
    const item = document.createElement('div');
    item.className = 'outline-item';
    item.textContent = h.title;
    item.style.paddingLeft = `${8 + (h.level - 1) * 14}px`;
    item.addEventListener('click', () => {
      outlinePanel.style.display = 'none';
      jumpToHeading(h.offset);
    });
    outlinePanel.appendChild(item);
  }
}

btnOutline.addEventListener('click', () => {
  outlinePanel.style.display = outlinePanel.style.display === 'none' ? '' : 'none';
});
document.addEventListener('click', (e) => {
  if (outlinePanel.style.display !== 'none' && e.target !== btnOutline && !outlinePanel.contains(e.target)) {
    outlinePanel.style.display = 'none';
  }
});

async function jumpToHeading(offset) {
  audioEl.pause();
  audioEl.removeAttribute('src');
  if (state !== 'idle') await api.stopSpeech();
  startPlayback(offset);
}

// ── Read-along highlighting ──────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Swaps the editable textarea for a read-only mirror so the currently-playing
// sentence can be wrapped in a <mark> — a plain <textarea> can't render inline
// highlights.
function setReadingMode(active) {
  textInput.style.display = active ? 'none' : '';
  textDisplay.style.display = active ? '' : 'none';
  if (active) {
    textDisplay.textContent = textInput.value;
  } else {
    textDisplay.innerHTML = '';
  }
}

function highlightChunk(chunkText) {
  const trimmed = chunkText.trim();
  if (!trimmed) return;
  const text = textInput.value;
  let idx = text.indexOf(trimmed, highlightCursor);
  if (idx === -1) idx = text.indexOf(trimmed);
  if (idx === -1) return; // couldn't locate this chunk verbatim; leave prior highlight in place
  highlightCursor = idx + trimmed.length;

  textDisplay.innerHTML =
    escapeHtml(text.slice(0, idx)) +
    '<mark>' + escapeHtml(text.slice(idx, idx + trimmed.length)) + '</mark>' +
    escapeHtml(text.slice(idx + trimmed.length));
  textDisplay.querySelector('mark')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    setHeadings(result.headings || []);
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
    setHeadings([]);
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

async function startPlayback(offset = 0) {
  const text = textInput.value.slice(offset);
  if (!text.trim()) return;

  resetJobState();
  highlightCursor = offset;
  hasPlayableAudio = false;
  setReadingMode(true);
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
  const entry = queue.get(index);
  if (!entry) return;
  audioEl.src = api.toFileUrl(entry.path);
  audioEl.playbackRate = 1; // speed is baked into generation via the `speed` option
  audioEl.play();
  state = 'playing';
  updateControlsUI();
  highlightChunk(entry.text);
}

audioEl.addEventListener('ended', () => {
  nextIndexToPlay++;
  if (queue.has(nextIndexToPlay)) {
    playChunk(nextIndexToPlay);
  } else if (generationDone) {
    state = 'idle';
    setReadingMode(false);
    setStatus('Done.');
    updateControlsUI();
  } else {
    setStatus('Buffering…');
  }
});

api.onSpeechChunk(({ jobId, index, path, text }) => {
  if (jobId !== currentJobId) return;
  queue.set(index, { path, text });
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
    setReadingMode(false);
    updateControlsUI();
  }
});

api.onSpeechError(({ jobId, message }) => {
  if (jobId !== currentJobId) return;
  setStatus(message, true);
  state = 'idle';
  setReadingMode(false);
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
  setReadingMode(false);
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
