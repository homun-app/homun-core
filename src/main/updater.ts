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
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// electron-updater è CommonJS: l'import CON NOME non è rilevabile dal lexer
// CJS nel bundle (errori a runtime nell'app impacchettata) — si destruttura
// dal default export
import electronUpdater from 'electron-updater'
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import { allowPrereleaseFor, type UpdateChannel } from '../shared/update-channel'
import { mainStrings } from './i18n'
// RW (fase revisore sulla richiesta): le note delle release come testo semplice
import { releaseNotesText } from './release-notes-text'

// l'istanza si COSTRUISCE al primo accesso (getter del pacchetto) e serve
// l'app Electron: mai toccarla a import time, o vitest/node puro esplode.
// RQ2: la costruzione è iniettabile nei test — una spia che conta quante
// volte l'istanza NASCE è la prova che l'interruttore non la costruisce.
let auInstance: AppUpdater | null = null
let makeAu: () => AppUpdater = () => electronUpdater.autoUpdater
function au(): AppUpdater {
  auInstance ??= makeAu()
  return auInstance
}

/**
 * RQ2 (fase rilascio di prova — correzioni): l'updater è ATTIVO solo se
 * initUpdater è stato chiamato (app impacchettata col feed, fuori dalle
 * prove). Le condizioni NON si ricalcolano qui (A8/K6 le ha già decise in
 * index.ts): chi accende l'updater è initUpdater, e solo lui.
 */
let updaterActive = false

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
 * RQ2: senza updater iniettato, l'istanza nasce SOLO se l'updater è attivo
 * (initUpdater chiamato): nelle build --dir e con le SANDBOT_TEST_* qui non
 * si costruisce NIENTE (A8, K6).
 */
export function applyUpdateChannel(
  channel: UpdateChannel,
  getVersion: () => string = () => app.getVersion(),
  updater: { allowPrerelease: boolean } | null = updaterActive ? au() : null
): void {
  if (!updater) return
  updater.allowPrerelease = allowPrereleaseFor(channel, getVersion())
}

/**
 * RQ2 (fase rilascio di prova — correzioni): l'interruttore delle
 * Impostazioni («Ricevi le versioni di prova», IPC updater:set-channel).
 * Il setting si salva SEMPRE; l'effetto immediato sul updater SOLO se
 * esiste — initUpdater chiamato. Nelle build --dir e con le SANDBOT_TEST_*
 * l'istanza di electron-updater non deve NASCERE qui: si salva il canale e
 * varrà dal primo controllo della prossima build col feed.
 */
export function setUpdateChannel(
  channel: UpdateChannel,
  save: (channel: UpdateChannel) => unknown,
  getVersion: () => string = () => app.getVersion()
): unknown {
  if (updaterActive) applyUpdateChannel(channel, getVersion)
  return save(channel)
}

/**
 * Solo per i test (RQ2): inietta la costruzione dell'istanza di
 * electron-updater e azzera istanza e flag — ogni prova parte dall'updater
 * SPENTO, come una build --dir o con le variabili SANDBOT_TEST_*.
 */
