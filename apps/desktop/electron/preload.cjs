const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("localFirstDesktop", {
  gatewayUrl: process.env.HOMUN_DESKTOP_GATEWAY_URL ?? "http://127.0.0.1:18765",
  gatewayToken: process.env.HOMUN_DESKTOP_GATEWAY_TOKEN ?? "",
  // Opens a native directory picker; resolves to the chosen path or null.
  pickFolder: () => ipcRenderer.invoke("lfpa:pick-folder"),
  // Reveals a folder/file in the OS file manager (artifacts "Open folder").
  revealPath: (path) => ipcRenderer.invoke("lfpa:reveal-path", path),
  // Resolves a dropped/picked File to its absolute on-disk path. File.path was
  // removed in Electron 32; webUtils.getPathForFile is the supported replacement
  // (synchronous; the File survives the contextBridge boundary). Returns "" for
  // files with no on-disk backing (e.g. a pasted/synthetic File).
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  // Auto-update (desktop only). Check returns {available, version}; install
  // downloads the new version and restarts.
  checkForUpdate: () => ipcRenderer.invoke("lfpa:update-check"),
  installUpdate: () => ipcRenderer.invoke("lfpa:update-install"),
  // Subscribe to download progress ({percent,transferred,total}); returns an
  // unsubscribe fn.
  onUpdateProgress: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on("lfpa:update-progress", handler);
    return () => ipcRenderer.removeListener("lfpa:update-progress", handler);
  },
});
