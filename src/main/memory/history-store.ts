// Fase memoria-engramma (M5) · correzioni (C2): il richiamo delle
// conversazioni — la storia di un bot vive nella CELLA storia-<id>, la stessa
// separazione delle memorie (bot-<id>). Ogni messaggio dell'utente e ogni
// risposta finale del bot diventano una nota `type: event`:
//   source: homun:chat/<agentId>/<entryId>, tag entry/<entryId>;
//   i risultati dei tool e i contenuti esterni NON entrano (indicizza solo
//   il testo dell'utente e la risposta finale).
// L'indicizzazione è ASINCRONA, in coda nel demone (job memory-index-story):
// mai dentro un turno. L'id della nota è un ULID DETERMINISTICO ricavato da
// (agente, entry): indicizzare due volte lo stesso entry fa una riscrittura,
// non un duplicato (idempotenza anche dopo un crash a metà coda).
import { createHash } from 'node:crypto'
import type { EngrammaSearchHit } from './engine'
import { memoryCell, memoryEngine, storyCellName, dropCellAndEvict } from './engine'
import { getEntries, deleteSetting, getSetting, setSetting } from '../store/db'

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
  const cell = await memoryCell(storyCellName(agentId), STORY_ACTOR)
  await cell.put({
    id: storyNoteId(agentId, entryId, createdAtMs),
    noteType: 'event',
    body,
    // entry/<id> fa arrivare l'entry col SearchHit (che porta i tag); il BOT
    // è la cella stessa (storia-<id>): niente get per riga in search_history
    tags: [`entry/${entryId}`, ...(opts.tainted ? [STORY_TAINTED_TAG] : [])],
    source: `homun:chat/${agentId}/${entryId}`,
    // l'utente lo ha detto; la risposta del bot l'ha dedotta il bot
    confidence: kind === 'user' ? 'stated' : 'inferred',
    extensions: { 'x-homun': { entryId, kind, ...(opts.tainted ? { tainted: true } : {}) } }
  })
}

