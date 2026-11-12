// The Google Drive picker window (callistoai.net/drive-picker.html) hands the
// files the person chose back to Callisto through this, and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callistoPicker', {
  done: (files) => ipcRenderer.send('drive:picked', Array.isArray(files) ? files.slice(0, 5).map((f) => ({
    id: String(f && f.id || ''), name: String(f && f.name || ''), mimeType: String(f && f.mimeType || ''),
  })) : []),
});
