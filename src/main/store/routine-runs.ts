// Fase 16c (C5): lo storico delle esecuzioni delle routine. I job 'routine-run'
// finiti restano nella tabella jobs ma senza un esito affidabile (retry,
// backoff, cancellazioni): routine_runs è la fonte dell'Attività globale —
// una riga per esecuzione, aperta quando il job parte e chiusa con l'esito.
// Il `reason` di un fallimento è un CODICE (credit | not-responding |
// rate-limit | cancelled | other), mai il testo grezzo del provider.
// Funzioni SQL pure: la connessione arriva da fuori, come in jobs.ts.
import type { DatabaseSync } from 'node:sqlite'
import type { ActivityFailReason } from '../../shared/types'

export interface RoutineRun {
  id: number
  routine_id: number
  agent_id: string
  title: string
  started_at: number
  ended_at: number | null
  outcome: 'ok' | 'failed' | 'cancelled'
  reason: ActivityFailReason | null
}

/** Schema della tabella (usato da db.ts e dai test su :memory:). */
export const ROUTINE_RUNS_DDL = `
    CREATE TABLE IF NOT EXISTS routine_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routine_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      outcome TEXT,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_routine_runs_started ON routine_runs(started_at);
  `

interface RunRow {
  id: number; routine_id: number; agent_id: string; title: string
  started_at: number; ended_at: number | null; outcome: string | null; reason: string | null
}

function rowToRun(r: RunRow): RoutineRun {
  return {
    id: r.id,
    routine_id: r.routine_id,
    agent_id: r.agent_id,
    title: r.title,
    started_at: r.started_at,
    ended_at: r.ended_at,
    outcome: (r.outcome as RoutineRun['outcome']) ?? 'failed',
    reason: (r.reason as ActivityFailReason | null) ?? null
  }
}

/** Apre la riga di una esecuzione (il job routine-run è partito). */
export function startRoutineRun(db: DatabaseSync, input: { routineId: number; agentId: string; title: string; now: number }): number {
  db.prepare('INSERT INTO routine_runs(routine_id, agent_id, title, started_at) VALUES(?,?,?,?)')
    .run(input.routineId, input.agentId, input.title.slice(0, 200), input.now)
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
}

/** Chiude la riga con l'esito (idempotente: una riga chiusa non si tocca). */
export function endRoutineRun(db: DatabaseSync, id: number, outcome: RoutineRun['outcome'], reason: ActivityFailReason | null, now: number): void {
  db.prepare('UPDATE routine_runs SET ended_at = ?, outcome = ?, reason = ? WHERE id = ? AND ended_at IS NULL')
    .run(now, outcome, reason, id)
}

/** Le esecuzioni da un istante in poi (le più recenti prima), per l'Attività. */
export function listRoutineRuns(db: DatabaseSync, sinceMs?: number, limit = 200): RoutineRun[] {
  const where = sinceMs !== undefined ? 'WHERE started_at >= ?' : ''
  const params = sinceMs !== undefined ? [sinceMs, limit] : [limit]
  return (db
    .prepare(`SELECT * FROM routine_runs ${where} ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(...params) as unknown as RunRow[]).map(rowToRun)
}

/** Quanto teniamo lo storico (giorni) — potatura all'avvio del daemon. */
export const ROUTINE_RUNS_KEEP_DAYS = 90

/** Cancella le righe più vecchie dei giorni di conservazione; torna quante. */
export function pruneRoutineRuns(db: DatabaseSync, now: number, keepDays = ROUTINE_RUNS_KEEP_DAYS): number {
  const r = db.prepare('DELETE FROM routine_runs WHERE started_at < ?').run(now - keepDays * 86_400_000)
  return Number(r.changes)
}

/**
 * Il CODICE del motivo di un fallimento (puro): le stesse famiglie di errori
 * che la catena delle riserve riconosce, in parole che la UI traduce.
 */
export function routineFailReason(err: unknown): ActivityFailReason {
  const status = (err as { status?: unknown }).status
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  if (/abort|interrupt|cancel/i.test(msg)) return 'cancelled'
  if (stopReasonRateLimited(err)) return 'rate-limit'
  if (typeof status === 'number' && status === 402) return 'credit'
  if (/\b402\b|credit|saldo|insufficient/i.test(msg)) return 'credit'
  if (typeof status === 'number' && status >= 500) return 'not-responding'
  if (typeof status === 'number' && (status === 401 || status === 403)) return 'credit'
  if (/timeout|timed out|etimedout|econnreset|econnrefused|fetch failed|network|terminated|HTTP 5\d\d/i.test(msg)) return 'not-responding'
  return 'other'
}

/** stopReasonOfError di loop-guard dice "rate-limit" senza importare il loop. */
function stopReasonRateLimited(err: unknown): boolean {
  const status = (err as { status?: unknown }).status
  if (typeof status === 'number' && status === 429) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /\b429\b|rate.?limit|quota/i.test(msg)
}
