const { contextBridge, ipcRenderer, webUtils } = require('electron');

function toFileUrl(filePath) {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return `file://${encoded}`;
}

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (settings) => ipcRenderer.invoke('set-settings', settings),

  chooseFile: () => ipcRenderer.invoke('choose-file'),
  extractFile: (filePath) => ipcRenderer.invoke('extract-file', filePath),
  extractUrl: (url) => ipcRenderer.invoke('extract-url', url),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  speak: (text, options) => ipcRenderer.invoke('speak', text, options),
  stopSpeech: () => ipcRenderer.invoke('stop-speech'),
  exportAudio: (jobId, filename) => ipcRenderer.invoke('export-audio', { jobId, filename }),

  toFileUrl,

  onFileSelected: (cb) => ipcRenderer.on('file-selected', (_, path) => cb(path)),
  onSpeechChunk: (cb) => ipcRenderer.on('speech-chunk', (_, data) => cb(data)),
  onSpeechDone: (cb) => ipcRenderer.on('speech-done', (_, data) => cb(data)),
  onSpeechError: (cb) => ipcRenderer.on('speech-error', (_, data) => cb(data)),
  onModelDownloadProgress: (cb) => ipcRenderer.on('model-download-progress', (_, p) => cb(p)),
});
