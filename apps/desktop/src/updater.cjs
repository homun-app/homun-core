// Auto-update via electron-updater. The feed is the public `homun-releases` repo
// (electron-builder's publish config generates app-update.yml next to the app).
// Same policy as the previous Homun generation: nothing is ever installed
// silently — the person chooses when to download, and the install happens on
// quit. macOS only for now: releases are signed + notarized there, which is
// what electron-updater's signature anchor requires.
const { app, dialog, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");

const RELEASES_URL = "https://github.com/homun-app/homun-releases/releases";

function offerUpdate(info) {
  const choice = dialog.showMessageBoxSync({
    type: "info",
    message: `Nuova versione di Homun: ${info.version}`,
    detail: "Puoi scaricarla adesso: verrà installata quando chiudi l'app. Le note complete sono nella pagina delle release.",
    buttons: ["Scarica adesso", "Apri le note", "Più tardi"],
    defaultId: 0,
    cancelId: 2,
  });
  if (choice === 0) void autoUpdater.downloadUpdate().catch(() => {});
  if (choice === 1) void shell.openExternal(`${RELEASES_URL}/tag/v${info.version}`);
}

function initUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", error => {
    console.error("updater:", error.message);
  });
  autoUpdater.on("update-available", offerUpdate);
  autoUpdater.on("update-downloaded", () => {
    dialog.showMessageBoxSync({
      type: "info",
      message: "Aggiornamento pronto",
      detail: "La nuova versione si installerà alla chiusura dell'app.",
    });
  });
  // A failed check (offline, feed unreachable) must never disturb the session.
  void autoUpdater.checkForUpdates().catch(error => {
    console.error("updater check failed:", error.message);
  });
}

/** Manual check from Settings: same dialog when found, a status when current. */
async function checkNow() {
  const current = app.getVersion();
  try {
    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo?.version ?? null;
    const available = version ? autoUpdater.currentVersion.compare(version) < 0 : false;
    if (available) offerUpdate(result.updateInfo);
    return { current, available, version };
  } catch (error) {
    return { current, available: false, version: null, error: error.message };
  }
}

function registerUpdaterIpc() {
  ipcMain.handle("homun:update-status", () => ({ current: app.getVersion() }));
  ipcMain.handle("homun:update-check", () => checkNow());
}

module.exports = { initUpdater, registerUpdaterIpc, CAN_AUTO_INSTALL: process.platform === "darwin" };
