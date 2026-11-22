// PL3 (fase plugin): l'INDICE dell'uso degli strumenti — tabella piccola e
// durevole `tool_use` (entry_id, tool, agent_id, at). Si scrive quando un
// tool-call entra nel transcript (appendEntry) e quando una skill si invoca
// con /nome (skill:<nome>); il BACKFILL idempotente copia i tool-call GIÀ
// registrati nei transcript esistenti, una volta. La tabella «Collegati»
// della pagina Plugin legge UNA query aggregata indicizzata (ultimo uso +
// conteggio della settimana, come A1 per il centro «Da approvare»): niente
// scansioni dei transcript a ogni apertura. Come computer-actions e
// shell-jobs: funzioni SQL pure che ricevono la connessione.
import type { DatabaseSync } from 'node:sqlite'
import { db as defaultDb } from './db'

export const TOOL_USE_DDL = `
    CREATE TABLE IF NOT EXISTS tool_use (
      entry_id INTEGER PRIMARY KEY,
      tool TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      allowed_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_use_tool ON tool_use(tool, at);
    CREATE INDEX IF NOT EXISTS idx_tool_use_allowed ON tool_use(allowed_by, at);
  `

export interface ToolUseInput {
  /** l'id della voce del transcript che registra l'uso (univoco: i doppioni si ignorano) */
  entryId: number
  tool: string
  agentId: string
  at: number
}

export interface ToolUseSummary {
  tool: string
  /** l'ultimo uso (epoch ms) */
  last: number
  /** quante volte negli ultimi 7 giorni */
  week: number
}

interface ToolUseRow { tool: string; last: number; week: number }

/** Registra un uso (INSERT OR IGNORE: l'entry_id è la chiave, un giro di nuovo non duplica). */
export function recordToolUse(db: DatabaseSync, e: ToolUseInput): void {
  db.prepare('INSERT OR IGNORE INTO tool_use (entry_id, tool, agent_id, at) VALUES (?, ?, ?, ?)')
    .run(BigInt(e.entryId), e.tool, e.agentId, BigInt(e.at))
}

/**
 * Il BACKFILL dei tool-call già registrati nei transcript: idempotente
 * (INSERT OR IGNORE per entry_id), una volta all'apertura del db.
 */
export function backfillToolUse(db: DatabaseSync): void {
  db.exec(`INSERT OR IGNORE INTO tool_use (entry_id, tool, agent_id, at)
    SELECT id, content, agent_id, created_at FROM entries WHERE kind = 'tool-call'`)
}

/**
 * L'aggregato indicizzato per la tabella «Collegati»: per ogni strumento
 * l'ultimo uso e quante volte nella finestra (la settimana). UNA query,
 * l'indice sul tool: costa come il numero degli strumenti, non dei turni.
 */
export function toolUseSummaries(db: DatabaseSync = defaultDb(), weekSinceMs: number): ToolUseSummary[] {
  const rows = db.prepare(
    'SELECT tool, MAX(at) AS last, SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS week FROM tool_use GROUP BY tool'
  ).all(BigInt(weekSinceMs)) as unknown as ToolUseRow[]
  return rows.map((r) => ({ tool: r.tool, last: Number(r.last), week: Number(r.week) }))
}

/**
 * L'uso di UN plugin dal suo prefisso (mcp__<slug>__, composio__<tk>__,
 * skill:<nome>): l'ultimo uso e la somma della settimana dei suoi
 * strumenti. Null quando il plugin non ha usi registrati.
 */
export function pluginUseOf(summaries: readonly ToolUseSummary[], prefix: string): { last: number; week: number } | null {
  let last = -1
  let week = 0
  for (const s of summaries) {
    if (!s.tool.startsWith(prefix)) continue
    if (s.last > last) last = s.last
    week += s.week
  }
  return last < 0 ? null : { last, week }
}
