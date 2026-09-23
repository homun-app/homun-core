const { contextBridge, ipcRenderer } = require('electron');
// No token, Node, arbitrary IPC or filesystem operation is exposed: only the
// engine base URL and the two update verbs, both handled in the main process.
contextBridge.exposeInMainWorld('homunDesktop', Object.freeze({
  engineBaseUrl: 'homun://app/engine',
  updateStatus: () => ipcRenderer.invoke('homun:update-status'),
  updateCheck: () => ipcRenderer.invoke('homun:update-check'),
}));
