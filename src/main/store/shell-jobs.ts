// Coda dei comandi in BACKGROUND (fase 11, punto 3): tabella durevole
// `shell_jobs` — id, agente, comando REDATTO (i {{secret:NOME}} restano
// riferimenti), avvio, stato, exit, path del log. Come jobs.ts: funzioni SQL
// pure che ricevono la connessione, così i test girano su un :memory: senza
// Electron né processi veri.
import type { DatabaseSync } from 'node:sqlite'

/** Tetti della specifica: 4 comandi in background per bot, 8 per box. */
export const SHELLS_PER_AGENT_MAX = 4
export const SHELLS_PER_BOX_MAX = 8

/** Durata massima di un comando in background: oltre, kill con notifica. */
export const SHELL_MAX_DURATION_MS = 6 * 60 * 60_000

export type ShellJobStatus = 'running' | 'done' | 'killed' | 'lost' | 'expired'

export interface ShellJob {
  id: string
  agent_id: string
  /** il comando COME SCRITTO DAL MODELLO, coi riferimenti {{secret:NOME}} (mai i valori) */
  command: string
  /** nomi dei segreti usati (per redarre l'output alla lettura; mai i valori) */
  secret_names: string[]
  mode: 'host' | 'docker'
  /** pid del processo (host) o del wrapper nel container (docker) */
  pid: number | null
  /** path del log RELATIVO alla home del bot nel box */
  log_path: string
  started_at: number
  status: ShellJobStatus
  exit_code: number | null
  finished_at: number | null
  /** il bot ha già letto l'esito con await_shell (niente notifica SHELL_DONE) */
  awaited: boolean
  /** la notifica SHELL_DONE è già stata accodata */
  notified: boolean
}

interface ShellJobRow {
  id: string; agent_id: string; command: string; secret_names: string; mode: string
  pid: number | null; log_path: string; started_at: number; status: string
  exit_code: number | null; finished_at: number | null; awaited: number; notified: number
}

export const SHELL_JOBS_DDL = `
    CREATE TABLE IF NOT EXISTS shell_jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      command TEXT NOT NULL,
      secret_names TEXT NOT NULL DEFAULT '[]',
      mode TEXT NOT NULL,
      pid INTEGER,
      log_path TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      finished_at INTEGER,
      awaited INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_shell_jobs_agent ON shell_jobs(agent_id, status);
  `

function rowToJob(r: ShellJobRow): ShellJob {
  return {
    id: r.id, agent_id: r.agent_id, command: r.command,
    secret_names: JSON.parse(r.secret_names) as string[],
    mode: r.mode as 'host' | 'docker', pid: r.pid, log_path: r.log_path,
    started_at: r.started_at, status: r.status as ShellJobStatus,
    exit_code: r.exit_code, finished_at: r.finished_at,
    awaited: r.awaited === 1, notified: r.notified === 1
  }
}

export function createShellJob(db: DatabaseSync, job: Omit<ShellJob, 'status' | 'exit_code' | 'finished_at' | 'awaited' | 'notified'>): ShellJob {
  db.prepare(`
    INSERT INTO shell_jobs(id, agent_id, command, secret_names, mode, pid, log_path, started_at, status)
    VALUES(?,?,?,?,?,?,?,?, 'running')
  `).run(job.id, job.agent_id, job.command, JSON.stringify(job.secret_names), job.mode, job.pid, job.log_path, job.started_at)
  return getShellJob(db, job.id)!
}

export function getShellJob(db: DatabaseSync, id: string): ShellJob | null {
  const r = db.prepare('SELECT * FROM shell_jobs WHERE id = ?').get(id) as ShellJobRow | undefined
  return r ? rowToJob(r) : null
}

export function updateShellJob(db: DatabaseSync, id: string, patch: Partial<Pick<ShellJob, 'status' | 'exit_code' | 'finished_at' | 'pid' | 'awaited' | 'notified'>>): void {
  const cur = getShellJob(db, id)
  if (!cur) return
  db.prepare('UPDATE shell_jobs SET status = ?, exit_code = ?, finished_at = ?, pid = ?, awaited = ?, notified = ? WHERE id = ?')
    .run(
      patch.status ?? cur.status,
      patch.exit_code !== undefined ? patch.exit_code : cur.exit_code,
      patch.finished_at !== undefined ? patch.finished_at : cur.finished_at,
      patch.pid !== undefined ? patch.pid : cur.pid,
      (patch.awaited ?? cur.awaited) ? 1 : 0,
      (patch.notified ?? cur.notified) ? 1 : 0,
      id
    )
}

/** I comandi in background ancora in corsa per un agente (tetto per bot). */
export function runningShellJobsOf(db: DatabaseSync, agentId: string): ShellJob[] {
  return (db.prepare("SELECT * FROM shell_jobs WHERE agent_id = ? AND status = 'running' ORDER BY started_at").all(agentId) as unknown as ShellJobRow[]).map(rowToJob)
}

/** Tutti i comandi in background in corsa nel box (tetto condiviso). */
export function runningShellJobsAll(db: DatabaseSync): ShellJob[] {
  return (db.prepare("SELECT * FROM shell_jobs WHERE status = 'running' ORDER BY started_at").all() as unknown as ShellJobRow[]).map(rowToJob)
}
