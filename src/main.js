const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');

const EXTRA_PATHS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin'];
process.env.PATH = [...EXTRA_PATHS, ...(process.env.PATH || '').split(':').filter(Boolean)].join(':');

let mainWindow;

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function writeConfig(data) {
  const current = readConfig();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, ...data }, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 700,
    minWidth: 640,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function buildMenu() {
  const template = [
    {
      label: 'Reader',
      submenu: [
        { label: 'About Reader', click: () => showAbout() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: 'Open Document',
              filters: [
                { name: 'Documents', extensions: ['pdf', 'epub', 'docx', 'md', 'txt'] },
              ],
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send('file-selected', result.filePaths[0]);
            }
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Reader', click: () => showAbout() },
        {
          label: 'Kokoro TTS on GitHub',
          click: () => shell.openExternal('https://github.com/hexgrad/kokoro'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About Reader',
    message: 'Reader',
    detail: `Version ${app.getVersion()}\n\nReads text, documents, and articles aloud with free, local, natural-sounding voices, powered by Kokoro TTS.\n\n© 2026`,
    buttons: ['OK'],
  });
}

// ── Document / URL ingestion ────────────────────────────────────────────────

ipcMain.handle('choose-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Document',
    filters: [{ name: 'Documents', extensions: ['pdf', 'epub', 'docx', 'md', 'txt'] }],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('extract-file', async (_, filePath) => {
  const { extractFromFile } = require('./extract');
  return extractFromFile(filePath);
});

ipcMain.handle('extract-url', async (_, url) => {
  const { extractFromUrl } = require('./extract');
  return extractFromUrl(url);
});

ipcMain.handle('get-file-info', async (_, filePath) => {
  const stat = fs.statSync(filePath);
  return { name: path.basename(filePath), size: stat.size, ext: path.extname(filePath).slice(1) };
});

// ── Settings ─────────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => {
  const config = readConfig();
  return { voice: config.voice || 'af_heart', speed: config.speed || 1 };
});

ipcMain.handle('set-settings', (_, settings) => {
  writeConfig(settings);
});

// ── Speech generation ───────────────────────────────────────────────────────
// Synthesis runs in a worker thread (src/tts-worker.js), not here: Kokoro's
// ONNX inference is synchronous CPU-bound work that would otherwise block
// Electron's main thread and freeze every window for the duration of each
// chunk.

let currentJob = null; // { id, stopped, chunks: [{text, wav, samples, sampleRate}], tmpDir }
let ttsWorker = null;

function getTtsWorker() {
  if (!ttsWorker) {
    ttsWorker = new Worker(path.join(__dirname, 'tts-worker.js'));
    ttsWorker.on('message', handleWorkerMessage);
    ttsWorker.on('error', (err) => {
      if (currentJob) {
        mainWindow?.webContents.send('speech-error', {
          jobId: currentJob.id,
          message: err.message || String(err),
        });
      }
    });
  }
  return ttsWorker;
}

function handleWorkerMessage(msg) {
  const job = currentJob;
  if (!job || msg.jobId !== job.id || job.stopped) return;

  if (msg.type === 'progress') {
    mainWindow?.webContents.send('model-download-progress', msg.progress);
  } else if (msg.type === 'chunk') {
    const chunkPath = path.join(job.tmpDir, `chunk-${msg.index}.wav`);
    fs.writeFileSync(chunkPath, msg.wav);
    job.chunks.push({ text: msg.text, wav: msg.wav, samples: msg.samples, sampleRate: msg.sampleRate });
    mainWindow?.webContents.send('speech-chunk', { jobId: job.id, index: msg.index, path: chunkPath, text: msg.text });
  } else if (msg.type === 'done') {
    mainWindow?.webContents.send('speech-done', { jobId: job.id });
  } else if (msg.type === 'error') {
    mainWindow?.webContents.send('speech-error', { jobId: job.id, message: msg.message });
  }
}

function cleanupJob(job) {
  if (!job) return;
  try {
    fs.rmSync(job.tmpDir, { recursive: true, force: true });
  } catch {}
}

ipcMain.handle('speak', async (_, text, options) => {
  if (currentJob) {
    currentJob.stopped = true;
    getTtsWorker().postMessage({ type: 'stop', jobId: currentJob.id });
    cleanupJob(currentJob);
  }
  const id = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-'));
  currentJob = { id, stopped: false, chunks: [], tmpDir };

  getTtsWorker().postMessage({
    type: 'speak',
    jobId: id,
    text,
    options,
    cacheDir: path.join(app.getPath('userData'), 'models'),
  });

  return { jobId: id };
});

ipcMain.handle('stop-speech', () => {
  if (currentJob) {
    currentJob.stopped = true;
    getTtsWorker().postMessage({ type: 'stop', jobId: currentJob.id });
    cleanupJob(currentJob);
    currentJob = null;
  }
});

ipcMain.handle('model-download-dir', () => path.join(app.getPath('userData'), 'models'));

ipcMain.handle('export-audio', async (_, { jobId, filename }) => {
  if (!currentJob || currentJob.id !== jobId || currentJob.chunks.length === 0) {
    throw new Error('No generated audio to export.');
  }
  const { concatToWav } = require('./tts');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Narration',
    defaultPath: `${filename || 'narration'}.wav`,
    filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
  });
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, concatToWav(currentJob.chunks));
  return result.filePath;
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (currentJob) cleanupJob(currentJob);
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ttsWorker?.terminate();
});
