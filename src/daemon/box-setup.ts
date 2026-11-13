// OB1 (fase onboarding-b): la preparazione del computer del bot, nel daemon
// — una MACCHINA A STATI RIPRENDIBILE. Il riduttore boxSetupNext è PURO
// (transizioni, ripresa da ogni fase, annullamento); l'esecutore ha TUTTE
// le dipendenze iniettabili (download, hash, pkgutil, spctl, apertura
// dell'Installer, sonde del motore, system start, kernel, build
// dell'immagine): nei test nessuno spawn e nessuna rete. Lo stato vive nel
// setting `box.setup`: un riavvio dell'app riprende da dove si era (il
// download col Range, l'attesa dell'Installer col sondaggio).
//
// L'installazione vera è la finestra di Apple (scelta (a) della spec):
// `/usr/bin/open -a Installer` sul pacchetto VERIFICATO (dimensione, sha256, pkgutil,
// spctl — nell'ordine; UNO solo che fallisce → errore in parole, file
// cancellato, NESSUN open). Homun non ottiene mai una shell di root: la
// password la chiede il processo di sistema di Apple. La riga del
// certificato foglia di pkgutil si SALVA nel log, non si confronta con un
// valore indovinato (il Team ID lo fissa l'utente dopo la prova dal vivo).
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync, unlinkSync, renameSync, mkdirSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { basename, dirname, join } from 'node:path'
import type { AppleEngineState, CliRunResult } from '../main/sandbox/engine'
import {
  APPLE_CONTAINER_PKG_URL, APPLE_CONTAINER_PKG_BYTES, APPLE_CONTAINER_PKG_SHA256
} from '../main/sandbox/apple-container-release'
import { BOX_BUILD_ESTIMATED_BYTES, DISK_MARGIN_BYTES, enoughDiskSpace } from '../main/sandbox/disk-space'
import { appleSystemStartArgv, appleKernelSetRecommendedArgv } from '../main/sandbox/apple-container-argv'
// OBR1: gli strumenti di sistema si chiamano col PERCORSO ASSOLUTO
import { SYSTEM_PKGUTIL, SYSTEM_SPCTL, SYSTEM_OPEN } from '../main/sandbox/system-tools'
import { isPackagedRuntime } from '../shared/packaged'
import { uiText } from '../main/ui-language'
import { UI } from '../shared/ui-messages'
import type { UiMessageDescriptor } from '../shared/ui-text'
import type { BoxSetupPhase, BoxSetupState, SandbotEvent } from '../shared/types'

// i tipi condivisi restano raggiungibili anche da qui (il contratto della UI)
export type { BoxSetupPhase, BoxSetupState } from '../shared/types'

/** Il setting dove vive lo stato della preparazione (persistito). */
export const BOX_SETUP_SETTING = 'box.setup'

/**
 * La stima del kernel (PURa): ~1 GB, come dice il testo del consenso del
 * kernel di BX4 («Verrà scaricato da Apple (circa 1 GB)»).
 */
export const KERNEL_ESTIMATED_BYTES = 1_000_000_000

/**
 * La stima dello spazio che serve (PURa): pacchetto + installazione (il
 * pacchetto si scarica E si installa in /usr/local, circa la stessa
 * dimensione) + kernel + immagine. L'immagine con la sua cache di build è
 * BOX_BUILD_ESTIMATED_BYTES (1,5 GB: immagine ~1,18 GB + cache ~1,15 GB — i
 * numeri del df della CLI finta nel REPORT di box-container). NIENTE
 * numeri inventati: i «circa N GB» dei testi si calcolano da qui.
 */
export function boxSetupNeededBytes(): number {
  return APPLE_CONTAINER_PKG_BYTES * 2 + KERNEL_ESTIMATED_BYTES + BOX_BUILD_ESTIMATED_BYTES
}

