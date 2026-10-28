// Store dei SOTTOAGENTI (fase 12, punti 1 e 5): la tabella `subagents` è il
// registro dei figli — chi li ha lanciati (parent_id), il lotto (batch_id: i
// figli dello stesso turno del padre si svegliano INSIEME, una volta sola),
// brief, stato, summary/report alla chiusura e la scadenza. Il figlio È anche
// una riga `agents` con parent_id (il loop lo esegue senza cambiare niente:
// corsia sua nella coda, transcript suo, un job attivo per agente); qui vive
// ciò che il padre e l'utente devono vedere di lui. Funzioni SQL pure: la
// connessione arriva da fuori, i test girano su un :memory:.
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

/** Gli stati della riga: queued/running sono APERTI, gli altri TERMINALI. */
export type SubagentStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'expired'

export interface SubagentRow {
  id: string
  parent_id: string
  parent_task_id: number | null
  batch_id: string
  title: string
  brief: string
  status: SubagentStatus
  summary: string | null
  report_path: string | null
  contaminated: number
  untrusted: number
  automatic: number
  /** il padre è già stato svegliato per questo figlio (il lotto si sveglia UNA volta) */
  woken: number
  created_at: number
  started_at: number | null
  finished_at: number | null
  deadline_at: number
}

interface SubagentDbRow {
  id: string; parent_id: string; parent_task_id: number | null; batch_id: string
  title: string; brief: string; status: string; summary: string | null; report_path: string | null
  contaminated: number; untrusted: number; automatic: number; woken: number
  created_at: number; started_at: number | null; finished_at: number | null; deadline_at: number
}

function rowToSubagent(r: SubagentDbRow): SubagentRow {
  return {
    id: r.id, parent_id: r.parent_id, parent_task_id: r.parent_task_id, batch_id: r.batch_id,
    title: r.title, brief: r.brief, status: r.status as SubagentStatus,
    summary: r.summary, report_path: r.report_path,
    contaminated: r.contaminated, untrusted: r.untrusted, automatic: r.automatic, woken: r.woken,
    created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at, deadline_at: r.deadline_at
  }
}

/** Schema della tabella (usato da db.ts e dai test su :memory:). */
export const SUBAGENTS_DDL = `
    CREATE TABLE IF NOT EXISTS subagents (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      parent_task_id INTEGER,
      batch_id TEXT NOT NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      summary TEXT,
      report_path TEXT,
      contaminated INTEGER DEFAULT 0,
      untrusted INTEGER DEFAULT 0,
      automatic INTEGER DEFAULT 0,
      woken INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      deadline_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subagents_parent ON subagents(parent_id, status);
    CREATE INDEX IF NOT EXISTS idx_subagents_batch ON subagents(batch_id);
  `

/** L'id di un figlio: `sub_<8 hex>` (la mappa `running` del loop non cambia). */
export function newSubagentId(): string {
  return 'sub_' + randomUUID().slice(0, 8)
}

/** Un nuovo lotto (uno per turno del padre, creato alla prima spawn del turno). */
export function newSubagentBatchId(): string {
  return randomUUID()
}

export const TERMINAL_SUBAGENT_STATUSES: readonly SubagentStatus[] = ['done', 'failed', 'stopped', 'expired']

export function isTerminalStatus(s: SubagentStatus): boolean {
  return TERMINAL_SUBAGENT_STATUSES.includes(s)
}

export interface InsertSubagentInput {
  id: string
  parentId: string
  parentTaskId: number | null
  batchId: string
  title: string
  brief: string
  deadlineAt: number
  createdAt: number
  untrusted?: boolean
  automatic?: boolean
}

export function insertSubagent(db: DatabaseSync, input: InsertSubagentInput): SubagentRow {
  db.prepare(`
    INSERT INTO subagents(id, parent_id, parent_task_id, batch_id, title, brief, status, untrusted, automatic, created_at, deadline_at)
    VALUES(?,?,?,?,?,?, 'queued', ?, ?, ?, ?)
  `).run(
    input.id, input.parentId, input.parentTaskId, input.batchId, input.title, input.brief,
    input.untrusted ? 1 : 0, input.automatic ? 1 : 0, input.createdAt, input.deadlineAt
  )
  return getSubagent(db, input.id)!
}

export function getSubagent(db: DatabaseSync, id: string): SubagentRow | null {
  const r = db.prepare('SELECT * FROM subagents WHERE id = ?').get(id) as SubagentDbRow | undefined
  return r ? rowToSubagent(r) : null
}

/** I figli di un padre, dal più recente (la card e il pannello li mostrano così). */
export function listSubagentsOf(db: DatabaseSync, parentId: string): SubagentRow[] {
  return (db.prepare('SELECT * FROM subagents WHERE parent_id = ? ORDER BY created_at DESC, id').all(parentId) as unknown as SubagentDbRow[])
    .map(rowToSubagent)
}

/** I figli APERTI (queued o running) di un padre: il tetto delle spawn. */
export function openSubagentsOf(db: DatabaseSync, parentId: string): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM subagents WHERE parent_id = ? AND status IN ('queued','running')").get(parentId) as { n: number }
  return r.n
}