export function injectUpdaterForTests(make?: () => AppUpdater): void {
  makeAu = make ?? (() => electronUpdater.autoUpdater)
  auInstance = null
  updaterActive = false
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

/**
 * Le note del dialogo in TESTO SEMPLICE (RW): con il provider GitHub arrivano
 * come HTML e si vedevano i tag grezzi. La stringa vuota resta il ripiego.
 * Esportata per i test (pura rispetto a info).
 */
export function notesOf(info: UpdateInfo | undefined): string {
  const raw = info?.releaseNotes
  if (!raw) return mainStrings().updater.availableBody
  const more = mainStrings().updater.notesMore
  if (typeof raw === 'string') return releaseNotesText(raw, more)
  // ReleaseNoteInfo: solo il testo, niente HTML grezzo
  const note = raw as { note?: string }
  return note.note ? releaseNotesText(note.note, more) : mainStrings().updater.availableBody
}

// ---- B1 (fase beta.4): il dialogo diventa una finestra di Homun ----
// L'NSAlert nativo era stretto (~260 pt), senza scorrimento: con le note
// lunghe cresceva oltre lo schermo e i bottoni finivano fuori. La finestra
// dell'offerta è della stessa famiglia della finestra d'avanzamento
// (createUpdateProgressWindow): HTML autonomo, niente Node nel renderer,
// lingua dell'interfaccia. Le note sono TESTO SEMPLICE (textContent, mai
// HTML), l'area scorre e i TRE bottoni restano FISSI in fondo.

/** Le misure massime della finestra dell'offerta (pt). */
export const UPDATE_OFFER_WINDOW_SIZE = { width: 460, height: 520 } as const

/**
 * Le opzioni della finestra dell'offerta (PURO, per i test): piccola, NON
 * ridimensionabile, centrata, senza Node nel renderer.
 */
export function updateOfferWindowOptions(): {
  width: number
  height: number
  resizable: boolean
  minimizable: boolean
  maximizable: boolean
  fullscreenable: boolean
  center: boolean
  show: boolean
  autoHideMenuBar: boolean
  webPreferences: { sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean }
} {
  return {
    width: UPDATE_OFFER_WINDOW_SIZE.width,
    height: UPDATE_OFFER_WINDOW_SIZE.height,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  }
}

/**
 * BC1 (fase beta.4 — correzioni): l'escape HTML di versioni e testi che
 * finiscono nella pagina (la VERSIONE arriva dal feed: non è fidata). PURO.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * La pagina dell'offerta (PURO, per i test): titolo, note che scorrono, TRE
 * bottoni fissi in fondo. Le NOTE non stanno nella pagina: arrivano dopo con
 * textContent (updateOfferNotesScript). Nessuno script, nessuna risorsa
 * esterna: CSP default-src 'none'. BC1: versione ed etichette passano
 * dall'escape HTML (escapeHtml) — la versione arriva dal feed.
 */
export function buildUpdateOfferPage(
  s: { availableTitle: string; download: string; openNotes: string; later: string },
  version: string,
  dark: boolean
): string {
  const bg = dark ? '#1e1e20' : '#ffffff'
  const fg = dark ? '#f2f2f2' : '#1d1d1f'
  const muted = dark ? 'rgba(235,235,245,.6)' : 'rgba(60,60,67,.6)'
  const border = dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.12)'
  const btnBg = dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.06)'
  // la sostituzione usa una FUNZIONE: un «$&» nella versione non si
  // interpreterebbe come pattern di replace
  const title = escapeHtml(s.availableTitle.replace('{version}', () => version))
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>${title}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  html, body { height: 100%; box-sizing: border-box; }
  body { font: 13px -apple-system, system-ui, sans-serif; margin: 0; padding: 18px 20px 16px;
         display: flex; flex-direction: column; cursor: default;
         background: ${bg}; color: ${fg}; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 12px; }
  #upd-notes { flex: 1; min-height: 0; overflow-y: auto; white-space: pre-wrap;
               font-size: 12px; line-height: 1.55; color: ${muted};
               border-top: 1px solid ${border}; border-bottom: 1px solid ${border};
               padding: 10px 2px; }
  footer { display: flex; gap: 8px; justify-content: flex-end; padding-top: 14px; }
  footer button { font: inherit; font-size: 13px; padding: 7px 14px; border: 0;
                  border-radius: 8px; background: ${btnBg}; color: ${fg}; cursor: pointer; }
  footer button#upd-download { background: #4f7942; color: #fff; font-weight: 600; }
</style></head>
<body>
  <h1>${title}</h1>
  <div id="upd-notes"></div>
  <footer>
    <button type="button" id="upd-download">${escapeHtml(s.download)}</button>
    <button type="button" id="upd-open-notes">${escapeHtml(s.openNotes)}</button>
    <button type="button" id="upd-later">${escapeHtml(s.later)}</button>
  </footer>
