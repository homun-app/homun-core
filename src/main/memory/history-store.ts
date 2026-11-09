// Fase memoria-engramma (M5): il richiamo delle conversazioni — la cella
// «storia». Ogni messaggio dell'utente e ogni risposta finale del bot
// diventano una nota `type: event`:
//   source: homun:chat/<agentId>/<entryId>, tag bot/<agentId>;
//   i risultati dei tool e i contenuti esterni NON entrano (indicizza solo
//   il testo dell'utente e la risposta finale).
// L'indicizzazione è ASINCRONA, in coda nel demone (job memory-index-story):
// mai dentro un turno. L'id della nota è un ULID DETERMINISTICO ricavato da
// (agente, entry): indicizzare due volte lo stesso entry fa una riscrittura,
// non un duplicato (idempotenza anche dopo un crash a metà coda).
import { createHash } from 'node:crypto'
import type { EngrammaSearchHit } from './engine'
import { memoryCell, memoryEngine } from './engine'
import { getEntries } from '../store/db'

/** La cella delle conversazioni (una per Homun, i tag separano i bot). */
export const STORY_CELL = 'storia'

/** L'actor delle scritture della storia: il demone, per conto della chat. */
const STORY_ACTOR = 'homun:story'

/** Quanto lungo al massimo il testo indicizzato (a difesa della cella). */
export const STORY_MAX_CHARS = 20_000

// ---- ULID deterministico ----

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Codifica un intero non negativo in base32 Crockford, lunghezza fissa. */
function encodeFixed(value: number | bigint, len: number): string {
  let out = ''
  let v = BigInt(value)
  for (let i = 0; i < len; i++) {
    out = CROCKFORD[Number(v & 0x1fn)] + out
    v >>= 5n
  }
  return out
}

/**
 * L'ULID della nota di storia di un entry: timestamp di creazione del entry +
 * parte casuale DERIVATA dall'hash di (agente, entry). Stesso entry → stesso
 * id: la re-indicizzazione riscrive la stessa nota (mai duplicati). La parte
 * casuale è piena entropia di fatto (sha256), come un ULID normale.
 */
export function storyNoteId(agentId: string, entryId: number, createdAtMs: number): string {
  const digest = createHash('sha256').update(`homun:story:${agentId}:${entryId}`).digest()
  let random = 0n
  for (let i = 0; i < 13; i++) random = (random << 8n) | BigInt(digest[i]!)
  // 16 caratteri = 80 bit: si prendono i primi 80 bit del digest
  return encodeFixed(Math.max(0, createdAtMs), 10) + encodeFixed(random & ((1n << 80n) - 1n), 16)
}

/**
 * Il tag delle risposte nate in un turno CONTAMINATO (web/email/MCP letti):
 * restano cercabili, ma quando search_history le restituisce il result è un
 * DATO ESTERNO (il loop lo incarta e contamina il turno, come la libreria).
 */
export const STORY_TAINTED_TAG = 'tainted'

/** Indicizza un messaggio della conversazione (utente o risposta finale). */
export async function indexStoryNote(
  agentId: string, entryId: number, kind: 'user' | 'assistant', text: string, createdAtMs: number,
  opts: { tainted?: boolean } = {}
): Promise<void> {
  const body = text.length > STORY_MAX_CHARS ? text.slice(0, STORY_MAX_CHARS) : text
  if (!body.trim()) return
  const cell = await memoryCell(STORY_CELL, STORY_ACTOR)
  await cell.put({
    id: storyNoteId(agentId, entryId, createdAtMs),
    noteType: 'event',
    body,
    // entry/<id> fa arrivare l'entry col SearchHit (che porta i tag, non la
    // source): niente get per riga in search_history
    tags: [`bot/${agentId}`, `entry/${entryId}`, ...(opts.tainted ? [STORY_TAINTED_TAG] : [])],
    source: `homun:chat/${agentId}/${entryId}`,
    // l'utente lo ha detto; la risposta del bot l'ha dedotta il bot
    confidence: kind === 'user' ? 'stated' : 'inferred',
    extensions: { 'x-homun': { entryId, kind, ...(opts.tainted ? { tainted: true } : {}) } }
  })
}

/** L'entry e il bot di un hit della storia (dai tag entry/<id> e bot/<id>). */
export function storyRefOf(hit: { tags: string[] }): { entryId: number | null; agentId: string | null; tainted: boolean } {
  const entry = hit.tags.find((t) => t.startsWith('entry/'))
  const bot = hit.tags.find((t) => t.startsWith('bot/'))
  const n = entry ? Number(entry.slice('entry/'.length)) : NaN
  return { entryId: Number.isFinite(n) ? n : null, agentId: bot ? bot.slice('bot/'.length) : null, tainted: hit.tags.includes(STORY_TAINTED_TAG) }
}

/** È un messaggio della conversazione da indicizzare? (utente o finale) */
export function isConversationEntry(e: { kind: string; role: string; meta?: Record<string, unknown> | null }): 'user' | 'assistant' | null {
  if (e.kind === 'message' && e.role === 'user' && !e.meta?.routineTitle && !e.meta?.initiator && !e.meta?.fromAgentId) return 'user'
  if (e.kind === 'send-message' && e.role === 'assistant' && e.meta?.final === true) return 'assistant'
  return null
}

/**
 * L'indicizzazione INIZIALE delle conversazioni esistenti (una volta, in
 * coda): ogni messaggio dell'utente e ogni risposta finale di ogni bot.
 * L'avanzamento esce con progress(done, total); l'id deterministico rende
 * innocua una ripresa a metà (riscrittura, mai duplicato).
 */