/** Lo stato iniziale (con la stima dello spazio già calcolata, per la UI). */
export const INITIAL_BOX_SETUP: BoxSetupState = {
  phase: 'idle',
  bytes: null,
  total: null,
  buildPhase: null,
  error: null,
  startedAt: null,
  neededBytes: boxSetupNeededBytes()
}

// ---- le funzioni PURA ----

export type BoxSetupEvent =
  | { type: 'started'; phase: BoxSetupPhase; at: number }
  | { type: 'space-ok' }
  | { type: 'space-no'; message: string }
  | { type: 'download-begin'; total: number }
  | { type: 'download-progress'; bytes: number; total: number }
  | { type: 'download-done' }
  | { type: 'download-fail'; message: string }
  | { type: 'verify-fail'; code: 'size' | 'sha256' | 'signature' | 'gatekeeper'; message: string }
  | { type: 'installer-opened' }
  | { type: 'installer-open-fail'; message: string }
  | { type: 'installed' }
  | { type: 'service-ok' }
  | { type: 'service-fail'; message: string }
  | { type: 'kernel-ok' }
  | { type: 'kernel-fail'; message: string }
  | { type: 'image-building'; buildPhase: string | null }
  | { type: 'image-ok' }
  | { type: 'image-fail'; message: string }
  | { type: 'cancel' }
  | { type: 'retry' }

const CLEAN: Pick<BoxSetupState, 'bytes' | 'total' | 'buildPhase' | 'error'> = { bytes: null, total: null, buildPhase: null, error: null }

/**
 * Il riduttore (PURO): ogni evento vale SOLO dalla fase che lo aspetta — un
 * evento fuori posto non cambia nulla. I fallimenti diventano `error` con la
 * fase di colpa, il codice e il messaggio in parole già pronto per la UI.
 */
export function boxSetupNext(state: BoxSetupState, event: BoxSetupEvent): BoxSetupState {
  switch (event.type) {
    case 'started':
      return { ...state, ...CLEAN, phase: event.phase, startedAt: event.at }
    case 'space-ok':
      return state.phase === 'checking-space' ? { ...state, ...CLEAN, phase: 'downloading' } : state
    case 'space-no':
      return state.phase === 'checking-space'
        ? { ...state, phase: 'error', error: { phase: 'checking-space', code: 'no-space', message: event.message } }
        : state
    case 'download-begin':
      return state.phase === 'downloading' ? { ...state, bytes: 0, total: event.total } : state
    case 'download-progress':
      return state.phase === 'downloading' ? { ...state, bytes: event.bytes, total: event.total } : state
    case 'download-done':
      return state.phase === 'downloading' ? { ...state, ...CLEAN, phase: 'verifying' } : state
    case 'download-fail':
      return state.phase === 'downloading'
        ? { ...state, phase: 'error', error: { phase: 'downloading', code: 'download', message: event.message } }
        : state
    case 'verify-fail':
      return state.phase === 'verifying'
        ? { ...state, phase: 'error', error: { phase: 'verifying', code: event.code, message: event.message } }
        : state
    case 'installer-opened':
      return state.phase === 'verifying' ? { ...state, ...CLEAN, phase: 'awaiting-installer' } : state
    case 'installer-open-fail':
      return state.phase === 'verifying'
        ? { ...state, phase: 'error', error: { phase: 'verifying', code: 'open', message: event.message } }
        : state
    case 'installed':
      return state.phase === 'awaiting-installer' ? { ...state, ...CLEAN, phase: 'starting-service' } : state
    case 'service-ok':
      return state.phase === 'starting-service' ? { ...state, ...CLEAN, phase: 'installing-kernel' } : state
    case 'service-fail':
      return state.phase === 'starting-service'
        ? { ...state, phase: 'error', error: { phase: 'starting-service', code: 'service', message: event.message } }
        : state
    case 'kernel-ok':
      return state.phase === 'installing-kernel' ? { ...state, ...CLEAN, phase: 'building-image' } : state
    case 'kernel-fail':
      return state.phase === 'installing-kernel'
        ? { ...state, phase: 'error', error: { phase: 'installing-kernel', code: 'kernel', message: event.message } }
        : state
    case 'image-building':
      return state.phase === 'building-image' ? { ...state, buildPhase: event.buildPhase } : state
    case 'image-ok':
      return state.phase === 'building-image' ? { ...state, ...CLEAN, phase: 'ready' } : state
    case 'image-fail':
      return state.phase === 'building-image'
        ? { ...state, phase: 'error', error: { phase: 'building-image', code: 'image', message: event.message } }
        : state
    case 'cancel':
      // si annulla mentre la preparazione CORRE; sull'attesa dell'Installer
      // serve l'utente («Salta per ora»), ready/idle/error non si annullano
      return ['checking-space', 'downloading', 'verifying', 'starting-service', 'installing-kernel', 'building-image'].includes(state.phase)
        ? { ...state, ...CLEAN, phase: 'cancelled' }
        : state
    case 'retry':
      return state.phase === 'error' || state.phase === 'cancelled'
        ? { ...INITIAL_BOX_SETUP }
        : state
  }
}

