// Auto-aggiornamento (fase rilascio, A8 — adattato da homun2
// src-updater.cjs.txt e src-update-progress-window.cjs.txt). Il feed è il
// repo pubblico homun-app/homun-releases (la config publish di
// electron-builder genera app-update.yml accanto all'app).
//
// Regola dell'utente: NIENTE in silenzio. Si controlla il feed all'avvio e
// poi ogni 6 ore, SOLO nell'app impacchettata (mai in sviluppo né quando c'è
// una variabile SANDBOT_TEST_*: le prove non toccano la rete). Chi scarica è
// la persona: «È disponibile Homun X.Y.Z» con le note → Scarica → avanzamento
// visibile (finestra + Dock) → «Riavvia ora» o «Alla chiusura». Prima di
// installare, il daemon si ferma BENE (RPC daemon:restart di A2: la coda è
// durevole, un turno interrotto riprende come dopo un crash).
import { app, BrowserWindow, dialog, shell } from 'electron'
// electron-updater è CommonJS: l'import CON NOME non è rilevabile dal lexer
// CJS nel bundle (errori a runtime nell'app impacchettata) — si destruttura
// dal default export
import electronUpdater from 'electron-updater'
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import { mainStrings } from './i18n'

// l'istanza si COSTRUISCE al primo accesso (getter del pacchetto) e serve
// l'app Electron: mai toccarla a import time, o vitest/node puro esplode
let auInstance: AppUpdater | null = null
function au(): AppUpdater {
  auInstance ??= electronUpdater.autoUpdater
  return auInstance
}

const RELEASES_URL = 'https://github.com/homun-app/homun-releases/releases'
/** Ogni quanto ricontrollare il feed dopo il controllo d'avvio. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Puro (A8): il controllo automatico è ammesso solo nell'app impacchettata,
 * mai in sviluppo e mai quando c'è una variabile SANDBOT_TEST_* (le prove con
 * dati temporanei non devono nemmeno pensare alla rete).
 */
export function shouldAutoCheckUpdates(isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  if (!isPackaged) return false
  return !Object.keys(env).some((k) => k.startsWith('SANDBOT_TEST_'))
}

/** La politica di confronto: serve solo una versione REALMENTE più recente. */
export function isNewerVersion(current: string, candidate: string): boolean {
  try {
    return new semverLike(current).compare(candidate) < 0
  } catch {
    return false
  }
}

/** Confronto semplificato x.y.z(…) senza dipendere da semver: x.y.z a pezzi. */
class semverLike {
  private readonly parts: number[]
  constructor(v: string) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
    if (!m) throw new Error(`invalid version: ${v}`)
    this.parts = [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  compare(other: string): number {
    const o = new semverLike(other)
    for (let i = 0; i < 3; i++) {
      if (this.parts[i]! < o.parts[i]!) return -1
      if (this.parts[i]! > o.parts[i]!) return 1
    }
    return 0
  }
}

/** Prima di installare: ferma bene il daemon (A2) e aspetta che esca. */
export type StopDaemonForUpdate = () => Promise<void>

let progressWindow: { update(i: { transferred: number; total: number; percent: number }): void; close(): void } | null = null
let downloading = false
let stopDaemon: StopDaemonForUpdate = async () => undefined
let checkTimer: NodeJS.Timeout | null = null

/** Il daemon si ferma con questa callback prima di installare (cablata dal main). */
export function setUpdaterDaemonStopper(stop: StopDaemonForUpdate): void {
  stopDaemon = stop
}

function dockProgress(ratio: number): void {
  // avanzamento sul Dock (macOS): la barra della finestra principale; è un
  // extra — senza finestre non c'è nulla da fare e non si crasha mai
  try {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    win?.setProgressBar(Math.max(-1, Math.min(1, ratio)))
  } catch {
    /* nessuna finestra utile in questo momento */
  }
}

/** La finestra d'avanzamento (HTML autonomo, niente Node nel renderer). */
function createUpdateProgressWindow(version: string) {
  const s = mainStrings().updater
  const page = (v: string) => `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>${s.progressTitle}</title>
<style>
  body { font: 13px -apple-system, system-ui, sans-serif; margin: 0; padding: 18px 20px 20px; cursor: default; }
  h1 { font-size: 13px; font-weight: 600; margin: 0 0 4px; }
  p { margin: 0 0 14px; opacity: .65; font-size: 12px; }
  .bar { height: 6px; border-radius: 999px; background: rgba(127,127,127,.25); overflow: hidden; }
  .bar > div { height: 100%; width: 0%; border-radius: 999px; background: #4f7942; transition: width .2s; }
  .row { display: flex; justify-content: space-between; margin-top: 8px; font-size: 11px; opacity: .65; }
</style></head>
<body>
  <h1>${s.downloadingTitle.replace('{version}', v)}</h1>
  <p>${s.progressBody}</p>
  <div class="bar"><div id="fill"></div></div>
  <div class="row"><span id="bytes">0 MB / 0 MB</span><span id="percent">0%</span></div>
  <script>
    function setProgress(transferredMB, totalMB, percent) {
      document.getElementById('fill').style.width = Math.min(100, Math.max(0, percent)) + '%';
      document.getElementById('percent').textContent = Math.floor(percent) + '%';
      document.getElementById('bytes').textContent = transferredMB.toFixed(1) + ' MB / ' + totalMB.toFixed(1) + ' MB';
    }
  </script>
</body></html>`
  const win = new BrowserWindow({
    width: 400,
    height: 170,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: s.progressTitle,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(version)))
  win.once('ready-to-show', () => win.show())
  const mb = (b: number) => b / (1024 * 1024)
  return {
    update(info: { transferred: number; total: number; percent: number }) {
      if (win.isDestroyed()) return
      win.webContents.executeJavaScript(`setProgress(${mb(info.transferred)}, ${mb(info.total)}, ${info.percent})`).catch(() => undefined)
    },
    close() {
      if (!win.isDestroyed()) win.close()
    }
  }
}

function notesOf(info: UpdateInfo | undefined): string {
  const raw = info?.releaseNotes
  if (!raw) return mainStrings().updater.availableBody
  if (typeof raw === 'string') return raw
  // ReleaseNoteInfo: solo il testo, niente HTML grezzo
  const note = raw as { note?: string }
  return note.note ?? mainStrings().updater.availableBody
}

function offerUpdate(info: UpdateInfo | undefined): void {
  if (!info?.version) return
  const s = mainStrings().updater
  if (downloading) return
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    message: s.availableTitle.replace('{version}', info.version),
    detail: notesOf(info),
    buttons: [s.download, s.openNotes, s.later],
    defaultId: 0,
    cancelId: 2
  })
  if (choice === 0) startDownload(info.version)
  if (choice === 1) void shell.openExternal(`${RELEASES_URL}/tag/v${info.version}`)
}

