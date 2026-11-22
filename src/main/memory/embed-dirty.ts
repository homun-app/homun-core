// D4 (fase deleghe): la bandiera «sporco» dell'incorporazione — il tick dei
// 30 s accoda il job memory-embed SOLO per i bot con celle davvero da
// incorporare (78.352 righe di memory-embed al giorno, quasi tutte a vuoto:
// il tick le chiedeva per TUTTI a ogni giro). La bandiera è un elenco di id
// nello settings del DB: leggera, senza motore, scritta da chi aggiunge
// testo alle celle (memory-store, history-store) e letta dal tick. Tolta
// quando il job gira col modello presente e non resta niente da incorporare
// (run-job); la partenza del daemon la segna per TUTTI una volta, così le
// celle scritte prima (o col modello assente) restano incorporabili.
import type { DatabaseSync } from 'node:sqlite'

const DIRTY_KEY = 'memory.embedDirtyAgents'

function readDirty(db: DatabaseSync): string[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(DIRTY_KEY) as { value: string } | undefined
  if (!row) return []
  try {
    const v = JSON.parse(row.value)
    return Array.isArray(v) ? v.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function writeDirty(db: DatabaseSync, ids: string[]): void {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(DIRTY_KEY, JSON.stringify([...new Set(ids)]))
}

/** I bot con celle da incorporare (l'ordine è quello di scrittura). */
export function embedDirtyAgents(db: DatabaseSync): string[] {
  return readDirty(db)
}

/** Una scrittura in memoria ha lasciato celle da incorporare per questo bot. */
export function markEmbedDirtyFor(db: DatabaseSync, agentId: string): void {
  writeDirty(db, [...readDirty(db), agentId])
}

/** Il job ha incorporato tutto (col modello presente): la bandiera si toglie. */
export function clearEmbedDirty(db: DatabaseSync, agentId: string): void {
  writeDirty(db, readDirty(db).filter((x) => x !== agentId))
}

/** La partenza del daemon: tutti sporchi una volta (le celle vecchie restano incorporabili). */
export function markAllEmbedDirty(db: DatabaseSync, agentIds: string[]): void {
  writeDirty(db, [...new Set([...readDirty(db), ...agentIds])])
}

/**
 * Il tick (D4): accoda il job memory-embed SOLO per gli agenti con la
 * bandiera, col coalesce di sempre (un job per agente mentre uno è in coda o
 * in lease; runAt in fondo alla coda come EMBED_JOB_DELAY_MS di engine.ts).
 * Ritorna gli id accodati.
 */
export function enqueueEmbedPendingDirty(db: DatabaseSync, agentIds: string[], now = Date.now()): string[] {
  const dirty = new Set(readDirty(db))
  const enqueued: string[] = []
  for (const id of agentIds) {
    if (!dirty.has(id)) continue
    const queued = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'memory-embed' AND status IN ('queued','leased') AND agent_id = ?")
      .get(id) as { n: number }
    if (queued.n > 0) continue
    db.prepare('INSERT INTO jobs(agent_id, kind, payload_json, run_at, status, attempts, created_at) VALUES(?,?,?,?,?,0,?)')
      .run(id, 'memory-embed', '{}', now + 20_000, 'queued', now)
    enqueued.push(id)
  }
  return enqueued
}