/**
 * La partenza intelligente (PURa): lo stato REALE del motore decide da dove
 * cominciare — mai si rifà una fase già fatta. `ready` con immagine → si è
 * già pronti; `unsupported` → niente da preparare (null).
 */
export function boxSetupStartFrom(appleState: AppleEngineState, hasImage: boolean): BoxSetupPhase | null {
  switch (appleState) {
    case 'not-installed': return 'checking-space'
    case 'stopped': return 'starting-service'
    case 'kernel-missing': return 'installing-kernel'
    case 'ready': return hasImage ? 'ready' : 'building-image'
    default: return null
  }
}

/**
 * La ripresa dopo un riavvio (PURa): le fasi del download si RIDECIDONO col
 * motore di adesso (il .part si riprende col Range); Installer in attesa,
 * servizio, kernel e immagine ripartono da sé; gli stati fermi non fanno
 * nulla. null = nessuna corsa da riprendere.
 */
export function boxSetupResumeFrom(persisted: BoxSetupState, appleState: AppleEngineState, hasImage: boolean): BoxSetupPhase | null {
  switch (persisted.phase) {
    case 'checking-space':
    case 'downloading':
    case 'verifying':
      return boxSetupStartFrom(appleState, hasImage)
    case 'awaiting-installer':
    case 'starting-service':
    case 'installing-kernel':
    case 'building-image':
      return persisted.phase
    default:
      return null
  }
}

/** Il messaggio dello spazio insufficiente, coi GB calcolati (nessun numero a mano). */
export function boxSetupNoSpaceMessage(neededBytes: number, freeBytes: number | null): string {
  const needGb = Math.ceil((neededBytes + DISK_MARGIN_BYTES) / 1e9)
  const freeGb = freeBytes === null ? '?' : (freeBytes / 1e9).toFixed(1).replace('.', ',')
  return uiText(UI.boxSetupNoSpace, { needed: String(needGb), free: freeGb })
}

// ---- gli override di prova (OB1.9) ----

/** La configurazione della corsa: costanti vere, o gli override di prova. */
export interface BoxSetupRunConfig {
  url: string
  sha256: string
  sizeBytes: number
  /** il comando che apre l'Installer (`/usr/bin/open` in produzione) */
  openCmd: string
  pkgutilPath: string
  spctlPath: string
}

/**
 * Gli override arrivano SOLO da variabili SANDBOT_TEST_* e sono IGNORATI
 * nell'app impacchettata: lì valgono le costanti fissate, sempre. Con env
 * assurdi (dimensione non numerica) vale la costante, mai NaN. OBR1: i tre
 * strumenti di sistema hanno PERCORSI ASSOLUTI fissati (system-tools.ts),
 * mai un nome da cercare nel PATH.
 */
