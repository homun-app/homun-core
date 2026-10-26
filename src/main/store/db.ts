// Store persistente: SQLite via node:sqlite (nativo, zero rebuild) — transcript event-sourced
// come l'originale (CommitTranscriptEntries).
//
// Fase 2: nessuna dipendenza da electron.app — il path dei dati arriva
// dall'esterno (arg --data del daemon, env SANDBOT_DATA_DIR, o setDataDir
// chiamato dal main Electron), così lo stesso store serve app e daemon.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JOBS_DDL } from './jobs'
import type { Agent, TranscriptEntry, PermissionsConfig } from '../../shared/types'

let _dir: string | null = null

/** Sostituisce la directory dati (main Electron: userData/data). */
export function setDataDir(dir: string): void {
  _dir = dir
}

export function dataDir(): string {
  const dir = _dir ?? process.env.SANDBOT_DATA_DIR ?? join(homedir(), '.sandbot', 'data')
  mkdirSync(dir, { recursive: true })
  return dir
}

function open(): DatabaseSync {
  const db = new DatabaseSync(join(dataDir(), 'sandbot.db'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      provider_id TEXT,
      model TEXT,
      status TEXT DEFAULT 'offline',
      unread INTEGER DEFAULT 0,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT DEFAULT '',
      meta TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_entries_agent ON entries(agent_id, id);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      target TEXT NOT NULL,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      input TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS routines (
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      last_run INTEGER,
      created_at INTEGER,
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT DEFAULT '',
      timezone TEXT DEFAULT '',
      provenance TEXT DEFAULT 'user'
    );
    ${JOBS_DDL}
  `)
  // fase 4: colonne nuove delle routine per i DB esistenti (CREATE TABLE IF
  // NOT EXISTS non le aggiunge); provenance distingue le routine dell'utente
  // da quelle create dall'agente via update_state
  const routineCols = db.prepare("SELECT name FROM pragma_table_info('routines')").all() as Array<{ name: string }>
  const present = new Set(routineCols.map((c) => c.name))
  for (const [col, ddl] of [
    ['description', "ALTER TABLE routines ADD COLUMN description TEXT DEFAULT ''"],
    ['timezone', "ALTER TABLE routines ADD COLUMN timezone TEXT DEFAULT ''"],
    ['provenance', "ALTER TABLE routines ADD COLUMN provenance TEXT DEFAULT 'user'"]
  ] as const) {
    if (!present.has(col)) db.exec(ddl)
  }
  return db
}

let _db: DatabaseSync | null = null
export function db(): DatabaseSync {
  if (!_db) _db = open()
  return _db
}

// ---- settings ----
export function getSetting<T>(key: string, fallback: T): T {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? (JSON.parse(row.value) as T) : fallback
}

export function setSetting(key: string, value: unknown): void {
  db()
    .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}

// ---- agents ----
interface AgentRow {
  id: string; name: string; description: string; provider_id: string | null
  model: string | null; status: string; unread: number; created_at: number
}

function rowToAgent(r: AgentRow): Agent {
  return {
    id: r.id, name: r.name, description: r.description, providerId: r.provider_id,
    model: r.model, status: r.status as Agent['status'], unread: r.unread, createdAt: r.created_at
  }
}

export function listAgents(): Agent[] {
  const rows = db().prepare('SELECT * FROM agents ORDER BY created_at').all() as unknown as AgentRow[]
  return rows.map(rowToAgent)
}

export function getAgent(id: string): Agent | null {
  const r = db().prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
  return r ? rowToAgent(r) : null
}

export function createAgent(name: string, description = ''): Agent {
  const id = 'agent_' + crypto.randomUUID().slice(0, 8)
  const now = Date.now()
  db()
    .prepare('INSERT INTO agents(id, name, description, status, created_at) VALUES(?,?,?,?,?)')
    .run(id, name, description, 'idle', now)
  return { id, name, description, providerId: null, model: null, status: 'idle', unread: 0, createdAt: now }
}

export function updateAgent(id: string, patch: Partial<Pick<Agent, 'name' | 'description' | 'providerId' | 'model' | 'status' | 'unread'>>): void {
  const a = getAgent(id)
  if (!a) return
  db()
    .prepare('UPDATE agents SET name=?, description=?, provider_id=?, model=?, status=?, unread=? WHERE id=?')
    .run(
      patch.name ?? a.name, patch.description ?? a.description, patch.providerId ?? a.providerId,
      patch.model ?? a.model, patch.status ?? a.status, patch.unread ?? a.unread, id
    )
}

export function deleteAgent(id: string): void {
  // fase 5 (residuo 0d): si rimuove solo un agente ESISTENTE (il path della
  // directory si costruisce dal suo id, mai da input libero)
  if (!getAgent(id)) return
  db().prepare('DELETE FROM agents WHERE id=?').run(id)
  db().prepare('DELETE FROM entries WHERE agent_id=?').run(id)
  // memoria e skill su disco non restano orfane
  try {
    rmSync(join(dataDir(), 'agents', id), { recursive: true, force: true })
  } catch {
    // directory assente o non eliminabile: le righe sono già via
  }
}

// ---- transcript (event-sourced) ----
export interface AppendEntry {
  agentId: string
  kind: TranscriptEntry['kind']
  role: TranscriptEntry['role']
  content: string
  meta?: Record<string, unknown>
}

export function appendEntry(e: AppendEntry): TranscriptEntry {
  const now = Date.now()
  const r = db()
    .prepare('INSERT INTO entries(agent_id, kind, role, content, meta, created_at) VALUES(?,?,?,?,?,?)')
    .run(e.agentId, e.kind, e.role, e.content, e.meta ? JSON.stringify(e.meta) : null, now)
  const id = Number(r.lastInsertRowid)
  return { id, agentId: e.agentId, kind: e.kind, role: e.role, content: e.content, meta: e.meta ?? null, createdAt: now }
}

export function getEntries(agentId: string, afterId = 0): TranscriptEntry[] {
  const rows = db()
    .prepare('SELECT * FROM entries WHERE agent_id = ? AND id > ? ORDER BY id')
    .all(agentId, afterId) as Array<{ id: number; agent_id: string; kind: string; role: string; content: string; meta: string | null; created_at: number }>
  return rows.map((r) => ({
    id: r.id, agentId: r.agent_id, kind: r.kind as TranscriptEntry['kind'], role: r.role as TranscriptEntry['role'],
    content: r.content, meta: r.meta ? JSON.parse(r.meta) : null, createdAt: r.created_at
  }))
}

export function updateEntryContent(id: number, content: string): void {
  db().prepare('UPDATE entries SET content = ? WHERE id = ?').run(content, id)
}

export function updateEntryMeta(id: number, meta: Record<string, unknown>): void {
  db().prepare('UPDATE entries SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id)
}

// ---- grants (standing grants come l'originale) ----
export interface Grant { id: number; tool: string; target: string; createdAt: number }

export function listGrants(): Grant[] {
  return db().prepare('SELECT * FROM grants').all() as unknown as Grant[]
}

export function addGrant(tool: string, target: string): void {
  db().prepare('INSERT INTO grants(tool, target, created_at) VALUES(?,?,?)').run(tool, target, Date.now())
}

export function removeGrant(id: number): void {
  db().prepare('DELETE FROM grants WHERE id=?').run(id)
}

// ---- permissions ----
export function getPermissions(): PermissionsConfig {
  return getSetting<PermissionsConfig>('permissions', {
    default: 'needs_approval',
    rules: [
      // fase 3: i tool di comunicazione sono sempre consentiti (il gate non
      // serve: sono l'unico modo che il modello ha di parlare con l'utente e
      // non hanno effetti fuori dal transcript)
      { tool: 'send_to_user', pattern: '*', mode: 'always_allow' },
      { tool: 'ask_user', pattern: '*', mode: 'always_allow' },
      { tool: 'draft_external', pattern: '*', mode: 'always_allow' },
      { tool: 'read-file', pattern: '*', mode: 'always_allow' },
      { tool: 'list-directory', pattern: '*', mode: 'always_allow' },
      { tool: 'write-file', pattern: '*', mode: 'needs_approval' },
      { tool: 'run-command', pattern: '*', mode: 'needs_approval' },
      { tool: 'use-app', pattern: 'screenshot', mode: 'always_allow' },
      { tool: 'use-app', pattern: '*', mode: 'needs_approval' },
      { tool: 'list-credentials', pattern: '*', mode: 'always_allow' },
      // fase 4: memoria e lettura skill toccano solo i file dell'agente (il
      // gate in permissions.check le consente comunque, anche con config
      // utente personalizzata); update_skill cambia il comportamento futuro
      // dell'agente → ask; update_state decide per azione (update-state.ts)
      { tool: 'update_memory', pattern: '*', mode: 'always_allow' },
      { tool: 'recall_memory', pattern: '*', mode: 'always_allow' },
      { tool: 'skill', pattern: '*', mode: 'always_allow' },
      { tool: 'update_skill', pattern: '*', mode: 'needs_approval' },
      { tool: 'mcp__*', pattern: '*', mode: 'needs_approval' }
    ]
  })
}

export function setPermissions(cfg: PermissionsConfig): void {
  setSetting('permissions', cfg)
}

// ---- providers ----
export function listProviders(): import('../../shared/types').ProviderConfig[] {
  return getSetting<import('../../shared/types').ProviderConfig[]>('providers', [])
}

export function saveProviders(ps: import('../../shared/types').ProviderConfig[]): void {
  setSetting('providers', ps)
}

// ---- routines (attività ricorrenti, come le "Routines" dell'originale) ----
export interface Routine {
  id: number; agent_id: string; title: string; prompt: string
  schedule: string; enabled: number; last_run: number | null; created_at: number
  /** fase 4: descrizione e fuso orario (update_state), chi ha creato la routine */
  description?: string; timezone?: string; provenance?: 'user' | 'agent'
}

export function listRoutines(agentId?: string): Routine[] {
  const q = agentId ? 'SELECT * FROM routines WHERE agent_id = ? ORDER BY id' : 'SELECT * FROM routines ORDER BY id'
  return (agentId ? db().prepare(q).all(agentId) : db().prepare(q).all()) as unknown as Routine[]
}

export function getRoutine(id: number): Routine | null {
  return (db().prepare('SELECT * FROM routines WHERE id = ?').get(id) as unknown as Routine | undefined) ?? null
}

/** Campi opzionali alla creazione: le routine dell'agente (update_state) nascono in pausa con provenance 'agent'. */
export interface CreateRoutineOpts {
  enabled?: number
  provenance?: 'user' | 'agent'
  description?: string
  timezone?: string
}

export function createRoutine(agentId: string, title: string, prompt: string, schedule: string, opts: CreateRoutineOpts = {}): Routine {
  const now = Date.now()
  const r = db()
    .prepare('INSERT INTO routines(agent_id, title, prompt, schedule, enabled, created_at, description, timezone, provenance) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(agentId, title, prompt, schedule, opts.enabled ?? 1, now, opts.description ?? '', opts.timezone ?? '', opts.provenance ?? 'user')
  return {
    id: Number(r.lastInsertRowid), agent_id: agentId, title, prompt, schedule,
    enabled: opts.enabled ?? 1, last_run: null, created_at: now,
    description: opts.description ?? '', timezone: opts.timezone ?? '', provenance: opts.provenance ?? 'user'
  }
}

export function updateRoutine(id: number, patch: Partial<Pick<Routine, 'enabled' | 'schedule' | 'title' | 'prompt' | 'description' | 'timezone' | 'provenance'>>): void {
  const cur = db().prepare('SELECT * FROM routines WHERE id = ?').get(id) as unknown as Routine | undefined
  if (!cur) return
  db()
    .prepare('UPDATE routines SET enabled=?, schedule=?, title=?, prompt=?, description=?, timezone=?, provenance=? WHERE id=?')
    .run(
      patch.enabled ?? cur.enabled, patch.schedule ?? cur.schedule, patch.title ?? cur.title,
      patch.prompt ?? cur.prompt, patch.description ?? cur.description ?? '', patch.timezone ?? cur.timezone ?? '',
      patch.provenance ?? cur.provenance ?? 'user', id
    )
}

export function touchRoutineRun(id: number): void {
  db().prepare('UPDATE routines SET last_run = ? WHERE id = ?').run(Date.now(), id)
}

export function deleteRoutine(id: number): void {
  db().prepare('DELETE FROM routines WHERE id=?').run(id)
}