</body></html>`
}

/**
 * Lo script che mette le NOTE nella pagina (PURO, per i test): textContent,
 * MAI innerHTML — il testo può contenere quello che vuole, resta testo.
 */
export function updateOfferNotesScript(notes: string): string {
  return `document.getElementById('upd-notes').textContent = ${JSON.stringify(notes)}`
}

/**
 * BC1 (fase beta.4 — correzioni): il piano di ogni azione della finestra
 * dell'offerta (PURO, per i test). «Scarica e installa» chiude la finestra
 * DOPO aver chiamato l'azione (parte la finestra d'avanzamento di sempre: la
 * modale non ha più motivo di esistere); «Apri le note» la lascia aperta;
 * «Più tardi» e i valori sconosciuti chiudono senza azioni.
 */
export function offerWindowAction(action: string): { run: boolean; close: boolean } {
  if (action === 'download') return { run: true, close: true }
  if (action === 'notes') return { run: true, close: false }
  return { run: false, close: true }
}

/**
 * BC1 (fase beta.4 — correzioni): una SOLA finestra dell'offerta alla volta
 * (PURO, per i test). Con un download in corso non si offre niente (come
 * oggi); se la finestra è già aperta la si PORTA IN PRIMO PIANO invece di
 * crearne un'altra — il secondo «Controlla aggiornamenti» non apre più due
 * finestre (l'NSAlert sincrono di prima lo impediva da solo).
 */
export function offerWindowPlan(state: { downloading: boolean; offerOpen: boolean }): 'skip' | 'focus' | 'create' {
  if (state.downloading) return 'skip'
  return state.offerOpen ? 'focus' : 'create'
}

/** BC1: la finestra dell'offerta APERTA (il registro: una sola alla volta). */
let offerWin: BrowserWindow | null = null

/**
 * La finestra dell'offerta: modale sulla finestra principale (se c'è), nota e
 * bottoni come buildUpdateOfferPage. I bottoni non navigano davvero: fanno un
 * assign su uno schema privato che il main intercetta (will-navigate) — così
 * la pagina resta senza script, senza Node e senza rete. Chiudere la finestra
 * equivale a «Più tardi». BC1: l'azione passa da offerWindowAction («Scarica
 * e installa» chiude DOPO onDownload) e la finestra si registra nel registro
 * delle offerte aperte.
 */
function createUpdateOfferWindow(
  version: string,
  notes: string,
  actions: { onDownload(): void; onOpenNotes(): void }
): void {
  const s = mainStrings().updater
  const parent = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w !== offerWin)
  const win = new BrowserWindow({
    ...updateOfferWindowOptions(),
    title: s.availableTitle.replace('{version}', version),
    ...(parent ? { parent, modal: true } : {})
  })
  offerWin = win
  win.once('closed', () => { if (offerWin === win) offerWin = null })
  const dark = nativeTheme.shouldUseDarkColors
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildUpdateOfferPage(s, version, dark)))
  const ACTION_SCHEME = 'sandbot-update-action:'
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ACTION_SCHEME)) return
    event.preventDefault()
    const action = url.slice(ACTION_SCHEME.length)
    const plan = offerWindowAction(action)
    if (plan.run) {
      if (action === 'download') actions.onDownload()
      if (action === 'notes') actions.onOpenNotes()
    }
    if (plan.close && !win.isDestroyed()) win.close()
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.once('did-finish-load', () => {
    const bind = `(() => {
      ${updateOfferNotesScript(notes)}
      const go = (a) => { location.assign('${ACTION_SCHEME}' + a) }
      document.getElementById('upd-download').addEventListener('click', () => go('download'))
      document.getElementById('upd-open-notes').addEventListener('click', () => go('notes'))
      document.getElementById('upd-later').addEventListener('click', () => window.close())
      return true
    })()`
    void win.webContents.executeJavaScript(bind).catch(() => undefined)
  })
}

function offerUpdate(info: UpdateInfo | undefined): void {
  if (!info?.version) return
  // BC1: una sola finestra alla volta — aperta → in primo piano, download in
  // corso → niente (come oggi)
  const plan = offerWindowPlan({ downloading, offerOpen: !!offerWin && !offerWin.isDestroyed() })
  if (plan === 'skip') return
  if (plan === 'focus') {
    offerWin?.focus()
    return
  }
  createUpdateOfferWindow(info.version, notesOf(info), {
    onDownload: () => startDownload(info.version!),
    onOpenNotes: () => { void shell.openExternal(`${RELEASES_URL}/tag/v${info.version}`) }
  })
}

// ---- B1.4: il gancio di prova delle sonde (solo con SANDBOT_TEST_USER_DATA) ----

/** La versione FINTA della finestra di prova (mai controllata su GitHub). */
export const TEST_UPDATE_VERSION = '0.3.1001-beta.4'

/**
 * Il gancio (PURO, per i test): con SANDBOT_TEST_USER_DATA e
 * SANDBOT_TEST_UPDATE_NOTES=<file> la finestra dell'offerta si apre con la
 * versione finta e le note di quel file. Senza SANDBOT_TEST_USER_DATA la
 * variabile è IGNORATA: fuori dalle prove non esiste.
 */
export function testUpdateOfferFromEnv(env: NodeJS.ProcessEnv): { version: string; notesFile: string } | null {
  if (!env.SANDBOT_TEST_USER_DATA) return null
  const notesFile = env.SANDBOT_TEST_UPDATE_NOTES
  if (!notesFile) return null
  return { version: TEST_UPDATE_VERSION, notesFile }
}

/**
 * All'avvio (chiamato da index.ts): apre la finestra dell'offerta col gancio
 * di prova, SENZA controllare GitHub. I bottoni non fanno nulla qui: nelle
 * prove niente download e niente browser. True se la finestra è partita.
 */
export function openTestUpdateWindowIfRequested(): boolean {
  const t = testUpdateOfferFromEnv(process.env)
  if (!t) return false
  let raw = ''
  try {
    raw = readFileSync(t.notesFile, 'utf8')
  } catch (error) {
    console.error('[updater] SANDBOT_TEST_UPDATE_NOTES non leggibile:', error instanceof Error ? error.message : error)
    return false
  }
  const s = mainStrings().updater
  createUpdateOfferWindow(t.version, releaseNotesText(raw, s.notesMore), {
    // prove: nessuna azione vera (niente download, niente browser)
    onDownload: () => undefined,
    onOpenNotes: () => undefined
  })
  return true
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
  // RQ2: da qui l'updater ESISTE — l'unico punto che accende il flag (le
  // condizioni per arrivarci le ha decise index.ts con A8/K6, mai ricalcolate)
  updaterActive = true
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