export function boxSetupRunConfig(env: NodeJS.ProcessEnv = process.env, packaged = isPackagedRuntime()): BoxSetupRunConfig {
  if (packaged) {
    return { url: APPLE_CONTAINER_PKG_URL, sha256: APPLE_CONTAINER_PKG_SHA256, sizeBytes: APPLE_CONTAINER_PKG_BYTES, openCmd: SYSTEM_OPEN, pkgutilPath: SYSTEM_PKGUTIL, spctlPath: SYSTEM_SPCTL }
  }
  const size = Number(env.SANDBOT_TEST_PKG_SIZE ?? '')
  return {
    url: env.SANDBOT_TEST_PKG_URL ?? APPLE_CONTAINER_PKG_URL,
    sha256: env.SANDBOT_TEST_PKG_SHA256 ?? APPLE_CONTAINER_PKG_SHA256,
    sizeBytes: Number.isFinite(size) && size > 0 ? size : APPLE_CONTAINER_PKG_BYTES,
    openCmd: env.SANDBOT_TEST_OPEN ?? SYSTEM_OPEN,
    pkgutilPath: env.SANDBOT_TEST_PKGUTIL ?? SYSTEM_PKGUTIL,
    spctlPath: env.SANDBOT_TEST_SPCTL ?? SYSTEM_SPCTL
  }
}

/**
 * Il parse di `pkgutil --check-signature` (PURO): firmato con un certificato
 * Developer ID di Apple E catena fidata. La riga del certificato FOGLIA
 * (nome e Team ID) si torna per il log — NON si confronta con un valore
 * indovinato: il Team ID lo fissa l'utente dopo la prova dal vivo.
 */
export function parsePkgutilCheckSignature(stdout: string): { signed: boolean; trusted: boolean; leaf: string | null } {
  const signed = /Status:\s*signed by a developer certificate issued by Apple/i.test(stdout)
  const trusted = /Trusted by the Apple notary service|Status:\s*trusted/i.test(stdout)
  const leaf = /^\s*1\.\s+(Developer ID Installer:.+)$/m.exec(stdout)?.[1]?.trim() ?? null
  return { signed, trusted, leaf }
}

// ---- il download (produzione; il fetch è iniettabile) ----

/** L'errore HTTP del download: la riprova automatica vale solo per la rete. */
export class DownloadHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

/**
 * Il download con ripresa (come quello del modello integrato): se il .part
 * esiste riparte col Range dal byte che c'è; 206 → si appende, 200 → si
 * ricomincia da zero. Ogni pezzo si scrive TUTTO e solo dopo si annuncia il
 * progresso (i byte detti sono i byte sul disco). Annullato (signal) il
 * .part RESTA: si riprende al tentativo dopo.
 */
export async function downloadPkg(opts: {
  fetch: typeof fetch
  url: string
  partPath: string
  onProgress(p: { bytes: number; total: number }): void
  signal: AbortSignal
}): Promise<void> {
  mkdirSync(dirname(opts.partPath), { recursive: true })
  const have = existsSync(opts.partPath) ? statSync(opts.partPath).size : 0
  const headers: Record<string, string> = {}
  if (have > 0) headers.range = `bytes=${have}-`
  const res = await opts.fetch(opts.url, { headers, signal: opts.signal })
  if (!res.ok) throw new DownloadHttpError(res.status)
  // 200 col Range chiesto: il server non consente la ripresa → da zero
  const resume = res.status === 206 && have > 0
  if (!resume && existsSync(opts.partPath)) unlinkSync(opts.partPath)
  const totalHeader = Number(res.headers.get('content-length') ?? 0)
  const total = resume ? have + totalHeader : totalHeader
  let bytes = resume ? have : 0
  const body = res.body ? Readable.fromWeb(res.body as never) : Readable.from([])
  const out = await openFile(opts.partPath, resume ? 'a' : 'w')
  try {
    for await (const chunk of body) {
      if (opts.signal.aborted) throw new Error('download cancelled')
      const piece = chunk as Buffer
      let written = 0
      while (written < piece.length) {
        const r = await out.write(piece, written, piece.length - written)
        written += r.bytesWritten
      }
      bytes += piece.length
      opts.onProgress({ bytes, total })
    }
  } catch (e) {
    await out.close().catch(() => undefined)
    if (opts.signal.aborted) throw new Error('download cancelled')
    throw e
  }
  await out.close()
  if (opts.signal.aborted) throw new Error('download cancelled')
}

