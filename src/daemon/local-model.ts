// Fase locale (L2/L3): il WIRING del modello integrato nel daemon — il
// singleton di LocalModelServer (processo affiancato di proprietà del daemon),
// i FATTI della macchina per l'idoneità, il provider DI TURNO (baseUrl e
// api-key da ensureRunning a OGNI turno, MAI salvati), e il ciclo di vita
// (orfan del pidfile all'avvio, spegnimento per inattività nel tick, stop
// con il daemon).
//
// Il server del bundle ufficiale si cerca dove l'app lo mette
// (Resources/vendor/llama, extraResources) e in dev nella vendor/ del repo
// (scripts/fetch-llama.mjs), come fa il motore Engramma col suo .node.
import { existsSync, rmSync, statfs } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProviderConfig } from '../shared/types'
import { dataDir } from '../main/store/db'
import { uiText } from '../main/ui-language'
import { UI } from '../shared/ui-messages'
import {
  createLocalModelServer, prodDeps, type LocalModelServer
} from './local-model-server'
import {
  LOCAL_MODEL_CATALOG, localModelInstalledPath, localEligibility,
  type LocalEligibility, type LocalCatalogEntry
} from '../main/agent/local-catalog'

/** Il nome della directory modelli nel data dir. */
export const MODELS_DIR_NAME = 'models'

/** <data>/models */
export function localModelsDir(): string {
  return join(dataDir(), MODELS_DIR_NAME)
}

/** cerca la project root risalendo dai sorgenti (come engine.ts di Engramma) */
function findProjectRoot(start: string): string | null {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'scripts', 'llama-pin.json'))) return dir
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Le cartelle dove cercare il bundle llama-server (come vendor/engramma). */
export function llamaDirCandidates(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath: string | undefined = (process as unknown as { resourcesPath?: string }).resourcesPath
): string[] {
  const out: string[] = []
  // override esplicito (test/CI)
  if (env.SANDBOT_LLAMA_DIR) return [env.SANDBOT_LLAMA_DIR]
  // app impacchettata: Resources/vendor/llama (extraResources)
  if (resourcesPath) out.push(join(resourcesPath, 'vendor', 'llama'))
  // dev e test: <repo>/vendor/llama, riempita da scripts/fetch-llama.mjs
  const root = findProjectRoot(fileURLToPath(import.meta.url))
  if (root) out.push(join(root, 'vendor', 'llama'))
  return out
}

/** Il percorso del llama-server del bundle, o null se il bundle non c'è. */
export function llamaServerBin(): string | null {
  for (const dir of llamaDirCandidates()) {
    const p = join(dir, 'llama-server')
    if (existsSync(p)) return p
  }
  return null
}

/**
 * La voce del catalogo del modello integrato (override solo per i test, che
 * servono un GGUF finto da un server su 127.0.0.1 invece del catalogo vero).
 */
let catalogEntryOverride: LocalCatalogEntry | null = null

/** Solo per i test: la voce del catalogo usata da demone e RPC (null = quella vera). */
export function setLocalModelCatalogForTest(e: LocalCatalogEntry | null): void {
  catalogEntryOverride = e
}

/** La voce del catalogo di turno: l'override dei test o l'unica vera. */
export function localModelCatalogEntry(): LocalCatalogEntry {
  return catalogEntryOverride ?? LOCAL_MODEL_CATALOG[0]!
}

let serverSingleton: LocalModelServer | null = null

/** Il server del modello integrato (un solo processo per daemon). */
export function getLocalModelServer(): LocalModelServer {
  if (serverSingleton) return serverSingleton
  const entry = localModelCatalogEntry()
  const bin = llamaServerBin() ?? '(bundle assente: node scripts/fetch-llama.mjs)'
  const data = dataDir()
  serverSingleton = createLocalModelServer({
    deps: prodDeps(data, join(data, 'logs')),
    serverBin: bin,
    modelFile: localModelInstalledPath(entry, localModelsDir()),
    pidFile: join(data, 'llama-server.pid'),
    logPath: join(data, 'logs', 'llama-server.log')
  })
  return serverSingleton
}

/** Solo per i test: azzera il singleton. */
export function resetLocalModelServer(): void {
  serverSingleton = null
}

/**
 * L3.1: il provider DI TURNO per il kind homun-local — baseUrl e chiave
 * arrivano da ensureRunning() a ogni turno e NON si salvano da nessuna parte
 * (porta e chiave nuove a OGNI avvio: nessun altro processo locale lo usa).
 * Per gli altri kind torna il provider com'è.
 */
export async function ensureLocalTurnProvider(p: ProviderConfig): Promise<ProviderConfig> {
  if (p.kind !== 'homun-local') return p
  const s = getLocalModelServer()
  const { baseUrl, apiKey } = await s.ensureRunning()
  s.noteRequest()
  return { ...p, baseUrl, apiKey }
}

