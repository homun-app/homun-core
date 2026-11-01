// Le AZIONI SUI FILE del computer del bot (fase 19b, T4.1): tabella piccola e
// durevole `computer_actions` — il feed «Attività» unisce queste righe alle
// shell_jobs, che registrano già OGNI run-command. Come shell-jobs: funzioni
// SQL pure che ricevono la connessione, così i test girano su un :memory:.
//
// Regole (dalla spec, come Rakazo):
// - si tengono al MASSIMO 300 righe per owner_id: le più vecchie si cancellano
//   all'inserimento;
// - `target` è il path del box (per copy_out/download anche il NOME del file
//   del Mac, MAI il percorso completo);
// - NESSUN contenuto di file, mai;
// - un errore nel registrare NON fa fallire il tool: la riga c'è col campo
//   error, oppure non c'è affatto e si logga nel daemon.
import type { DatabaseSync } from 'node:sqlite'

/** Quante righe teniamo per proprietario. */
export const COMPUTER_ACTIONS_PER_OWNER_MAX = 300

export type ComputerActionKind = 'write_file' | 'copy_in' | 'copy_out' | 'upload' | 'download'

export interface ComputerAction {
  id: string
  agent_id: string
  owner_id: string
  actor: 'bot' | 'user'
  kind: ComputerActionKind
  target: string
  bytes: number | null
  error: string | null
  created_at: number
}

interface ComputerActionRow {
  id: string; agent_id: string; owner_id: string; actor: string; kind: string
  target: string; bytes: number | null; error: string | null; created_at: number
}

export const COMPUTER_ACTIONS_DDL = `
    CREATE TABLE IF NOT EXISTS computer_actions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      bytes INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_computer_actions_owner ON computer_actions(owner_id, created_at);
  `

function rowToAction(r: ComputerActionRow): ComputerAction {
  return {
    id: r.id, agent_id: r.agent_id, owner_id: r.owner_id,
    actor: r.actor as ComputerAction['actor'], kind: r.kind as ComputerActionKind,
    target: r.target, bytes: r.bytes, error: r.error, created_at: r.created_at
  }
}

/** Inserisce una riga e RIORDINA il tetto: max 300 per owner_id, le vecchie via. */
export function createComputerAction(db: DatabaseSync, action: ComputerAction): ComputerAction {
  db.prepare(`
    INSERT INTO computer_actions(id, agent_id, owner_id, actor, kind, target, bytes, error, created_at)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(
    action.id, action.agent_id, action.owner_id, action.actor, action.kind,
    action.target, action.bytes, action.error, action.created_at
  )
  db.prepare(`
    DELETE FROM computer_actions
    WHERE owner_id = ? AND id NOT IN (
      SELECT id FROM computer_actions WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
    )
  `).run(action.owner_id, action.owner_id, COMPUTER_ACTIONS_PER_OWNER_MAX)
  return action
}

/** Le ultime N azioni di un proprietario, dalla più recente. */
export function recentComputerActionsOf(db: DatabaseSync, ownerId: string, limit: number): ComputerAction[] {
  return (
    db.prepare('SELECT * FROM computer_actions WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(ownerId, limit) as unknown as ComputerActionRow[]
  ).map(rowToAction)
}

/** Un'azione per id (activity:output). */
export function getComputerAction(db: DatabaseSync, id: string): ComputerAction | null {
  const r = db.prepare('SELECT * FROM computer_actions WHERE id = ?').get(id) as ComputerActionRow | undefined
  return r ? rowToAction(r) : null
}

/** Quante righe restano per un proprietario (per i test del tetto). */
export function computerActionCountOf(db: DatabaseSync, ownerId: string): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM computer_actions WHERE owner_id = ?').get(ownerId) as { n: number }
  return r.n
}