function startDownload(version: string): void {
  if (downloading) return
  downloading = true
  progressWindow = createUpdateProgressWindow(version)
  void au().downloadUpdate().catch((error) => {
    downloading = false
    progressWindow?.close()
    progressWindow = null
    dockProgress(0)
    dialog.showMessageBoxSync({
      type: 'error',
      message: mainStrings().updater.downloadFailed,
      detail: error instanceof Error ? error.message : String(error)
    })
  })
}

async function installAfterDaemonStopped(): Promise<void> {
  try {
    await stopDaemon()
  } catch {
    // il daemon giù o irreraggiungibile: si installa comunque
  }
  au().quitAndInstall(false, true)
}

export function initUpdater(): void {
  au().autoDownload = false
  au().autoInstallOnAppQuit = true
  au().on('error', (error) => {
    console.error('[updater]', error instanceof Error ? error.message : error)
  })
  au().on('update-available', (info) => offerUpdate(info))
  au().on('download-progress', (progress) => {
    progressWindow?.update(progress)
    dockProgress(progress.percent / 100)
  })
  au().on('update-downloaded', (info) => {
    // uno staged uguale alla versione in esecuzione (resto di un
    // install-on-quit) non va riproposto: solo una davvero più recente
    if (info?.version && !isNewerVersion(au().currentVersion.version, info.version)) return
    downloading = false
    progressWindow?.close()
    progressWindow = null
    dockProgress(0)
    const s = mainStrings().updater
    const choice = dialog.showMessageBoxSync({
      type: 'info',
      message: s.readyTitle,
      detail: s.readyBody,
      buttons: [s.restartNow, s.onQuit],
      defaultId: 0,
      cancelId: 1
    })
    if (choice === 0) void installAfterDaemonStopped()
  })
  // un controllo fallito (offline, feed irraggiungibile) non disturba mai
  void au().checkForUpdates().catch((error: unknown) => {
    console.error('[updater] controllo fallito:', error instanceof Error ? error.message : error)
  })
  if (checkTimer) clearInterval(checkTimer)
  checkTimer = setInterval(() => {
    void au().checkForUpdates().catch(() => undefined)
  }, CHECK_INTERVAL_MS)
  checkTimer.unref()
}

/** Controllo manuale dalle Impostazioni: stesso dialogo se c'è, stato se no. */
export async function checkNow(): Promise<{ current: string; available: boolean; version: string | null; error?: string }> {
  const current = app.getVersion()
  try {
    const result = await au().checkForUpdates()
    const version = result?.updateInfo?.version ?? null
    // update-available apre il dialogo sia dal check automatico sia da qui
    return { current, available: version ? isNewerVersion(current, version) : false, version }
  } catch (error) {
    return { current, available: false, version: null, error: error instanceof Error ? error.message : String(error) }
  }
}