/**
 * L3.3: i FATTI della macchina per l'idoneità (architettura, RAM GB, byte
 * liberi nella home — dove vive il data dir). freeDisk null se non noto.
 * (statfs è sincrono solo in callback: si legge una volta e si cachea)
 */
let cachedFreeDisk: number | null | undefined
export function localModelFacts(): { arch: string; ramGb: number; freeDiskBytes: number | null } {
  if (cachedFreeDisk === undefined) {
    try {
      statfs(homedir(), (err, st) => {
        cachedFreeDisk = err ? null : Number(st.bsize) * Number(st.bavail)
      })
    } catch {
      cachedFreeDisk = null
    }
  }
  const free = typeof cachedFreeDisk === 'number' ? cachedFreeDisk : null
  return {
    arch: process.arch,
    ramGb: Math.floor(totalmem() / 1024 ** 3),
    freeDiskBytes: free
  }
}

/** L'idoneità della macchina al modello integrato (per onboarding e scheda). */
export function localEligibilityOfMachine(entry: LocalCatalogEntry = localModelCatalogEntry()): LocalEligibility {
  return localEligibility(eligibilityFactsOverride ?? localModelFacts(), entry)
}

/** I fatti dell'idoneità (override solo per i test). */
let eligibilityFactsOverride: { arch: string; ramGb: number; freeDiskBytes: number | null } | null = null

/** Solo per i test: fissa i fatti dell'idoneità (null = la macchina vera). */
export function setLocalModelEligibilityFactsForTest(
  f: { arch: string; ramGb: number; freeDiskBytes: number | null } | null
): void {
  eligibilityFactsOverride = f
}

/**
 * Fase locale correzioni (LC2): l'idoneità si ricontrolla LATO DEMONE prima
 * di partire — `unsupported` e `no-space` negano la partenza con un errore
 * chiaro nella lingua dell'utente, senza dipendere dalla UI. Torna il
 * messaggio dell'errore, o null se la macchina è idonea (discouraged non
 * nega: l'avviso onesto lo mostra già la scheda).
 */
export function localModelInstallRefusal(entry: LocalCatalogEntry = localModelCatalogEntry()): string | null {
  const elig = localEligibilityOfMachine(entry)
  if (elig.status === 'unsupported') return uiText(UI.localModelUnsupported)
  if (elig.status === 'no-space') {
    return uiText(UI.localModelNoSpace, { needed: elig.neededGb, free: elig.freeGb })
  }
  return null
}

// ---- il download attivo (una sola volta: niente download paralleli) ----
let activeDownload: {
  controller: AbortController
  promise: Promise<{ path: string }>
} | null = null

// ---- fase locale correzioni 2 (LD1): la fine del download, UN SOLO posto ----

/** Chi ascolta la fine RIUSCITA del download (il demone registra il proprio aggancio una volta). */
export type LocalModelReadyListener = (ready: { path: string }) => void | Promise<void>

const localModelReadyListeners = new Set<LocalModelReadyListener>()

/**
 * LD1: l'aggancio alla fine del download (provider «Integrato», evento
 * agents, ripresa dell'onboarding) NON sta più nelle singole RPC che sanno
 * avviare un download — sta qui, notificato da startLocalModelDownload, che
 * è l'UNICO punto di partenza (Riprendi, Ricomincia e ogni strada futura).
 * Il demone registra il listener una volta; torna la deregistrazione.
 */
export function onLocalModelReady(listener: LocalModelReadyListener): () => void {
  localModelReadyListeners.add(listener)
  return () => { localModelReadyListeners.delete(listener) }
}

/** Le notifiche ai listener: un listener che lancia non ferma gli altri. */
async function notifyLocalModelReady(ready: { path: string }): Promise<void> {
  for (const l of [...localModelReadyListeners]) {
    try {
      await l(ready)
    } catch (e) {
      console.error('[local-model] onLocalModelReady:', e instanceof Error ? e.message : String(e))
    }
  }
}

/** Solo per i test: azzera i listener registrati. */
export function resetLocalModelReadyForTest(): void {
  localModelReadyListeners.clear()
}

/**
 * L'errore dell'ULTIMO tentativo fallito, in memoria nel demone (LC2): dopo
 * un riavvio sparisce e resta solo paused — va bene così. L'annullamento
 * NON è un errore: lo stato che lascia è paused.
 */
let lastDownloadError: string | null = null

/** L'errore dell'ultimo tentativo (per local-model:status), null se nessuno. */
export function localModelDownloadError(): string | null {
  return lastDownloadError
}

/** Le dipendenze iniettabili del download (i test servono un server finto). */
export interface LocalModelDownloadDeps {
  fetch?: typeof fetch
  url?: string
  entry?: LocalCatalogEntry
}

