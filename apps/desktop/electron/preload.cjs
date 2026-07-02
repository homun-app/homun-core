const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("localFirstDesktop", {
  gatewayUrl: process.env.HOMUN_DESKTOP_GATEWAY_URL ?? "http://127.0.0.1:18765",
  gatewayToken: process.env.HOMUN_DESKTOP_GATEWAY_TOKEN ?? "",
  // Opens a native directory picker; resolves to the chosen path or null.
  pickFolder: () => ipcRenderer.invoke("lfpa:pick-folder"),
  // Reveals a folder/file in the OS file manager (artifacts "Open folder").
  revealPath: (path) => ipcRenderer.invoke("lfpa:reveal-path", path),
  // Captures the whole app window to a PNG file and reveals it. Returns {ok,path}.
  capturePage: () => ipcRenderer.invoke("lfpa:capture-page"),
  // Keep the app awake during a long streaming task (ref-counted). on=true at start,
  // false at end — so a sleeping Mac doesn't suspend the gateway mid-generation.
  keepAwake: (on) => ipcRenderer.invoke("lfpa:keep-awake", !!on),
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
  // Version of this running build (from the git tag at CI time). Shown in
  // Settings → Account so the user can confirm which build they're on.
  appVersion: () => ipcRenderer.invoke("lfpa:app-version"),
  // Machine specs (RAM/cores) for the onboarding system-requirements step.
  systemSpecs: () => ipcRenderer.invoke("lfpa:system-specs"),
  // "Report a problem": builds a local tar.gz of ~/.homun/logs + a report.json
  // (versions/specs) and reveals it. Logs only — never memory/chat stores.
  createFeedbackBundle: () => ipcRenderer.invoke("lfpa:feedback-bundle"),
  // Auto-update (desktop only). Check returns {available, version, current,
  // releaseNotes}; install downloads the new version and restarts.
  checkForUpdate: () => ipcRenderer.invoke("lfpa:update-check"),
  installUpdate: () => ipcRenderer.invoke("lfpa:update-install"),
  // Unsigned platforms (Windows/Linux): open the releases page for a manual
  // download instead of auto-installing.
  openUpdateDownload: () => ipcRenderer.invoke("lfpa:update-open-download"),
  // Bring the app window to the front (notification click).
  focusWindow: () => ipcRenderer.invoke("lfpa:focus-window"),
  // Subscribe to download progress ({percent,transferred,total}); returns an
  // unsubscribe fn.
  onUpdateProgress: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on("lfpa:update-progress", handler);
    return () => ipcRenderer.removeListener("lfpa:update-progress", handler);
  },
});
