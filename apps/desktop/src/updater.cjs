// Auto-update via electron-updater. The feed is the public `homun-releases` repo
// (electron-builder's publish config generates app-update.yml next to the app).
// Policy inherited from the previous Homun generation: nothing is ever installed
// silently — the person chooses when to download, watches the download progress,
// and chooses whether to restart immediately or install on quit.
// macOS only for now: releases are signed + notarized there, which is what
// electron-updater's signature anchor requires.
const { app, dialog, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { createUpdateProgressWindow } = require("./update-progress-window.cjs");

const RELEASES_URL = "https://github.com/homun-app/homun-releases/releases";
let progressWindow = null;
let downloading = false;

function dockProgress(ratio) {
  // The Dock API is optional: in some launch contexts the object exists
  // without the full method set — progress on the icon is a nicety, never
  // worth crashing the update flow.
  try {
    if (process.platform === "darwin" && app.dock && typeof app.dock.setProgress === "function") {
      app.dock.setProgress(Math.max(0, Math.min(1, ratio)));
    }
  } catch { /* dock unavailable in this session */ }
}

function offerUpdate(info) {
  // The library always emits with UpdateInfo, but a malformed/absent payload
  // must degrade to a log line, never crash the main process.
  if (!info?.version) {
    console.error("updater: update-available without version, ignored");
    return;
  }
  if (process.env.HOMUN_DESKTOP_UPDATE_E2E === "1") return;
  if (downloading) {
    dialog.showMessageBoxSync({
      type: "info",
      message: "Download già in corso",
      detail: `La versione ${info.version} è in fase di download: vedi la finestra di avanzamento.`,
    });
    return;
  }
  const choice = dialog.showMessageBoxSync({
    type: "info",
    message: `Nuova versione di Homun: ${info.version}`,
    detail: "Puoi scaricarla adesso: vedrai l'avanzamento e al termine decidi se riavviare subito. Le note complete sono nella pagina delle release.",
    buttons: ["Scarica adesso", "Apri le note", "Più tardi"],
    defaultId: 0,
    cancelId: 2,
  });
  if (choice === 0) startDownload(info.version);
  if (choice === 1) void shell.openExternal(`${RELEASES_URL}/tag/v${info.version}`);
}

function startDownload(version) {
  if (downloading) return;
  downloading = true;
  progressWindow = createUpdateProgressWindow(version);
  void autoUpdater.downloadUpdate().catch((error) => {
    downloading = false;
    progressWindow?.close();
    progressWindow = null;
    dockProgress(0);
    dialog.showMessageBoxSync({
      type: "error",
      message: "Download non riuscito",
      detail: `${error.message}. Riprova più tardi da Impostazioni → Guida.`,
    });
  });
}

function initUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", error => {
    console.error("updater:", error.message);
  });
  autoUpdater.on("update-available", offerUpdate);
  autoUpdater.on("download-progress", progress => {
    progressWindow?.update(progress);
    dockProgress(progress.percent / 100);
  });
  autoUpdater.on("update-downloaded", (info) => {
    // A staged download equal to the running version (leftover after an
    // install-on-quit) must not prompt again: only a genuinely newer build.
    if (info?.version && autoUpdater.currentVersion.compare(info.version) >= 0) {
      console.log(`updater: staged ${info.version} is not newer than ${autoUpdater.currentVersion.version}, ignoring`);
      return;
    }
    downloading = false;
    progressWindow?.close();
    progressWindow = null;
    dockProgress(0);
    if (process.env.HOMUN_DESKTOP_UPDATE_E2E === "1") {
      // Scripted run: no modal, install happens on the graceful quit below.
      console.log("E2E update: downloaded, will install on quit");
      return;
    }
    const choice = dialog.showMessageBoxSync({
      type: "info",
      message: "Aggiornamento pronto",
      detail: `La nuova versione è stata scaricata. Posso chiudere e riavviare Homun adesso per installarla, oppure installarla quando chiudi l'app.`,
      buttons: ["Riavvia adesso e installa", "Installa alla chiusura"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) autoUpdater.quitAndInstall(false, true);
  });
  // A failed check (offline, feed unreachable) must never disturb the session.
  void autoUpdater.checkForUpdates().then((result) => {
    // E2E hook: scripted update runs skip the dialogs and drive the whole
    // download -> install-on-quit chain deterministically (no native-dialog
    // automation exists for CI).
    if (process.env.HOMUN_DESKTOP_UPDATE_E2E === "1" && result?.updateInfo?.version
        && autoUpdater.currentVersion.compare(result.updateInfo.version) < 0
        && !downloading) {
      console.log(`E2E update: downloading ${result.updateInfo.version}`);
      startDownload(result.updateInfo.version);
    }
  }).catch(error => {
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
