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
//
// FASE RILASCIO DI PROVA (RP3): il canale degli aggiornamenti (setting
// updates.channel, «Ricevi le versioni di prova» in Impostazioni › Generali)
// decide allowPrerelease: il canale stabile non vede MAI le prerelease (come
// Homun 2), quello di prova sì — e una beta in esecuzione le vede comunque,
// finché non arriva la stabile (più nuova per semver). Si applica al primo
// controllo, a ogni «Controlla aggiornamenti» e quando l'interruttore cambia:
// nessun riavvio richiesto.
import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
// electron-updater è CommonJS: l'import CON NOME non è rilevabile dal lexer
// CJS nel bundle (errori a runtime nell'app impacchettata) — si destruttura
// dal default export
import electronUpdater from 'electron-updater'
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import { allowPrereleaseFor, type UpdateChannel } from '../shared/update-channel'
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
 * K6 (fase rilascio — correzioni): il file di configurazione del feed c'è?
 * Le build `--dir` (release:local) non hanno Resources/app-update.yml:
 * controllare il feed produce solo un ENOENT nel log. Puro, con il percorso
 * e l'esistenza iniettabili per i test.
 */
export function hasUpdateConfig(
  resourcesPath: string = (globalThis.process?.resourcesPath ?? ''),
  exists: (p: string) => boolean = existsSync
): boolean {
  if (!resourcesPath) return false
  return exists(join(resourcesPath, 'app-update.yml'))
}

/**
 * Puro (A8): il controllo automatico è ammesso solo nell'app impacchettata,
 * mai in sviluppo e mai quando c'è una variabile SANDBOT_TEST_* (le prove con
 * dati temporanei non devono nemmeno pensare alla rete). K6: e mai quando
 * manca app-update.yml (build `--dir`): niente controllo, niente errore.
 */
export function shouldAutoCheckUpdates(isPackaged: boolean, env: NodeJS.ProcessEnv, updateConfigExists = true): boolean {
  if (!isPackaged) return false
  if (!updateConfigExists) return false
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

/**
 * Confronto x.y.z(−pre) senza dipendere da semver, COERENTE con quello che fa
 * electron-updater (semver.gt): RP3 conta il pre-release — 0.3.1001-beta.1
 * < 0.3.1001-beta.2 < 0.3.1001 — così chi prova una beta riceve la beta
 * dopo e poi la stabile.
 */
class semverLike {
  private readonly parts: number[]
  private readonly pre: Array<number | string> | null
  constructor(v: string) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
    if (!m) throw new Error(`invalid version: ${v}`)
    this.parts = [Number(m[1]), Number(m[2]), Number(m[3])]
    this.pre = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : null
  }
  compare(other: string): number {
    const o = new semverLike(other)
    for (let i = 0; i < 3; i++) {
      if (this.parts[i]! < o.parts[i]!) return -1
      if (this.parts[i]! > o.parts[i]!) return 1
    }
    // stesso x.y.z: senza pre-release è PIÙ grande (1.0.0 > 1.0.0-beta.9)
    if (this.pre === null) return o.pre === null ? 0 : 1
    if (o.pre === null) return -1
    for (let i = 0; i < Math.max(this.pre.length, o.pre.length); i++) {
      const a = this.pre[i]
      const b = o.pre[i]
      if (a === undefined) return -1 // identificatori in meno = più piccolo
      if (b === undefined) return 1
      if (a === b) continue
      if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1
      if (typeof a === 'number') return -1 // numerico < alfanumerico
      if (typeof b === 'number') return 1
      return a < b ? -1 : 1 // ASCII
    }
    return 0
  }
}

/**
 * RP3: applica il canale al updater (iniettabile per i test). Il canale di
 * prova accende allowPrerelease; una beta in esecuzione lo tiene acceso
 * anche a canale stabile. Immediata: niente riavvio.
 */
export function applyUpdateChannel(
  channel: UpdateChannel,
  getVersion: () => string = () => app.getVersion(),
  updater: { allowPrerelease: boolean } = au()
): void {
  updater.allowPrerelease = allowPrereleaseFor(channel, getVersion())
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

export function initUpdater(getChannel: () => Promise<UpdateChannel> = async () => 'stable'): void {
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
  // RP3: il canale (updates.channel) decide allowPrerelease PRIMA del primo
  // controllo; la lettura non blocca mai l'avvio (daemon giù → canale stabile)
  void getChannel()
    .then((channel) => applyUpdateChannel(channel))
    .catch(() => undefined)
    .then(() => au().checkForUpdates())
    .catch((error: unknown) => {
      console.error('[updater] controllo fallito:', error instanceof Error ? error.message : error)
    })
  if (checkTimer) clearInterval(checkTimer)
  checkTimer = setInterval(() => {
    void au().checkForUpdates().catch(() => undefined)
  }, CHECK_INTERVAL_MS)
  checkTimer.unref()
}

/** Controllo manuale dalle Impostazioni: stesso dialogo se c'è, stato se no. */
export async function checkNow(getChannel?: () => Promise<UpdateChannel>): Promise<{ current: string; available: boolean; version: string | null; error?: string }> {
  const current = app.getVersion()
  // RP3: anche qui il canale si applica PRIMA del controllo (l'interruttore
  // delle Impostazioni ha effetto immediato, senza riavvio)
  if (getChannel) await getChannel().then((channel) => applyUpdateChannel(channel)).catch(() => undefined)
  try {
    const result = await au().checkForUpdates()
    const version = result?.updateInfo?.version ?? null
    // update-available apre il dialogo sia dal check automatico sia da qui
    return { current, available: version ? isNewerVersion(current, version) : false, version }
  } catch (error) {
    return { current, available: false, version: null, error: error instanceof Error ? error.message : String(error) }
  }
}