// ---- l'esecutore ----

export interface BoxSetupDeps {
  now(): number
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  emit(e: SandbotEvent): void
  /** la sottocartella downloads/ della cartella dati (viene creata se manca) */
  downloadsDir(): string
  /** i byte liberi del disco dati (helper di disk-space.ts) */
  freeBytes(): number | null
  fetch: typeof fetch
  /** l'esecutore delle CLI (container, pkgutil, spctl): iniettabile */
  runCli(file: string, argv: string[], timeoutMs: number): Promise<CliRunResult>
  /** il percorso della CLI di Apple ADESSO (containerCliPath) */
  containerCli(): string
  /** lo stato del motore Apple in parole (la sonda dei fatti) */
  engineState(): Promise<AppleEngineState>
  /** l'immagine del box c'è già? */
  hasBoxImage(): Promise<boolean>
  /** la build dell'immagine in background (ensureBoxImage di oggi) */
  buildBoxImage(): Promise<boolean>
  /** apre l'Installer di macOS col pacchetto verificato */
  openInstaller(pkgPath: string): Promise<{ ok: boolean; error?: string }>
  /** una riga di log del daemon (qui finisce la stderr RIPULITA, mai in UI) */
  log(line: string): void
  /** la configurazione della corsa (default: gli override SANDBOT_TEST_*) */
  runConfig?(): BoxSetupRunConfig
  /** i tempi (produzione: sondaggio 2 s, timeout 30 minuti, riprova 2 s) */
  timings?: { pollInstallerMs?: number; downloadTimeoutMs?: number; networkRetryDelayMs?: number }
  /** chiamata quando la preparazione arriva a ready (la guida chiude il passo) */
  onReady?(): void
}

export interface BoxSetupController {
  /** lo stato corrente (persistito) */
  state(): BoxSetupState
  /** la partenza intelligente (non rifà una fase già fatta) */
  start(): Promise<BoxSetupState>
  cancel(): Promise<BoxSetupState>
  retry(): Promise<BoxSetupState>
  /** «Apri l'installazione» (su awaiting-installer) */
  openInstallerNow(): Promise<BoxSetupState>
  /** il riavvio del daemon: riprende una preparazione rimasta a metà */
  resumeAtBoot(): Promise<void>
}

/** Il nome del pacchetto dall'URL (ripulito): il file dentro downloads/. */
function pkgFileNameOf(url: string): string {
  const raw = basename(url || '') || 'container-installer.pkg'
  return raw.replace(/[^A-Za-z0-9._-]/g, '') || 'container-installer.pkg'
}

/** sha256 di un file (a stream: regge i 170 MB del pacchetto). */
async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** due AbortSignal in uno (annullamento + timeout del download). */
function linkSignals(...signals: AbortSignal[]): AbortSignal {
  const ctl = new AbortController()
  for (const s of signals) {
    if (s.aborted) { ctl.abort(); break }
    s.addEventListener('abort', () => ctl.abort(), { once: true })
  }
  return ctl.signal
}

/**
 * L'esecutore. UNA corsa alla volta: le chiamate mentre gira tornano lo
 * stato com'è. Ogni transizione passa dal riduttore, si persiste nel setting
 * e diventa evento `box-setup` verso la UI.
 */