export interface SubagentPatch {
  status?: SubagentStatus
  summary?: string
  report_path?: string
  contaminated?: boolean
  woken?: boolean
  started_at?: number
  finished_at?: number
  deadline_at?: number
  batch_id?: string
}

/**
 * Aggiorna la riga: gli stati TERMINALI non si riaprono qui (la riapertura è
 * message_subagent, che cambia anche lotto e scadenza in un colpo solo). Torna
 * la riga aggiornata (null se il figlio non esiste).
 */
export function updateSubagent(db: DatabaseSync, id: string, patch: SubagentPatch): SubagentRow | null {
  const cur = getSubagent(db, id)
  if (!cur) return null
  db.prepare(`
    UPDATE subagents SET
      status = ?, summary = ?, report_path = ?, contaminated = ?, woken = ?,
      started_at = ?, finished_at = ?, deadline_at = ?, batch_id = ?
    WHERE id = ?
  `).run(
    patch.status ?? cur.status,
    patch.summary !== undefined ? patch.summary : cur.summary,
    patch.report_path !== undefined ? patch.report_path : cur.report_path,
    patch.contaminated === true || cur.contaminated === 1 ? 1 : 0,
    // woken NON è monotono: la riapertura con message_subagent lo azzera (il
    // lotto nuovo va svegliato di nuovo)
    patch.woken !== undefined ? (patch.woken ? 1 : 0) : cur.woken,
    patch.started_at !== undefined ? patch.started_at : cur.started_at,
    patch.finished_at !== undefined ? patch.finished_at : cur.finished_at,
    patch.deadline_at !== undefined ? patch.deadline_at : cur.deadline_at,
    patch.batch_id ?? cur.batch_id,
    id
  )
  return getSubagent(db, id)
}

/** Chiude un figlio APERTO con uno stato terminale (i terminali non si toccano). */
export function closeSubagent(
  db: DatabaseSync,
  id: string,
  final: { status: SubagentStatus; summary?: string; report_path?: string; contaminated?: boolean; finishedAt: number }
): SubagentRow | null {
  const cur = getSubagent(db, id)
  // il figlio è già terminale (stop dell'utente o scadenza): il primo esito vince
  if (!cur || isTerminalStatus(cur.status)) return cur
  return updateSubagent(db, id, {
    status: final.status,
    finished_at: final.finishedAt,
    ...(final.summary !== undefined ? { summary: final.summary } : {}),
    ...(final.report_path !== undefined ? { report_path: final.report_path } : {}),
    ...(final.contaminated ? { contaminated: true } : {})
  })
}

/** I figli di un lotto (il risveglio del padre li vuole TUTTI). */
export function subagentsOfBatch(db: DatabaseSync, batchId: string): SubagentRow[] {
  return (db.prepare('SELECT * FROM subagents WHERE batch_id = ? ORDER BY created_at').all(batchId) as unknown as SubagentDbRow[])
    .map(rowToSubagent)
}

/**
 * Punto 5, il cuore atomico: se TUTTI i figli del lotto sono terminali, un
 * solo `UPDATE … SET woken = 1 WHERE batch_id = ? AND woken = 0 RETURNING *`.
 * Due figli che finiscono insieme non svegliano il padre due volte: il primo
 * UPDATE azzera woken per tutto il lotto e il secondo non restituisce righe.
 * Torna le righe svegliate (vuoto = lotto incompleto o già svegliato).
 */
export function wakeBatch(db: DatabaseSync, batchId: string): SubagentRow[] {
  return (db.prepare(
    "UPDATE subagents SET woken = 1 WHERE batch_id = ? AND woken = 0 AND NOT EXISTS (SELECT 1 FROM subagents s2 WHERE s2.batch_id = ? AND s2.status IN ('queued','running')) RETURNING *"
  ).all(batchId, batchId) as unknown as SubagentDbRow[]).map(rowToSubagent)
}

/** I lotti con figli non ancora svegliati (al boot: crash tra fine e risveglio). */
export function unwokenBatches(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT DISTINCT batch_id FROM subagents WHERE woken = 0').all() as Array<{ batch_id: string }>
  return rows.map((r) => r.batch_id)
}

/** I figli queued/running oltre la scadenza (il tick li ferma). */
export function expiredSubagents(db: DatabaseSync, now: number): SubagentRow[] {
  return (db.prepare("SELECT * FROM subagents WHERE status IN ('queued','running') AND deadline_at <= ?").all(now) as unknown as SubagentDbRow[])
    .map(rowToSubagent)
}

/** Tutti gli id dei figli (il kill degli orfani del browser al boot li copre). */
export function allSubagentIds(db: DatabaseSync): string[] {
  return (db.prepare('SELECT id FROM subagents').all() as Array<{ id: string }>).map((r) => r.id)
}

/** Default del tetto globale dei figli in esecuzione (punto 4: setting subagents.maxConcurrent). */
export const DEFAULT_SUBAGENT_CONCURRENCY = 3

/** I minuti di vita di un figlio (punto 2: setting subagents.deadlineMin, default 20). */
export const DEFAULT_SUBAGENT_DEADLINE_MIN = 20