export async function backfillStory(
  agentIds: string[],
  progress: (done: number, total: number) => void = () => undefined
): Promise<{ indexed: number; durationMs: number }> {
  const t0 = Date.now()
  const todo: Array<{ agentId: string; id: number; kind: 'user' | 'assistant'; text: string; createdAt: number }> = []
  for (const agentId of agentIds) {
    for (const e of getEntries(agentId)) {
      const kind = isConversationEntry(e)
      if (kind) todo.push({ agentId, id: e.id, kind, text: e.content, createdAt: e.createdAt })
    }
  }
  let done = 0
  progress(0, todo.length)
  for (const t of todo) {
    await indexStoryNote(t.agentId, t.id, t.kind, t.text, t.createdAt)
    done++
    if (done % 100 === 0 || done === todo.length) progress(done, todo.length)
  }
  return { indexed: done, durationMs: Date.now() - t0 }
}

// ---- la coda: il demone inietta chi accoda (job memory-index-story) ----

/**
 * Un messaggio della conversazione da indicizzare: SOLO il riferimento
 * (correzioni C1). Testo e kind li rilegge il job dall'entry del DB, la
 * provenienza (tainted) da meta.contaminated che il loop scrive sulla
 * risposta finale di un turno contaminato.
 */
export interface StoryEntry {
  id: number
}

type StoryIndexer = (agentId: string, entry: StoryEntry) => void
let storyIndexer: StoryIndexer | null = null

/**
 * Il demone registra qui chi accoda l'indicizzazione (job memory-index-story
 * nella corsia dell'agente: parte DOPO il turno, mai dentro). Senza
 * registrazione (test, processo della UI) è un no-op.
 */
export function setStoryIndexer(fn: StoryIndexer | null): void {
  storyIndexer = fn
}

/** Il loop consegna un messaggio alla coda della storia (mai un errore nel turno). */
export function queueStoryIndex(agentId: string, entry: StoryEntry): void {
  try {
    storyIndexer?.(agentId, entry)
  } catch {
    // la storia non deve mai rompere il turno
  }
}

/**
 * Ciò che gira nel job memory-index-story (correzioni C1): rilegge l'entry
 * dal DB — il riferimento, non i dati — e indicizza testo e kind con
 * isConversationEntry; tainted arriva da meta.contaminated. L'entry sparito
 * (conversazione o bot eliminati nel frattempo) non indicizza nulla: non è
 * un errore, il job finisce bene.
 */
export async function runStoryIndexJob(agentId: string, entryId: number): Promise<'indexed' | 'gone'> {
  const entry = getEntries(agentId).find((e) => e.id === entryId)
  if (!entry) return 'gone'
  const kind = isConversationEntry(entry)
  if (!kind) return 'gone'
  await indexStoryNote(agentId, entryId, kind, entry.content, entry.createdAt, {
    tainted: entry.meta?.contaminated === true
  })
  return 'indexed'
}

/** Cerca nelle conversazioni indicizzate (tutti i bot, o solo uno). */
export async function searchHistory(query: string, agentId?: string, k = 10): Promise<EngrammaSearchHit[]> {
  const engine = await memoryEngine()
  // la cella si garantisce (il motore risponde NOT_FOUND su una cella assente)
  await engine.cell(STORY_CELL)
  const model = await engine.modelStatus()
  const hits = await engine.search([STORY_CELL], {
    text: query, k: Math.max(k, 50), mode: model.present ? 'hybrid' : 'text', graphHops: 1
  })
  return agentId ? hits.filter((h) => h.tags.includes(`bot/${agentId}`)).slice(0, k) : hits.slice(0, k)
}

/**
 * La finestra del transcript attorno a un entry id: i messaggi dell'utente e
 * le risposte FINALI del bot (i tool e i messaggi intermedi non sono
 * conversazione). Testo per il modello, null se l'entry non esiste.
 */
export async function readHistoryWindow(agentId: string, entryId: number, windowSize = 6): Promise<string | null> {
  const all = getEntries(agentId)
  const conversation = all.filter((e) => isConversationEntry(e) !== null)
  const at = conversation.findIndex((e) => e.id === entryId)
  if (at < 0) return null
  // windowSize = QUANTE righe al massimo (il messaggio chiesto al centro)
  const half = Math.max(0, Math.floor((windowSize - 1) / 2))
  const from = Math.max(0, at - half)
  const to = Math.min(conversation.length, from + Math.max(1, windowSize))
  return conversation.slice(from, to)
    .map((e) => {
      const who = e.kind === 'message' ? 'user' : 'bot'
      const text = e.content.replace(/\n+/g, ' ').slice(0, 2000)
      return `- [entry ${e.id}] ${who}: ${text}`
    })
    .join('\n')
}

/** Purga le note di storia di un bot (la sua conversazione si cancella). */
export async function purgeStoryOf(agentId: string): Promise<{ forgotten: number }> {
  const engine = await memoryEngine()
  await engine.cell(STORY_CELL)
  const cell = await memoryCell(STORY_CELL, STORY_ACTOR)
  const notes = (await cell.list({ tags: [`bot/${agentId}`], limit: 100_000 }))
    .filter((n) => n.tags.includes(`bot/${agentId}`))
  let forgotten = 0
  for (const n of notes) {
    const view = await cell.purge(n.id, 'conversation deleted')
    forgotten += view.forgottenPayloads
  }
  return { forgotten }
}
