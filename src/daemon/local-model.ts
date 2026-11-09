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
import { existsSync, statfs } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProviderConfig } from '../shared/types'
import { dataDir } from '../main/store/db'
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

let serverSingleton: LocalModelServer | null = null

/** Il server del modello integrato (un solo processo per daemon). */
export function getLocalModelServer(): LocalModelServer {
  if (serverSingleton) return serverSingleton
  const entry = LOCAL_MODEL_CATALOG[0]!
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
export function localEligibilityOfMachine(entry: LocalCatalogEntry = LOCAL_MODEL_CATALOG[0]!): LocalEligibility {
  return localEligibility(localModelFacts(), entry)
}

// ---- il download attivo (una sola volta: niente download paralleli) ----
let activeDownload: {
  controller: AbortController
  promise: Promise<{ path: string }>
} | null = null

/**
 * L3.4: avvia (o riprende) il download del modello. Ritorna la promise della
 * fine; il progresso si legge da localModelProgress() (il .part su disco).
 */
export function startLocalModelDownload(): Promise<{ path: string }> {
  if (activeDownload) return activeDownload.promise
  const entry = LOCAL_MODEL_CATALOG[0]!
  const controller = new AbortController()
  const promise = (async () => {
    const { downloadLocalModel } = await import('../main/agent/local-model')
    return await downloadLocalModel({
      fetch,
      modelsDir: localModelsDir,
      entry,
      signal: controller.signal,
      onProgress: () => {
        // il progresso si legge dal .part su disco (poll della UI): qui niente
      }
    })
  })()
  activeDownload = { controller, promise }
  promise.finally(() => { activeDownload = null }).catch(() => undefined)
  return promise
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
  const { removeLocalModel } = await import('../main/agent/local-model')
  return await removeLocalModel({
    modelsDir: localModelsDir(),
    entry: LOCAL_MODEL_CATALOG[0]!,
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