export function createBoxSetup(deps: BoxSetupDeps): BoxSetupController {
  const timings = {
    pollInstallerMs: deps.timings?.pollInstallerMs ?? 2_000,
    downloadTimeoutMs: deps.timings?.downloadTimeoutMs ?? 30 * 60_000,
    networkRetryDelayMs: deps.timings?.networkRetryDelayMs ?? 2_000
  }
  const config = (): BoxSetupRunConfig => deps.runConfig?.() ?? boxSetupRunConfig()
  const pkgPath = (): string => join(deps.downloadsDir(), pkgFileNameOf(config().url))

  let state: BoxSetupState = readState()
  let running = false
  let cancelCtl: AbortController | null = null

  function readState(): BoxSetupState {
    const raw = deps.getSetting<BoxSetupState | null>(BOX_SETUP_SETTING, null)
    if (!raw || typeof raw !== 'object' || typeof raw.phase !== 'string') return { ...INITIAL_BOX_SETUP }
    return { ...INITIAL_BOX_SETUP, ...raw, error: raw.error ?? null }
  }

  function apply(event: BoxSetupEvent): BoxSetupState {
    const prev = state
    state = boxSetupNext(state, event)
    if (state !== prev) {
      deps.setSetting(BOX_SETUP_SETTING, state)
      deps.emit({ type: 'box-setup', setup: state })
    }
    return state
  }

  /** la sonda della CLI: c'è `container` adesso? (percorso + --version) */
  async function containerInstalled(): Promise<boolean> {
    const r = await deps.runCli(deps.containerCli(), ['--version'], 5_000).catch(() => null)
    return !!r && r.exitCode === 0
  }

  async function checkSpace(): Promise<void> {
    const need = boxSetupNeededBytes()
    const free = deps.freeBytes()
    if (enoughDiskSpace(free, need).ok) {
      apply({ type: 'space-ok' })
      return
    }
    apply({ type: 'space-no', message: boxSetupNoSpaceMessage(need, free) })
  }

  async function download(): Promise<void> {
    const cfg = config()
    const partPath = `${pkgPath()}.part`
    const downloadCtl = new AbortController()
    cancelCtl = downloadCtl
    // timeout complessivo ragionevole (30 minuti); l'annullamento è dell'utente
    const timeoutCtl = new AbortController()
    const timer = setTimeout(() => timeoutCtl.abort(), timings.downloadTimeoutMs)
    const signal = linkSignals(downloadCtl.signal, timeoutCtl.signal)
    try {
      const total = cfg.sizeBytes
      apply({ type: 'download-begin', total })
      const attempt = (): Promise<void> =>
        downloadPkg({
          fetch: deps.fetch,
          url: cfg.url,
          partPath,
          onProgress: (p) => { apply({ type: 'download-progress', bytes: p.bytes, total: p.total || total }) },
          signal
        })
      try {
        await attempt()
      } catch (e) {
        // UNA riprova automatica, SOLO sugli errori di rete (fetch caduto o
        // HTTP 5xx): il resto va all'utente in parole
        const network = e instanceof DownloadHttpError ? e.status >= 500 : e instanceof TypeError
        if (signal.aborted || !network) throw e
        deps.log(`[box-setup] download ritentato dopo un errore di rete: ${e instanceof Error ? e.message : String(e)}`)
        await sleep(timings.networkRetryDelayMs)
        await attempt()
      }
      if (signal.aborted) throw new Error('download cancelled')
      apply({ type: 'download-done' })
    } catch (e) {
      if (downloadCtl.signal.aborted) {
        apply({ type: 'cancel' })
        return
      }
      if (timeoutCtl.signal.aborted) {
        apply({ type: 'download-fail', message: uiText(UI.boxSetupDownloadTimeout) })
        return
      }
      apply({ type: 'download-fail', message: uiText(UI.boxSetupDownloadFailed) })
      deps.log(`[box-setup] download non riuscito: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(timer)
      cancelCtl = null
    }
  }

  /** La verifica, NELL'ORDINE; UNA che fallisce → errore, file cancellato, NESSUN open. */
  async function verify(): Promise<boolean> {
    const cfg = config()
    const partPath = `${pkgPath()}.part`
    const fail = (code: 'size' | 'sha256' | 'signature' | 'gatekeeper', m: UiMessageDescriptor, detail: string): boolean => {
      try { unlinkSync(partPath) } catch { /* già via */ }
      apply({ type: 'verify-fail', code, message: uiText(m) })
      deps.log(`[box-setup] verifica non riuscita (${code}): ${detail}`)
      return false
    }
    // 1. dimensione esatta
    let size = 0
    try { size = statSync(partPath).size } catch { /* il file non c'è: dimensione sbagliata */ }
    if (size !== cfg.sizeBytes) return fail('size', UI.boxSetupVerifySize, `attesi ${cfg.sizeBytes} byte, trovati ${size}`)
    // 2. sha256 esatto, rispetto alla costante
    const sha = await sha256OfFile(partPath).catch(() => null)
    if (sha !== cfg.sha256) return fail('sha256', UI.boxSetupVerifySha, `atteso ${cfg.sha256}, calcolato ${sha ?? 'errore di lettura'}`)
    // 3. pkgutil --check-signature: firmato con Developer ID di Apple, catena fidata
    const pkgutil = await deps.runCli(cfg.pkgutilPath, ['--check-signature', partPath], 30_000).catch(() => null)
    const parsed = parsePkgutilCheckSignature(pkgutil?.stdout ?? '')
    if (!pkgutil || pkgutil.exitCode !== 0 || !parsed.signed || !parsed.trusted) {
      return fail('signature', UI.boxSetupVerifySignature, pkgutil ? `exit ${pkgutil.exitCode}: ${(pkgutil.stdout || pkgutil.stderr).slice(0, 300)}` : 'spawn non riuscito')
    }
    // la FOGLIA nel log (nome e Team ID): il confronto lo fissa l'utente dal vivo
    if (parsed.leaf) deps.log(`[box-setup] pacchetto firmato da: ${parsed.leaf}`)
    // 4. spctl --assess --type install: accettato
    const spctl = await deps.runCli(cfg.spctlPath, ['--assess', '--type', 'install', partPath], 30_000).catch(() => null)
    if (!spctl || spctl.exitCode !== 0) {
      return fail('gatekeeper', UI.boxSetupVerifyGatekeeper, spctl ? `exit ${spctl.exitCode}: ${(spctl.stderr || '').slice(0, 300)}` : 'spawn non riuscito')
    }
    // tutto verificato: il .part diventa il pacchetto
    renameSync(partPath, pkgPath())
    return true
  }

  async function openInstaller(): Promise<void> {
    const r = await deps.openInstaller(pkgPath())
    if (!r.ok) {
      apply({ type: 'installer-open-fail', message: uiText(UI.boxSetupInstallerOpenFailed) })
      deps.log(`[box-setup] apertura dell'Installer non riuscita: ${r.error ?? ''}`)
      return
    }
    apply({ type: 'installer-opened' })
  }

  /**
   * L'attesa dell'utente: l'Installer è aperto, si sonda ogni ~2 s se la
   * CLI è comparsa. SESSUN timeout: se l'utente chiude senza installare si
   * resta qui («Riapri l'installazione»); un riavvio dell'app riprende.
   */
  async function awaitInstaller(): Promise<void> {
    while (state.phase === 'awaiting-installer') {
      await sleep(timings.pollInstallerMs)
      if (state.phase !== 'awaiting-installer') return
      if (await containerInstalled()) {
        // installato: il pacchetto si cancella e si passa al servizio
        try { unlinkSync(pkgPath()) } catch { /* già via */ }
        apply({ type: 'installed' })
        return
      }
    }
  }

  async function startService(): Promise<void> {
    const r = await deps.runCli(deps.containerCli(), appleSystemStartArgv(), 120_000).catch(() => null)
    if (!r || r.exitCode !== 0) {
      if (r?.stderr) deps.log(`[box-setup] system start stderr: ${firstLine(r.stderr)}`)
      apply({ type: 'service-fail', message: uiText(UI.boxSetupServiceFailed) })
      return
    }
    apply({ type: 'service-ok' })
  }

  async function installKernel(): Promise<void> {
    const r = await deps.runCli(deps.containerCli(), appleKernelSetRecommendedArgv(), 300_000).catch(() => null)
    if (!r || r.exitCode !== 0) {
      if (r?.stderr) deps.log(`[box-setup] kernel set stderr: ${firstLine(r.stderr)}`)
      apply({ type: 'kernel-fail', message: uiText(UI.boxSetupKernelFailed) })
      return
    }
    apply({ type: 'kernel-ok' })
  }

  async function buildImage(): Promise<void> {
    // il build può durare MINUTI: l'utente può andare avanti nella guida
    apply({ type: 'image-building', buildPhase: null })
    const ok = await deps.buildBoxImage()
    if (state.phase !== 'building-image') return // annullato mentre costruiva
    if (!ok) {
      apply({ type: 'image-fail', message: uiText(UI.boxSetupImageFailed) })
      return
    }
    apply({ type: 'image-ok' })
    deps.onReady?.()
  }

  /** il ciclo: una fase dopo l'altra finché non si ferma da sola */
  async function loop(): Promise<BoxSetupState> {
    for (;;) {
      switch (state.phase) {
        case 'checking-space': await checkSpace(); break
        case 'downloading': await download(); break
        case 'verifying':
          if (await verify()) await openInstaller()
          break
        case 'awaiting-installer': await awaitInstaller(); break
        case 'starting-service': await startService(); break
        case 'installing-kernel': await installKernel(); break
        case 'building-image': await buildImage(); break
        case 'ready':
          deps.onReady?.()
          return state
        default:
          return state
      }
    }
  }

  /** la decisione della partenza: lo stato del motore, non quello salvato */
  async function decideStart(): Promise<BoxSetupPhase | null> {
    const [appleState, hasImage] = await Promise.all([
      deps.engineState().catch(() => 'unsupported' as AppleEngineState),
      deps.hasBoxImage().catch(() => false)
    ])
    return boxSetupStartFrom(appleState, hasImage)
  }

  return {
    state: () => state,
    async start(): Promise<BoxSetupState> {
      if (running) return state
      const startFrom = await decideStart()
      if (!startFrom) return state
      if (startFrom === 'ready' && state.phase === 'ready') return state
      running = true
      try {
        apply({ type: 'started', phase: startFrom, at: deps.now() })
        return await loop()
      } finally {
        running = false
      }
    },
    async cancel(): Promise<BoxSetupState> {
      cancelCtl?.abort()
      apply({ type: 'cancel' }) // il riduttore la accetta solo dove ha senso
      // se un ciclo è in corsa gli si lascia il tempo di vederla
      for (let i = 0; i < 1_000 && running; i++) await sleep(10)
      return state
    },
    async retry(): Promise<BoxSetupState> {
      if (state.phase !== 'error' && state.phase !== 'cancelled') return state
      apply({ type: 'retry' })
      return await this.start()
    },
    async openInstallerNow(): Promise<BoxSetupState> {
      if (state.phase !== 'awaiting-installer') return state
      if (!existsSync(pkgPath())) return state
      const r = await deps.openInstaller(pkgPath())
      if (!r.ok) deps.log(`[box-setup] riapertura dell'Installer non riuscita: ${r.error ?? ''}`)
      return state
    },
    async resumeAtBoot(): Promise<void> {
      if (running || state.phase === 'idle') return
      const [appleState, hasImage] = await Promise.all([
        deps.engineState().catch(() => 'unsupported' as AppleEngineState),
        deps.hasBoxImage().catch(() => false)
      ])
      const phase = boxSetupResumeFrom(state, appleState, hasImage)
      if (!phase) return
      running = true
      try {
        apply({ type: 'started', phase, at: deps.now() })
        await loop()
      } finally {
        running = false
      }
    }
  }
}

/** La prima riga, RIPULITA, di una stderr (nel log, MAI nella UI). */
function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim()) ?? '').slice(0, 200)
}