/**
 * L3.4: avvia (o riprende) il download del modello. Ritorna la promise della
 * fine; il progresso si legge dal .part su disco (poll della UI). LC2: il
 * fallimento finisce NELLO STATO (lastDownloadError) e nel log, non inghiottito.
 */
export function startLocalModelDownload(deps: LocalModelDownloadDeps = {}): Promise<{ path: string }> {
  if (activeDownload) return activeDownload.promise
  const entry = deps.entry ?? localModelCatalogEntry()
  const controller = new AbortController()
  lastDownloadError = null
  const promise = (async () => {
    const { downloadLocalModel } = await import('../main/agent/local-model')
    return await downloadLocalModel({
      fetch: deps.fetch ?? fetch,
      url: deps.url,
      modelsDir: localModelsDir,
      entry,
      signal: controller.signal,
      onProgress: () => {
        // il progresso si legge dal .part su disco (poll della UI): qui niente
      }
    })
  })()
  activeDownload = { controller, promise }
  // LD1: la fine RIUSCITA notifica i listener registrati dal demone (provider,
  // evento agents, onboarding) — qui, non nelle RPC che avviano il download
  promise.then(
    (ready) => { void notifyLocalModelReady(ready) },
    () => undefined // il rifiuto lo registra la catena sotto (stato + log)
  )
  promise.finally(() => { activeDownload = null }).catch((e: unknown) => {
    const raw = e instanceof Error ? e.message : String(e)
    // l'annullamento NON è un errore: lo stato che lascia è paused (il .part resta)
    if (!/annull|cancel|abort/i.test(raw)) {
      lastDownloadError = uiText(UI.localModelDownloadFailed, { message: raw })
      console.error(`[local-model] download failed: ${raw}`)
    } else {
      console.error('[local-model] download cancelled (paused, il .part resta)')
    }
  })
  return promise
}

/**
 * LC2: Ricomincia — cancella il .part e riparte da zero. Ha senso con paused
 * e con error (un .part corrotto, per esempio); con un download attivo non
 * fa niente (la UI non lo mostra, e partono comunque download doppi mai).
 */
export async function restartLocalModelDownload(deps: LocalModelDownloadDeps = {}): Promise<{ started: boolean }> {
  if (activeDownload) return { started: false }
  const entry = deps.entry ?? localModelCatalogEntry()
  try { rmSync(localModelInstalledPath(entry, localModelsDir()) + '.part', { force: true }) } catch { /* già via */ }
  lastDownloadError = null
  startLocalModelDownload(deps)
  return { started: true }
}

/** Solo per i test: azzera lo stato del download (annulla e dimentica l'errore). */
export function resetLocalModelDownloadForTest(): void {
  if (activeDownload) activeDownload.controller.abort()
  activeDownload = null
  lastDownloadError = null
}

/** L3.4: annulla il download attivo (il .part resta, si può riprendere). */
export function cancelLocalModelDownload(): boolean {
  if (!activeDownload) return false
  activeDownload.controller.abort()
  return true
}

/** C'è un download attivo in questo momento? */
export function localModelDownloading(): boolean {
  return activeDownload !== null
}

/**
 * L3.5: la rimozione — ferma il processo, cancella i file, torna i byte
 * liberati (la UI dice i GB).
 */
export async function removeLocalModelFromDisk(): Promise<{ freedBytes: number; freedGb: number }> {
  cancelLocalModelDownload()
  lastDownloadError = null // LC2: rimosso il modello, anche l'errore del tentativo sparisce
  const { removeLocalModel } = await import('../main/agent/local-model')
  return await removeLocalModel({
    modelsDir: localModelsDir(),
    entry: localModelCatalogEntry(),
    stopServer: () => getLocalModelServer().stop()
  })
}

// ---- il ciclo di vita del daemon ----

/**
 * All'avvio del daemon: uccide l'eventuale orfano registrato nel pidfile,
 * SOLO se quel pid è davvero un nostro llama-server. Errore silenzioso: un
 * problema qui non deve fermare il daemon.
 */
export async function localModelBootCleanup(): Promise<void> {
  try {
    await getLocalModelServer().killOrphanIfOurs()
  } catch (e) {
    console.error('[local-model] pulizia orfano:', e)
  }
}

/** Lo spegnimento per inattività: lo chiama il tick del daemon. */
export function localModelIdleTick(): boolean {
  try {
    return getLocalModelServer().maybeShutdownIdle()
  } catch {
    return false
  }
}

/** Con il daemon: spegne SEMPRE il processo del modello. */
export async function localModelShutdown(): Promise<void> {
  try {
    await getLocalModelServer().stop()
  } catch {
    // già spento
  }
}

/** Il byte liberi di adesso (per il conteggio dei GB del download). */
export function freeDiskBytes(): number | null {
  return localModelFacts().freeDiskBytes
}
