// Fase memoria-engramma (M1): il motore Engramma nel demone. Il modulo N-API
// (vendor/engramma, preparato da scripts/prepare-engramma.mjs) si carica QUI,
// una volta per processo: Engine.open su <dataDir>/memory con actor 'homun' e
// modelDir <dataDir>/models (il modello NON si scarica mai da solo: finché
// non c'è, la ricerca è testo+grafo). Le celle di un bot si aprono con
// engine.cell('bot-<id>', { actor: 'homun:bot-<id>' }) così il registro dice
// quale bot ha scritto; la cella 'utente' con l'actor del bot che scrive o
// 'homun:user' per le scritture dall'interfaccia.
//
// Nessun ripiego silenzioso: se il modulo non si carica (o il motore è
// chiuso), ogni chiamata fallisce con un errore CHIARO (MemoryUnavailable) —
// gli strumenti di memoria lo riportano al modello, l'interfaccia mostra il
// problema, il resto di Homun funziona. Dopo engine.close() il contratto
// risponde code 'CLOSED': qui viene normalizzato (lo spegnimento non deve
// produrre errori nei log).
//
// I tipi qui sotto rispecchiano il contratto di crates/engramma-node
// (index.d.ts, fase-v0.4.1): il .d.ts del crate non entra nel tsconfig di
// Homun, quindi il contratto vive in questi nominali minimi.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { enqueueJob } from '../store/jobs'

// ---- il contratto (docs/node.md e index.d.ts di engramma-node v0.4.1) ----

