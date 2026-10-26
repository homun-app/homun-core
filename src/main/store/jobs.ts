// Coda durevole (tabella jobs): il runtime degli agenti vive nel daemon e il
// lavoro sopravvive a crash e riavvii (§6.2). Funzioni SQL pure: ricevono la
// connessione e l'istante corrente, niente timer né effetti nascosti, così i
// test girano su un :memory: senza Electron.
import type { DatabaseSync } from 'node:sqlite'

export type JobKind = 'user-message' | 'routine-run'
export type JobStatus = 'queued' | 'leased' | 'done' | 'failed'

export interface Job {
  id: number
  agent_id: string
  kind: JobKind
  payload: Record<string, unknown>
  run_at: number
  status: JobStatus
  lease_until: number | null
  attempts: number
  last_error: string | null
  created_at: number
}

interface JobRow {
  id: number; agent_id: string; kind: string; payload_json: string; run_at: number
  status: string; lease_until: number | null; attempts: number; last_error: string | null; created_at: number
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id, agent_id: r.agent_id, kind: r.kind as JobKind, payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    run_at: r.run_at, status: r.status as JobStatus, lease_until: r.lease_until,
    attempts: r.attempts, last_error: r.last_error, created_at: r.created_at
  }
}

/** Schema della coda (usato da db.ts e dai test su :memory:). */
export const JOBS_DDL = `
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      lease_until INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs(agent_id, status);
  `

export interface EnqueueInput {
  agentId: string
  kind: JobKind
  payload: Record<string, unknown>
  runAt: number
  now: number
}

export function enqueueJob(db: DatabaseSync, input: EnqueueInput): Job {
  db.prepare('INSERT INTO jobs(agent_id, kind, payload_json, run_at, status, attempts, created_at) VALUES(?,?,?,?,?,0,?)')
    .run(input.agentId, input.kind, JSON.stringify(input.payload), input.runAt, 'queued', input.now)
  const id = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
  return getJobById(db, id)!
}

export function getJobById(db: DatabaseSync, id: number): Job | null {
  const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
  return r ? rowToJob(r) : null
}

/** Job in lease (attivo) per un agente: al più UN job attivo per agente. */
export function activeJobForAgent(db: DatabaseSync, agentId: string): Job | null {
  const r = db.prepare("SELECT * FROM jobs WHERE agent_id = ? AND status = 'leased'").get(agentId) as JobRow | undefined
  return r ? rowToJob(r) : null
}

/** Messaggi utente in attesa per un agente (il tetto coda della fase 1). */
export function pendingUserMessages(db: DatabaseSync, agentId: string): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE agent_id = ? AND status = 'queued' AND kind = 'user-message'").get(agentId) as { n: number }
  return r.n
}

/**
 * Riporta in coda i job con lease scaduto (crash del worker): al riavvio i
 * `leased` orfani tornano `queued` e verranno ripresi col prossimo tick.
 */
export function recoverExpiredLeases(db: DatabaseSync, now: number): number {
  const r = db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'leased' AND lease_until IS NOT NULL AND lease_until <= ?")
    .run(now)
  return Number(r.changes)
}

/**
 * Prende in lease i job dovuti: candidate `queued` con run_at<=now per agenti
 * senza job attivi, poi claim atomico per riga con UPDATE … RETURNING. La
 * clausola "agente senza lease attivo" è ripetuta DENTRO l'UPDATE: due job
 * dello stesso agente tra i candidati non vengono mai presi insieme (il
 * secondo vede il primo già leased dalla statement precedente).
 */
export function claimDueJobs(db: DatabaseSync, now: number, leaseMs: number, limit = 5): Job[] {
  const candidates = db.prepare(`
    SELECT id FROM jobs
    WHERE status = 'queued' AND run_at <= ?
      AND agent_id NOT IN (SELECT agent_id FROM jobs WHERE status = 'leased')
    ORDER BY run_at, id
    LIMIT ?
  `).all(now, limit) as Array<{ id: number }>
  const claimed: Job[] = []
  for (const c of candidates) {
    const rows = db.prepare(`
      UPDATE jobs SET status = 'leased', lease_until = ?, attempts = attempts + 1
      WHERE id = ? AND status = 'queued'
        AND agent_id NOT IN (SELECT agent_id FROM jobs WHERE status = 'leased')
      RETURNING *
    `).all(now + leaseMs, c.id) as unknown as JobRow[]
    if (rows[0]) claimed.push(rowToJob(rows[0]))
  }
  return claimed
}

/** Rinnova il lease di un job in corso (heartbeat): true se il job era ancora in lease. */
export function renewLease(db: DatabaseSync, jobId: number, now: number, leaseMs: number): boolean {
  const r = db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ? AND status = 'leased'").run(now + leaseMs, jobId)
  return Number(r.changes) > 0
}

export function completeJob(db: DatabaseSync, jobId: number): void {
  db.prepare("UPDATE jobs SET status = 'done', lease_until = NULL WHERE id = ?").run(jobId)
}

/** Backoff esponenziale tra i tentativi: 30s · 60s · 120s · 240s dopo i primi 4 fallimenti. */
export function retryDelayMs(attempts: number): number {
  return 30_000 * 2 ** Math.max(0, attempts - 1)
}

export const MAX_ATTEMPTS = 5

export type FailOutcome = 'retry' | 'failed'

/**
 * Registra l'esito negativo di un tentativo: sotto il massimo riprova in
 * coda con backoff esponenziale, altrimenti il job è `failed` per sempre.
 */
export function failJob(db: DatabaseSync, job: Job, now: number, error: string): FailOutcome {
  if (job.attempts >= MAX_ATTEMPTS) {
    db.prepare("UPDATE jobs SET status = 'failed', lease_until = NULL, last_error = ? WHERE id = ?").run(error, job.id)
    return 'failed'
  }
  db.prepare("UPDATE jobs SET status = 'queued', lease_until = NULL, run_at = ?, last_error = ? WHERE id = ?")
    .run(now + retryDelayMs(job.attempts), error, job.id)
  return 'retry'
}

/** Azzera i job di un agente eliminato (né eseguibili né recuperabili). */
export function cancelAgentJobs(db: DatabaseSync, agentId: string): void {
  db.prepare("DELETE FROM jobs WHERE agent_id = ? AND status IN ('queued','leased')").run(agentId)
}