/** L'entry e il bot di un hit della storia (dal tag entry/<id> e dalla CELLA). */
export function storyRefOf(hit: { cell: string; tags: string[] }): { entryId: number | null; agentId: string | null; tainted: boolean } {
  const entry = hit.tags.find((t) => t.startsWith('entry/'))
  const n = entry ? Number(entry.slice('entry/'.length)) : NaN
  const agentId = hit.cell.startsWith('storia-') ? hit.cell.slice('storia-'.length) : null
  return { entryId: Number.isFinite(n) ? n : null, agentId, tainted: hit.tags.includes(STORY_TAINTED_TAG) }
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
  const todo: Array<{ agentId: string; id: number; kind: 'user' | 'assistant'; text: string; createdAt: number; tainted: boolean }> = []
  for (const agentId of agentIds) {
    for (const e of getEntries(agentId)) {
      const kind = isConversationEntry(e)
      // correzioni C3: le risposte finali nate prima di questa correzione non
      // hanno meta.contaminated — si indicizzano col segno tainted (provenienza
      // ignota = non fidata); i messaggi dell'utente restano puliti
      if (kind) todo.push({ agentId, id: e.id, kind, text: e.content, createdAt: e.createdAt, tainted: storyTaintedOf(e, e.createdAt) })
    }
  }
  let done = 0
  progress(0, todo.length)
  for (const t of todo) {
    await indexStoryNote(t.agentId, t.id, t.kind, t.text, t.createdAt, { tainted: t.tainted })
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
 * Correzioni C3: il primo avvio della correzione salva la data — le risposte
 * finali scritte PRIMA non hanno meta.contaminated (nessuno lo registrava):
 * provenienza ignota. Si chiama UNA volta al boot del demone, prima di ogni
 * turno e del backfill: le entry create dopo sono nel mondo della C1.
 */
export function ensureProvenanceSince(now: () => number = Date.now): number {
  const existing = getSetting<number | null>('memory.provenanceSince', null)
  if (typeof existing === 'number' && existing > 0) return existing
  const value = now()
  setSetting('memory.provenanceSince', value)
  return value
}

/**
 * La provenienza di un messaggio della conversazione (correzioni C3):
 *   - il messaggio dell'utente è sempre pulito;
 *   - meta.contaminated (C1) decide per le risposte di QUESTA fase;
 *   - una risposta finale senza meta.contaminated scritta prima di
 *     provenanceSince nasce TAINTED: ignoto vuol dire non fidato.
 */
export function storyTaintedOf(
  entry: { kind: string; role: string; meta?: Record<string, unknown> | null },
  createdAtMs: number
): boolean {
  if (isConversationEntry(entry) !== 'assistant') return false
  if (entry.meta?.contaminated === true) return true
  if (entry.meta?.contaminated === false) return false
  const since = getSetting<number | null>('memory.provenanceSince', null)
  return typeof since === 'number' && since > 0 && createdAtMs < since
}

/**
 * Ciò che gira nel job memory-index-story (correzioni C1): rilegge l'entry
 * dal DB — il riferimento, non i dati — e indicizza testo e kind con
 * isConversationEntry; tainted arriva da meta.contaminated (C1) e, per le
 * risposte più vecchie della correzione, dalla regola C3. L'entry sparito
 * (conversazione o bot eliminati nel frattempo) non indicizza nulla: non è
 * un errore, il job finisce bene.
 */
export async function runStoryIndexJob(agentId: string, entryId: number): Promise<'indexed' | 'gone'> {
  const entry = getEntries(agentId).find((e) => e.id === entryId)
  if (!entry) return 'gone'
  const kind = isConversationEntry(entry)
  if (!kind) return 'gone'
  await indexStoryNote(agentId, entryId, kind, entry.content, entry.createdAt, {
    tainted: storyTaintedOf(entry, entry.createdAt)
  })
  return 'indexed'
}

/**
 * Cerca nelle conversazioni indicizzate (correzioni C2):
 *   - senza `bot`: la storia del bot che STA PARLANDO (`speaking`, già
 *     risolto col boxOwnerOf per i figli) — un bot esposto al web non legge
 *     di default le chat degli altri;
 *   - `bot: 'all'`: tutte le celle storia-*, con UN solo Engine.search
 *     (fusione RRF del motore, non filtri JS dopo i primi k di tutti);
 *   - un id: la storia di quel bot.
 */
export async function searchHistory(
  query: string,
  speaking: string,
  bot?: string | 'all',
  k = 10
): Promise<EngrammaSearchHit[]> {
  const engine = await memoryEngine()
  const model = await engine.modelStatus()
  const mode = model.present ? 'hybrid' : 'text'
  const existing = await engine.cells()
  if (bot === 'all') {
    const cells = existing.filter((n) => n.startsWith('storia-'))
    if (!cells.length) return []
    return engine.search(cells, { text: query, k, mode, graphHops: 1 })
  }
  const name = storyCellName(bot ?? speaking)
  if (!existing.includes(name)) return [] // nessuna storia: nessun risultato, non un errore
  return engine.search([name], { text: query, k, mode, graphHops: 1 })
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


/**
 * Correzioni C2: la cella «storia» UNICA della fase precedente (dati di
 * sviluppo) si dimentica all'avvio e l'indicizzazione iniziale riparte, così
 * ogni bot ritrova la sua storia nella propria cella. Ritorna true se la
 * vecchia cella c'era (ed è stata dimenticata).
 */
export async function dropLegacyStoryCell(): Promise<boolean> {
  const engine = await memoryEngine()
  if (!(await engine.cells()).includes('storia')) return false
  await dropCellAndEvict('storia', 'legacy shared story cell of the previous phase: reindexing per bot')
  // il marcatore si azzera: il job di backfill riparte e ridistribuisce le
  // conversazioni nelle celle storia-<id>
  deleteSetting('memory.storyBackfilledAt')
  return true
}