export interface EngrammaNoteInput {
  id?: string
  noteType?: string
  title?: string
  body?: string
  tags?: string[]
  aliases?: string[]
  source: string
  confidence: 'stated' | 'inferred' | 'external'
  status?: 'active' | 'quarantined'
  validFrom?: string
  validTo?: string
  extensions?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

export interface EngrammaNoteView {
  id: string
  noteType: string
  title?: string | null
  body: string
  tags: string[]
  aliases: string[]
  scope?: string | null
  source: string
  confidence: string
  status: string
  validFrom?: string | null
  validTo?: string | null
  createdAt: string
  updatedAt: string
  version: number
  extensions: Record<string, unknown>
}

export interface EngrammaNotePatchInput {
  title?: string | null
  body?: string
  tags?: string[]
  source?: string
  confidence?: string
  validFrom?: string | null
  validTo?: string | null
  extensions?: Record<string, unknown | null>
}

export interface EngrammaListFilter {
  tags?: string[]
  noteType?: string
  status?: string[]
  limit?: number
  offset?: number
}

export interface EngrammaSearchInput {
  text: string
  k?: number
  mode?: 'text' | 'vector' | 'hybrid'
  graphHops?: number
  asOf?: string
  includeQuarantined?: boolean
  explain?: boolean
}

export interface EngrammaGraphSay {
  weight: number
  off?: string
  gap?: number
  agreement?: boolean
}

export interface EngrammaHitExplain {
  lists: string[]
  matchedTerms: string[]
  bm25Rank?: number
  semanticRank?: number
  graphRank?: number
  cosine?: number
  support?: string
  via?: string
  graph?: EngrammaGraphSay
  fusedScore?: number
}

export interface EngrammaSearchHit {
  id: string
  cell: string
  title: string
  snippet: string
  score: number
  support?: string | null
  explain?: EngrammaHitExplain
  noteType: string
  tags: string[]
  updatedAt: string
  status: string
}

export interface EngrammaVersionView {
  version: number
  opId: string
  note: EngrammaNoteView
}

export interface EngrammaPurgeView {
  forgottenPayloads: number
  scrubbed: boolean
  pending: string[]
  views: Array<{ viewId?: string | null; root: string; reason: string }>
}

export interface EngrammaOpView {
  seq: number
  opId: string
  actor: string
  kind: string
  noteId?: string
}

export interface EngrammaModelStatus {
  present: boolean
  id?: string
  bytes?: number
}

export interface EngrammaCell {
  readonly name: string
  put(note: EngrammaNoteInput): Promise<EngrammaNoteView>
  patch(id: string, patch: EngrammaNotePatchInput): Promise<EngrammaNoteView>
  get(id: string): Promise<EngrammaNoteView | null>
  list(f?: EngrammaListFilter): Promise<EngrammaNoteView[]>
  search(q: EngrammaSearchInput): Promise<EngrammaSearchHit[]>
  history(id: string): Promise<EngrammaVersionView[]>
  setStatus(id: string, status: string): Promise<void>
  confirm(id: string): Promise<void>
  delete(id: string): Promise<void>
  purge(id: string, reason: string): Promise<EngrammaPurgeView>
  embedPending(limit?: number): Promise<number>
  changesSince(seq: number): Promise<{ head: number; ops: EngrammaOpView[] } | { compacted: true; head: number }>
}

export interface EngrammaEngine {
  cell(name: string, opts?: { create?: boolean; actor?: string }): Promise<EngrammaCell>
  cells(): Promise<string[]>
  modelStatus(): Promise<EngrammaModelStatus>
  pullModel(onProgress?: (done: number, total: number) => void): Promise<void>
  search(cells: string[], q: EngrammaSearchInput): Promise<EngrammaSearchHit[]>
  close(): Promise<void>
}

export interface EngrammaModule {
  Engine: { open(opts: { root: string; modelDir?: string; embedder?: 'builtin' | 'none'; actor: string }): Promise<EngrammaEngine> }
  version(): string
}

// ---- caricamento del modulo nativo ----

function findProjectRoot(start: string): string | null {
  let dir = dirname(start)
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * Le cartelle dove cercare il modulo (come i wasm di tree-sitter, shell-ast.ts).
 * SANDBOT_ENGRAMMA_DIR, quando c'è, è l'unica cartella considerata.
 */
export function engrammaDirCandidates(env: NodeJS.ProcessEnv = process.env, resourcesPath?: string): string[] {
  const out: string[] = []
  // override ESPLICITO: vince da solo (test/CI), niente cadute sotto mano
  if (env.SANDBOT_ENGRAMMA_DIR) return [env.SANDBOT_ENGRAMMA_DIR]
  // app impacchettata: Resources/vendor/engramma (extraResources; il .node sta
  // fuori dall'asar per definitione — un modulo nativo va mappato dal fs)
  if (resourcesPath) out.push(join(resourcesPath, 'vendor', 'engramma'))
  // dev e test: <repo>/vendor/engramma, riempita da scripts/prepare-engramma.mjs
  const root = findProjectRoot(fileURLToPath(import.meta.url))
  if (root) out.push(join(root, 'vendor', 'engramma'))
  return out
}

let moduleCache: Promise<EngrammaModule | null> | null = null

/** Il modulo nativo, o null se non si carica (il chiamante lo dice chiaramente). */
export function engrammaModule(): Promise<EngrammaModule | null> {
  if (!moduleCache) {
    moduleCache = (async () => {
      const dir = engrammaDirCandidates().find((d) => existsSync(join(d, 'index.js')))
      if (!dir) return null
      try {
        // il caricatore napi-rs cerca il .node ACCANTO a sé: require assoluto
        // di index.js e la risoluzione relativa fa il resto
        const req = createRequire(import.meta.url)
        const m = req(join(dir, 'index.js')) as EngrammaModule
        return typeof m?.Engine?.open === 'function' ? m : null
      } catch {
        return null
      }
    })()
    moduleCache.catch(() => undefined)
  }
  return moduleCache
}

/** Solo per i test: riprova il caricamento (es. dopo aver spostato SANDBOT_ENGRAMMA_DIR). */
export function resetEngrammaModuleCacheForTests(): void {
  moduleCache = null
}

// ---- celle ----

/** La cella delle memorie di un bot: bot-<id sanificato> (DESIGN §8.4). */
export function botCellName(agentId: string): string {
  const clean = agentId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64)
  return 'bot-' + clean
}

/** La cella delle memorie condivise da tutti i bot. */
export const USER_CELL = 'utente'

/** L'actor con cui un bot scrive: homun:bot-<id>. */
export function botActor(agentId: string): string {
  return 'homun:' + botCellName(agentId)
}

/**
 * Perché la memoria non c'è: il modulo non si carica, Engine.open fallisce,
 * o il motore è chiuso (spegnimento). L'interfaccia mostra il motivo dal
 * catalogo it/en a partire da questo CODICE; il testo inglese va al modello
 * e ai log (mai contenuti di note: il motore non ne mette nei suoi errori).
 */
export type MemoryUnavailableReason = 'module' | 'open' | 'closed'

const REASON_TEXT: Record<MemoryUnavailableReason, string> = {
  module: 'the Engramma native module does not load (vendor/engramma: npm run prepare-engramma)',
  open: 'the Engramma engine did not open',
  closed: 'the memory engine is closed (CLOSED)'
}

/** L'errore chiaro quando il motore non c'è: mai un ripiego silenzioso. */
export class MemoryUnavailableError extends Error {
  readonly code = 'MEMORY_UNAVAILABLE'
  constructor(readonly reason: MemoryUnavailableReason, readonly detail?: string) {
    super(`Memory unavailable: ${REASON_TEXT[reason]}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---- il motore: una volta per processo ----

type EngineState =
  | { kind: 'closed' }
  | { kind: 'open'; engine: EngrammaEngine; root: string; version: string; cells: Map<string, EngrammaCell> }
  | { kind: 'failed'; reason: MemoryUnavailableReason; detail?: string }

let state: EngineState = { kind: 'closed' }
let opening: Promise<MemoryEngineStatus> | null = null

export interface MemoryEngineStatus {
  available: boolean
  /** il motivo come codice (catalogo UI) e come testo inglese (modello/log) */
  reason?: MemoryUnavailableReason
  error?: string
  version?: string
  model: EngrammaModelStatus
}

function unavailable(reason: MemoryUnavailableReason, detail?: string): MemoryEngineStatus {
  return { available: false, reason, error: new MemoryUnavailableError(reason, detail).message, model: { present: false } }
}

/** Apre (o riapre) il motore su <dataDir>/memory. Idempotente; non lancia mai. */
export function openMemoryEngine(opts: { dataDir: string }): Promise<MemoryEngineStatus> {
  if (opening) return opening
  if (state.kind === 'open') {
    return Promise.resolve({ available: true, version: state.version, model: { present: false } })
  }
  opening = (async (): Promise<MemoryEngineStatus> => {
    const mod = await engrammaModule()
    if (!mod) {
      state = { kind: 'failed', reason: 'module' }
      return unavailable('module')
    }
    try {
      const engine = await mod.Engine.open({
        root: join(opts.dataDir, 'memory'),
        modelDir: join(opts.dataDir, 'models'),
        actor: 'homun'
      })
      state = { kind: 'open', engine, root: join(opts.dataDir, 'memory'), version: mod.version(), cells: new Map() }
      return { available: true, version: mod.version(), model: await engine.modelStatus() }
    } catch (e) {
      // il messaggio del motore non contiene contenuti di note (contratto)
      const detail = e instanceof Error ? e.message : String(e)
      state = { kind: 'failed', reason: 'open', detail }
      return unavailable('open', detail)
    }
  })()
  const done = opening
  opening.finally(() => { opening = null })
  return done
}

/** Il motore aperto, o MemoryUnavailableError con il motivo. */
export async function memoryEngine(): Promise<EngrammaEngine> {
  if (state.kind === 'open') return state.engine
  if (state.kind === 'failed') throw new MemoryUnavailableError(state.reason, state.detail)
  throw new MemoryUnavailableError('closed')
}

/** Il motivo (inglese) per cui la memoria non c'è, o null se c'è. */
export function memoryEngineError(): string | null {
  if (state.kind === 'failed') return new MemoryUnavailableError(state.reason, state.detail).message
  if (state.kind === 'closed') return new MemoryUnavailableError('closed').message
  return null
}

/** Stato per l'interfaccia: motore, versione, modello (mai scarica nulla). */
export async function memoryEngineStatus(): Promise<MemoryEngineStatus> {
  if (state.kind === 'open') {
    let model: EngrammaModelStatus = { present: false }
    try {
      model = await state.engine.modelStatus()
    } catch {
      // CLOSED o altro: per lo stato vale "non disponibile ora"
    }
    return { available: true, version: state.version, model }
  }
  if (state.kind === 'failed') return unavailable(state.reason, state.detail)
  return unavailable('closed')
}

/**
 * Chiude il motore allo spegnimento: await engine.close() aspetta le
 * operazioni in volo; dopo, ogni chiamata risponde CLOSED (il contratto) e
 * qui diventa silenzio: la chiusura non deve generare errori nei log.
 * Chiamarla due volte non è un errore.
 */
export async function closeMemoryEngine(): Promise<void> {
  const current = state
  state = { kind: 'closed' }
  if (current.kind === 'open') {
    try {
      await current.engine.close()
    } catch {
      // il contratto: chiudere due volte o a motore già chiuso non è un errore
    }
  }
}

/**
 * Una cella con il suo actor (cache per coppia cella+actor: due Cell con
 * attori diversi sulla stessa cella scrivono la stessa memoria, contratto).
 */
export async function memoryCell(name: string, actor: string): Promise<EngrammaCell> {
  const engine = await memoryEngine()
  if (state.kind !== 'open') throw new MemoryUnavailableError('closed')
  const key = `${name}::${actor}`
  const hit = state.cells.get(key)
  if (hit) return hit
  const cell = await engine.cell(name, { actor })
  state.cells.set(key, cell)
  return cell
}

/** La cella delle memorie di un bot (actor homun:bot-<id>). */
export function botCell(agentId: string): Promise<EngrammaCell> {
  return memoryCell(botCellName(agentId), botActor(agentId))
}

/** La cella condivisa: actor del bot che scrive, o homun:user dall'interfaccia. */
export function userCell(writerAgentId: string | null): Promise<EngrammaCell> {
  return memoryCell(USER_CELL, writerAgentId ? botActor(writerAgentId) : 'homun:user')
}

/**
 * Le celle che la ricerca di un bot attraversa: bot-<id> e utente. Il motore
 * risponde NOT_FOUND su una cella inesistente, quindi le si GARANTISCE qui
 * (vuote) prima di Engine.search.
 */
export async function ensureSearchCells(agentId: string): Promise<void> {
  const engine = await memoryEngine()
  const existing = new Set(await engine.cells())
  const missing = [botCellName(agentId), USER_CELL].filter((n) => !existing.has(n))
  for (const name of missing) await engine.cell(name)
}

/**
 * embedPending su tutte le celle, SOLO se il modello c'è (altrimenti è un
 * no-op silenzioso: il modello non si scarica mai da solo). Gira in fondo
 * alla coda del demone, mai dentro un turno. Ritorna quante note ha
 * incorporato; gli errori CLOSED/MODEL_MISSING diventano silenzio.
 */
export async function embedPendingAll(limit = 64): Promise<number> {
  let engine: EngrammaEngine
  try {
    engine = await memoryEngine()
  } catch {
    return 0
  }
  try {
    if (!(await engine.modelStatus()).present) return 0
    let done = 0
    for (const name of await engine.cells()) {
      const cell = await engine.cell(name)
      done += await cell.embedPending(limit)
    }
    return done
  } catch {
    // CLOSED a metà, o il modello sparito: si riprova al prossimo giro
    return 0
  }
}

// ---- embedPending in fondo alla coda del demone ----


/**
 * Quanto dopo una scrittura parte il job di embed: abbastanza in fondo che
 * il turno sia chiuso (il job gira nella STESSA corsia dell'agente: mai
 * durante un suo turno), abbastanza presto che la ricerca sia pronta.
 */
export const EMBED_JOB_DELAY_MS = 20_000

/**
 * Accoda (una sola volta per agente: coalesce) il job memory-embed. Il job
 * incorpora le note ancora senza vettore, SOLO se il modello c'è; se non c'è
 * non fa nulla — il modello non si scarica mai da solo.
 */
/**
 * Accoda l'indicizzazione di un messaggio nella cella «storia» (M5): ogni
 * messaggio dell'utente e ogni risposta finale del bot, mai dentro il turno.
 * Il payload porta il testo del messaggio: sta nella coda del demone (il DB
 * locale), non nei log.
 */
export function enqueueStoryIndex(
  db: DatabaseSync,
  agentId: string,
  entry: { id: number; kind: 'user' | 'assistant'; text: string; createdAt: number },
  now = Date.now()
): void {
  enqueueJob(db, {
    agentId, kind: 'memory-index-story', now, runAt: now,
    payload: { entryId: entry.id, kind: entry.kind, text: entry.text, createdAt: entry.createdAt }
  })
}

/**
 * La coda dell'oblio di un bot ELIMINATO (M5): purga la sua cella di memorie
 * e le sue note nella storia (l'eliminazione della conversazione). La purga
 * è lenta (riscrive la cella): sta in coda, mai nella RPC.
 */
export function enqueueForgetAgent(db: DatabaseSync, agentId: string, now = Date.now()): void {
  enqueueJob(db, { agentId, kind: 'memory-forget-agent', payload: {}, runAt: now, now })
}

/** La coda dell'indicizzazione iniziale delle conversazioni esistenti (M5). */
export function enqueueStoryBackfill(db: DatabaseSync, agentId: string, now = Date.now()): void {
  enqueueJob(db, { agentId, kind: 'memory-story-backfill', payload: {}, runAt: now, now })
}

export function enqueueEmbedPending(db: DatabaseSync, agentId: string, now = Date.now()): void {
  const queued = db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'memory-embed' AND status IN ('queued','leased') AND agent_id = ?")
    .get(agentId) as { n: number }
  if (queued.n > 0) return
  enqueueJob(db, { agentId, kind: 'memory-embed', payload: {}, runAt: now + EMBED_JOB_DELAY_MS, now })
}
