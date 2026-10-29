// Store della LIBRERIA (fase 14, punto 1): un posto solo per tutto ciò che i
// bot PRODUCONO per l'utente — documenti (con versioni), grafici e file. La
// tabella library_items vive nel DB del daemon; i contenuti stanno in
// <dataDir>/library/<id>/. La libreria è dell'UTENTE: tutti i suoi bot la
// vedono e ogni voce dice chi l'ha creata (author_agent_id). Il bot NON
// cancella: delete/rename/pin sono azioni dell'utente dalla UI.
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { db, dataDir } from './db'

/** La DDL della tabella (eseguita da db.ts insieme alle altre). */
export const LIBRARY_DDL = `
    CREATE TABLE IF NOT EXISTS library_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      author_agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      pinned INTEGER DEFAULT 0,
      tainted INTEGER DEFAULT 0,
      current_version INTEGER DEFAULT 1,
      chart_kind TEXT,
      file_name TEXT,
      file_sha256 TEXT,
      file_size INTEGER,
      file_mime TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_library_updated ON library_items(updated_at DESC);`

export type LibraryKind = 'document' | 'chart' | 'file'

export interface LibraryItem {
  id: string
  kind: LibraryKind
  title: string
  authorAgentId: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  /** punto 6: la voce nasce/è stata scritta in un turno contaminato */
  tainted: boolean
  /** per document: la versione corrente (v<n>.md) */
  currentVersion: number
  /** per chart: vega-lite | mermaid */
  chartKind?: 'vega-lite' | 'mermaid' | null
  fileName?: string | null
  fileSha256?: string | null
  fileSize?: number | null
  fileMime?: string | null
}

interface LibraryRow {
  id: string; kind: string; title: string; author_agent_id: string
  created_at: number; updated_at: number; pinned: number; tainted: number
  current_version: number; chart_kind: string | null; file_name: string | null
  file_sha256: string | null; file_size: number | null; file_mime: string | null
}

function rowToItem(r: LibraryRow): LibraryItem {
  return {
    id: r.id, kind: r.kind as LibraryKind, title: r.title, authorAgentId: r.author_agent_id,
    createdAt: r.created_at, updatedAt: r.updated_at, pinned: !!r.pinned, tainted: !!r.tainted,
    currentVersion: r.current_version, chartKind: (r.chart_kind as LibraryItem['chartKind']) ?? null,
    fileName: r.file_name, fileSha256: r.file_sha256, fileSize: r.file_size, fileMime: r.file_mime
  }
}

/** Un id nuovo di voce: lib_<8 hex>. */
export function newLibraryId(): string {
  return 'lib_' + randomBytes(4).toString('hex')
}

/** La cartella dei contenuti della libreria (creata al primo uso). */
export function libraryRoot(): string {
  const dir = join(dataDir(), 'library')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** La cartella di una voce. */
export function libraryItemDir(id: string): string {
  return join(libraryRoot(), id)
}

export function insertLibraryItem(item: LibraryItem): LibraryItem {
  db()
    .prepare(
      `INSERT INTO library_items(id, kind, title, author_agent_id, created_at, updated_at, pinned, tainted, current_version, chart_kind, file_name, file_sha256, file_size, file_mime)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      item.id, item.kind, item.title, item.authorAgentId, item.createdAt, item.updatedAt,
      item.pinned ? 1 : 0, item.tainted ? 1 : 0, item.currentVersion, item.chartKind ?? null,
      item.fileName ?? null, item.fileSha256 ?? null, item.fileSize ?? null, item.fileMime ?? null
    )
  return item
}

export function getLibraryItem(id: string): LibraryItem | null {
  const r = db().prepare('SELECT * FROM library_items WHERE id = ?').get(id) as LibraryRow | undefined
  return r ? rowToItem(r) : null
}

export function updateLibraryItem(id: string, patch: Partial<Pick<LibraryItem, 'title' | 'updatedAt' | 'pinned' | 'tainted' | 'currentVersion'>>): void {
  const cur = getLibraryItem(id)
  if (!cur) return
  db()
    .prepare('UPDATE library_items SET title=?, updated_at=?, pinned=?, tainted=?, current_version=? WHERE id=?')
    .run(
      patch.title ?? cur.title, patch.updatedAt ?? cur.updatedAt,
      (patch.pinned ?? cur.pinned) ? 1 : 0, (patch.tainted ?? cur.tainted) ? 1 : 0,
      patch.currentVersion ?? cur.currentVersion, id
    )
}

/**
 * La lista (punto 4): le FISSATE prima, poi le altre dalle più recenti; filtro
 * per kind e per query sul titolo (case-insensitive); al massimo `limit` righe
 * (default 20, tetto 20).
 */
export function listLibraryItems(opts: { query?: string; kind?: LibraryKind; limit?: number } = {}): LibraryItem[] {
  const limit = Math.min(20, Math.max(1, opts.limit ?? 20))
  const rows = db()
    .prepare('SELECT * FROM library_items ORDER BY pinned DESC, updated_at DESC')
    .all() as unknown as LibraryRow[]
  const q = (opts.query ?? '').trim().toLowerCase()
  return rows
    .map(rowToItem)
    .filter((i) => (opts.kind ? i.kind === opts.kind : true))
    .filter((i) => (q ? i.title.toLowerCase().includes(q) : true))
    .slice(0, limit)
}

/** Tutte le voci (per il conteggio dello spazio nelle Impostazioni). */
export function allLibraryItems(): LibraryItem[] {
  return (db().prepare('SELECT * FROM library_items ORDER BY updated_at DESC').all() as unknown as LibraryRow[]).map(rowToItem)
}

/**
 * Cancella una voce E la sua cartella (azione dell'utente dalla UI, mai dei
 * bot: nessun tool la chiama).
 */
export function deleteLibraryItem(id: string): boolean {
  if (!getLibraryItem(id)) return false
  db().prepare('DELETE FROM library_items WHERE id = ?').run(id)
  try {
    rmSync(libraryItemDir(id), { recursive: true, force: true })
  } catch {
    // cartella assente o non eliminabile: la riga è già via
  }
  return true
}
