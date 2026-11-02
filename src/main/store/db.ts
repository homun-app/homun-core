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
// fase 16c (C5): lo storico delle esecuzioni delle routine (Attività globale)
import { ROUTINE_RUNS_DDL } from './routine-runs'
import { GROUPS_DDL, migrateGroupCoordinators, ensureGroupCoordinator, groupsOfMember } from './groups'
import { SHELL_JOBS_DDL } from './shell-jobs'
import { COMPUTER_ACTIONS_DDL } from './computer-actions'
import { SUBAGENTS_DDL } from './subagents'
import { LIBRARY_DDL } from './library'
import type { Agent, AgentAvatar, TranscriptEntry, PermissionsConfig, RoutineTrigger, ModelUsageRow } from '../../shared/types'
// fase 17c (C3): l'UiText del rifiuto per la UI (foglie shared, nessun ciclo)
import { ui } from '../../shared/ui-text'
import { UI } from '../../shared/ui-messages'

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
  // fase 16b (S1.1): la connessione si registra SUBITO — le migrazioni in
  // fondo a open() chiamano funzioni di store che usano db() (per esempio
  // migrateGroupCoordinators): senza questo, quella chiamata riaprirebbe
  // open() su una SECONDA connessione, in ricorsione
  _db = db
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
      provenance TEXT DEFAULT 'user',
      trigger_json TEXT,
      paused_for_away INTEGER DEFAULT 0,
      last_poll INTEGER
    );
    CREATE TABLE IF NOT EXISTS outbox (
      entry_id INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'working',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      summary TEXT,
      untrusted INTEGER DEFAULT 0,
      automatic INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS model_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      agent_id TEXT,
      provider_id TEXT NOT NULL,
      provider_kind TEXT NOT NULL,
      model TEXT NOT NULL,
      source TEXT NOT NULL,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL
    );
    CREATE INDEX IF NOT EXISTS idx_model_usage_at ON model_usage(at);
    ${JOBS_DDL}
    ${ROUTINE_RUNS_DDL}
    ${GROUPS_DDL}
    ${SHELL_JOBS_DDL}
    ${SUBAGENTS_DDL}
    ${LIBRARY_DDL}
    ${COMPUTER_ACTIONS_DDL}
  `)
  // fase 4: colonne nuove delle routine per i DB esistenti (CREATE TABLE IF
  // NOT EXISTS non le aggiunge); provenance distingue le routine dell'utente
  // da quelle create dall'agente via update_state.
  // fase 6: trigger_json (trigger esteso), paused_for_away (pausa per
  // assenza), last_poll (ultimo poll dei trigger connector_poll)
  const routineCols = db.prepare("SELECT name FROM pragma_table_info('routines')").all() as Array<{ name: string }>
  const present = new Set(routineCols.map((c) => c.name))
  for (const [col, ddl] of [
    ['description', "ALTER TABLE routines ADD COLUMN description TEXT DEFAULT ''"],
    ['timezone', "ALTER TABLE routines ADD COLUMN timezone TEXT DEFAULT ''"],
    ['provenance', "ALTER TABLE routines ADD COLUMN provenance TEXT DEFAULT 'user'"],
    ['trigger_json', 'ALTER TABLE routines ADD COLUMN trigger_json TEXT'],
    ['paused_for_away', 'ALTER TABLE routines ADD COLUMN paused_for_away INTEGER DEFAULT 0'],
    ['last_poll', 'ALTER TABLE routines ADD COLUMN last_poll INTEGER']
  ] as const) {
    if (!present.has(col)) db.exec(ddl)
  }
  // fase 8 (correzione B1): colonne dell'origine del turno che ha creato il
  // task — untrusted (altro bot o evento esterno) e automatic (routine): si
  // propagano a TUTTI i turni del task e al TASK_DONE
  const taskCols = db.prepare("SELECT name FROM pragma_table_info('tasks')").all() as Array<{ name: string }>
  const taskPresent = new Set(taskCols.map((c) => c.name))
  for (const [col, ddl] of [
    ['untrusted', 'ALTER TABLE tasks ADD COLUMN untrusted INTEGER DEFAULT 0'],
    ['automatic', 'ALTER TABLE tasks ADD COLUMN automatic INTEGER DEFAULT 0']
  ] as const) {
    if (!taskPresent.has(col)) db.exec(ddl)
  }
  // fase 10: colonne degli agents — created_by (chi ha creato il bot) e
  // section (raggruppamento della sidebar, testo libero)
  // fase 12: parent_id — un sottoagente è un BOT FIGLIO nascosto (punto 1)
  // fase 16: avatar — l'aspetto della mascotte scelto dall'utente (JSON, NULL = predefinito)
  const agentCols = db.prepare("SELECT name FROM pragma_table_info('agents')").all() as Array<{ name: string }>
  const agentPresent = new Set(agentCols.map((c) => c.name))
  for (const [col, ddl] of [
    ['created_by', "ALTER TABLE agents ADD COLUMN created_by TEXT"],
    ['section', "ALTER TABLE agents ADD COLUMN section TEXT DEFAULT ''"],
    ['parent_id', 'ALTER TABLE agents ADD COLUMN parent_id TEXT'],
    ['avatar', 'ALTER TABLE agents ADD COLUMN avatar TEXT']
  ] as const) {
    if (!agentPresent.has(col)) db.exec(ddl)
  }
  // fase 12 (correzione J2): la colonna del SIGILLO del lotto — il lotto si
  // sveglia solo quando anche il turno del padre che l'ha creato è finito
  const subCols = db.prepare("SELECT name FROM pragma_table_info('subagents')").all() as Array<{ name: string }>
  if (!subCols.some((c) => c.name === 'sealed')) db.exec('ALTER TABLE subagents ADD COLUMN sealed INTEGER DEFAULT 0')
  // fase 18b (H3): il livello di ragionamento del bot ('default' = la 18a)
  if (!agentPresent.has('thinking')) db.exec("ALTER TABLE agents ADD COLUMN thinking TEXT DEFAULT 'default'")
  // fase 18b (H7): il modello PROPRIo della routine (null = quello del bot)
  const routineModelCols = db.prepare("SELECT name FROM pragma_table_info('routines')").all() as Array<{ name: string }>
  const routineModelPresent = new Set(routineModelCols.map((c) => c.name))
  for (const [col, ddl] of [
    ['provider_id', 'ALTER TABLE routines ADD COLUMN provider_id TEXT'],
    ['model', 'ALTER TABLE routines ADD COLUMN model TEXT'],
    ['thinking', 'ALTER TABLE routines ADD COLUMN thinking TEXT']
  ] as const) {
    if (!routineModelPresent.has(col)) db.exec(ddl)
  }
  // fase 10 (correzione C5): il motivo di uno SKIPPED di gruppo (il giro
  // sospeso per limite d'uso del provider) vive accanto all'esito
  const turnCols = db.prepare("SELECT name FROM pragma_table_info('group_turns')").all() as Array<{ name: string }>
  if (!turnCols.some((c) => c.name === 'reason')) db.exec('ALTER TABLE group_turns ADD COLUMN reason TEXT')
  // fase 16b (S1.2): il flag del riepilogo di chiusura del coordinatore
  const groupMsgCols = db.prepare("SELECT name FROM pragma_table_info('group_messages')").all() as Array<{ name: string }>
  if (!groupMsgCols.some((c) => c.name === 'summary')) db.exec('ALTER TABLE group_messages ADD COLUMN summary INTEGER DEFAULT 0')
  // fase 16b (S1.1, migrazione): ogni gruppo esistente ha un coordinatore
  // (created_by se è ancora membro, altrimenti il primo membro); idempotente
  migrateGroupCoordinators()
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

/** Rimuove un setting (fase 6: migrazione della chiave del vault elimina il vecchio). */
export function deleteSetting(key: string): void {
  db().prepare('DELETE FROM settings WHERE key = ?').run(key)
}

// ---- agents ----
interface AgentRow {
  id: string; name: string; description: string; provider_id: string | null
  model: string | null; status: string; unread: number; created_at: number
  created_by?: string | null; section?: string | null
  /** fase 12: il padre, se questa riga è un sottoagente (bot figlio nascosto) */
  parent_id?: string | null
  /** fase 16: l'aspetto della mascotte (JSON {"family":"…","color":"…"}, NULL = predefinito) */
  avatar?: string | null
  /** fase 18b (H3): livello di ragionamento ('default' = la 18a) */
  thinking?: string | null
}

/** fase 16: parse dell'avatar salvato — un JSON ROTTO diventa null (predefinito), mai un crash. */
function parseAvatar(json: string | null | undefined): Agent['avatar'] {
  if (!json) return null
  try {
    const v = JSON.parse(json) as { family?: unknown; color?: unknown }
    if (typeof v.family === 'string' && typeof v.color === 'string') {
      return { family: v.family as AgentAvatar['family'], color: v.color as AgentAvatar['color'] }
    }
    return null
  } catch {
    return null
  }
}

function rowToAgent(r: AgentRow): Agent {
  return {
    id: r.id, name: r.name, description: r.description, providerId: r.provider_id,
    model: r.model, status: r.status as Agent['status'], unread: r.unread, createdAt: r.created_at,
    createdBy: r.created_by ?? null, section: r.section ?? null,
    parentId: r.parent_id ?? null, avatar: parseAvatar(r.avatar),
    thinking: (r.thinking as Agent['thinking']) ?? 'default'
  }
}

/**
 * Fase 12 (punto 1): il roster ESCLUDE i figli (WHERE parent_id IS NULL) —
 * così restano protetti senza modifiche la sidebar, list_agents, i gruppi,
 * mainAgentOf, la destinazione di send_to_agent, l'onboarding, il tray e gli
 * orfani del browser (che il boot completa con allSubagentIds). getAgent(id)
 * continua a trovarli.
 */
export function listAgents(): Agent[] {
  const rows = db().prepare('SELECT * FROM agents WHERE parent_id IS NULL ORDER BY created_at').all() as unknown as AgentRow[]
  return rows.map(rowToAgent)
}

/**
 * Fase 19b (T4): la FAMIGLIA di un proprietario — lui e i suoi FIGLI (i figli
 * sono righe di agents con parent_id, escluse dal roster). Serve al feed
 * «Attività»: i comandi dei figli compaiono col nome di chi li ha fatti.
 */
export function familyAgents(ownerId: string): Array<{ id: string; name: string }> {
  return db()
    .prepare('SELECT id, name FROM agents WHERE id = ? OR parent_id = ?')
    .all(ownerId, ownerId) as Array<{ id: string; name: string }>
}

export function getAgent(id: string): Agent | null {
  const r = db().prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
  return r ? rowToAgent(r) : null
}

/**
 * Opzioni di creazione (fase 10): creatore e sezione della sidebar.
 * Fase 12: parentId fa della riga un BOT FIGLIO (sottoagente nascosto), con
 * un id imposto dal chiamante (`sub_<8 hex>`).
 */
export interface CreateAgentOpts {
  createdBy?: string
  section?: string
  parentId?: string
  /** solo per i figli: l'id `sub_…` generato dal chiamante */
  id?: string
}

export function createAgent(name: string, description = '', opts: CreateAgentOpts = {}): Agent {
  const id = opts.id ?? 'agent_' + crypto.randomUUID().slice(0, 8)
  const now = Date.now()
  db()
    .prepare('INSERT INTO agents(id, name, description, status, created_at, created_by, section, parent_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, name, description, 'idle', now, opts.createdBy ?? null, opts.section ?? '', opts.parentId ?? null)
  return {
    id, name, description, providerId: null, model: null, status: 'idle', unread: 0, createdAt: now,
    createdBy: opts.createdBy ?? null, section: opts.section ?? '', parentId: opts.parentId ?? null
  }
}

export function updateAgent(
  id: string,
  patch: Partial<Pick<Agent, 'name' | 'description' | 'providerId' | 'model' | 'status' | 'unread' | 'section' | 'avatar' | 'thinking'>>
): void {
  const a = getAgent(id)
  if (!a) return
  db()
    .prepare('UPDATE agents SET name=?, description=?, provider_id=?, model=?, status=?, unread=?, section=?, avatar=?, thinking=? WHERE id=?')
    .run(
      patch.name ?? a.name, patch.description ?? a.description,
      // fase 16c (C3.3): providerId/model NULL sono VALIDI («Come gli altri»):
      // si distinguono da "assente" — ?? non andrebbe bene
      patch.providerId !== undefined ? patch.providerId : a.providerId,
      patch.model !== undefined ? patch.model : a.model,
      patch.status ?? a.status, patch.unread ?? a.unread,
      patch.section ?? a.section ?? '',
      // fase 16: null torna al predefinito (colonna NULL)
      patch.avatar === undefined ? (a.avatar ? JSON.stringify(a.avatar) : null) : patch.avatar === null ? null : JSON.stringify(patch.avatar),
      // fase 18b (H3): 'default' o assente = la 18a (mai NULL: la colonna ha DEFAULT)
      patch.thinking ?? a.thinking ?? 'default',
      id
    )
}

/**
 * Fase 12 (punto 1): il loop registra qui il suo interrupt, così deleteAgent
 * può FERMARE i figli di un padre eliminato senza importare il loop (ciclo).
 * Nei test si registra una funzione finta.
 */
let agentStopper: ((agentId: string) => void) | null = null

export function setAgentStopperForDaemon(fn: ((agentId: string) => void) | null): void {
  agentStopper = fn
}

/**
 * Elimina un agente e tutto ciò che gli appartiene. Fase 16b (S1.1): torna i
 * gruppi che hanno dovuto eleggere un nuovo coordinatore (il chiamante scrive
 * la riga di sistema nel gruppo).
 */
export function deleteAgent(id: string): Array<{ groupId: number; coordinatorId: string }> {
  // fase 5 (residuo 0d): si rimuove solo un agente ESISTENTE (il path della
  // directory si costruisce dal suo id, mai da input libero)
  if (!getAgent(id)) return []
  // fase 16b (S1.1): i gruppi di cui era coordinatore eleggono il primo
  // membro rimasto — la lista torna al chiamante per le righe di sistema
  const coordinated = groupsOfMember(id).map((g) => g.id)
  const elections: Array<{ groupId: number; coordinatorId: string }> = []
  // fase 12 (punto 1): i FIGLI muoiono col padre — turno fermato, coda
  // svuotata, righe agents/entry/subagents eliminate. I file del box NON si
  // toccano mai: la home del figlio è quella del padre (il volume è suo)
  const childRows = db().prepare('SELECT id FROM subagents WHERE parent_id = ?').all(id) as Array<{ id: string }>
  for (const child of childRows) {
    agentStopper?.(child.id)
    db().prepare('DELETE FROM jobs WHERE agent_id = ?').run(child.id)
    db().prepare('DELETE FROM agents WHERE id=?').run(child.id)
    db().prepare('DELETE FROM entries WHERE agent_id=?').run(child.id)
    db().prepare('DELETE FROM subagents WHERE id=?').run(child.id)
  }
  // fase 7 (residuo 0c): pulizia di tutto ciò che resta dell'agente — le
  // routine (con i loro setting trigger.seen.<id>, altrimenti orfani nei
  // settings) e le righe outbox trattenute; le entry muoiono col DELETE sotto
  for (const r of db().prepare('SELECT id FROM routines WHERE agent_id = ?').all(id) as Array<{ id: number }>) {
    db().prepare('DELETE FROM settings WHERE key = ?').run(`trigger.seen.${r.id}`)
  }
  db().prepare('DELETE FROM routines WHERE agent_id = ?').run(id)
  db().prepare('DELETE FROM outbox WHERE agent_id = ?').run(id)
  // fase 10: l'agente esce dai gruppi (i gruppi restano, senza di lui).
  // fase 16b (S1.1): chi perde il coordinatore ne elegge un altro (primo
  // membro rimasto)
  db().prepare('DELETE FROM group_members WHERE agent_id = ?').run(id)
  db().prepare('DELETE FROM group_cursors WHERE agent_id = ?').run(id)
  for (const gid of coordinated) {
    const r = ensureGroupCoordinator(gid)
    if (r.changed && r.coordinatorId) elections.push({ groupId: gid, coordinatorId: r.coordinatorId })
  }
  db().prepare('DELETE FROM agents WHERE id=?').run(id)
  db().prepare('DELETE FROM entries WHERE agent_id=?').run(id)
  // memoria e skill su disco non restano orfane
  try {
    rmSync(join(dataDir(), 'agents', id), { recursive: true, force: true })
  } catch {
    // directory assente o non eliminabile: le righe sono già via
  }
  return elections
}

/**
 * Fase 12 (punto 1): il padre di un id, se quella riga è un FIGLIO (null per
 * i bot normali o per id sconosciuti).
 */
export function subagentParentOf(id: string): Agent | null {
  const a = getAgent(id)
  return a?.parentId ? getAgent(a.parentId) : null
}

/**
 * Fase 12 (punto 1): il messaggio di rifiuto per un id di figlio passato a un
 * tool/RPC che vuole un BOT (update_agent, delete_agent, send_to_agent, gruppi,
 * routine). null se l'id non è un figlio.
 */
export function subagentRefusal(id: string): string | null {
  const parent = subagentParentOf(id)
  // fase 17c (C3): il rifiuto arriva sia al modello (result dei tool, inglese)
  // sia alla UI (routine sui sottoagenti): subagentRefusalUi dà l'UiText
  return parent ? `${id} is not a bot: it is a subagent of ${parent.name}` : null
}

/** Fase 17c (C3): l'UiText del rifiuto per la UI (stesso controllo di subagentRefusal). */
export function subagentRefusalUi(id: string): import('../../shared/types').UiText | null {
  const parent = subagentParentOf(id)
  if (!parent) return null
  return ui(UI.rpcNotABot, { id, parent: parent.name })
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
      // fase 5: il funnel dei connettori (search/offer) non ha effetti fuori
      // dal transcript; offer_connector è intercettato dal loop prima del gate
      { tool: 'search_connectors', pattern: '*', mode: 'always_allow' },
      { tool: 'offer_connector', pattern: '*', mode: 'always_allow' },
      // fase 7: i messaggi tra bot sono interni all'utente (send_to_agent è
      // intercettato dal loop; list_agents è una lettura del roster)
      { tool: 'send_to_agent', pattern: '*', mode: 'always_allow' },
      { tool: 'list_agents', pattern: '*', mode: 'always_allow' },
      // fase 8: la proposta di regola di auto-review crea SOLO una card (la
      // regola si salva al click dell'utente); è intercettata dal loop.
      // I task girano nella stessa coda dell'agente e update_task chiude con
      // un job TASK_DONE interno: nessun effetto fuori dal sistema
      { tool: 'propose_rule_change', pattern: '*', mode: 'always_allow' },
      { tool: 'create_task', pattern: '*', mode: 'always_allow' },
      { tool: 'update_task', pattern: '*', mode: 'always_allow' },
      // fase 12: i sottoagenti sono interni all'utente (il figlio è un agente
      // suo; spawn/check/message/stop e wake_parent sono intercettati dal loop
      // e non hanno effetti fuori dal sistema)
      { tool: 'spawn_subagent', pattern: '*', mode: 'always_allow' },
      { tool: 'check_subagent', pattern: '*', mode: 'always_allow' },
      { tool: 'message_subagent', pattern: '*', mode: 'always_allow' },
      { tool: 'stop_subagent', pattern: '*', mode: 'always_allow' },
      { tool: 'wake_parent', pattern: '*', mode: 'always_allow' },
      // fase 10: creare bot e gruppi nei turni dell'UTENTE parte senza card
      // (il loop forza la card nei turni automatici/di altri bot/di gruppo/
      // untrusted: permessi per origine, punto 1); aggiornare ed eliminare
      // bot chiede SEMPRE (update_agent dei PROPRI bot lo bypassa pre-gate,
      // delete_agent mai); i messaggi di gruppo sono interni all'utente
      { tool: 'create_agent', pattern: '*', mode: 'always_allow' },
      { tool: 'create_group', pattern: '*', mode: 'always_allow' },
      { tool: 'update_agent', pattern: '*', mode: 'needs_approval' },
      { tool: 'delete_agent', pattern: '*', mode: 'needs_approval' },
      { tool: 'update_group', pattern: '*', mode: 'needs_approval' },
      { tool: 'post_to_group', pattern: '*', mode: 'always_allow' },
      { tool: 'pass', pattern: '*', mode: 'always_allow' },
      // fase 11: i tool web sono letture (l'output è sempre dato non fidato:
      // blocco evidenza + contaminazione del turno); await_shell legge lo
      // stato dei COMANDI GIÀ approvati col gate di run-command; lo scambio
      // di file col Mac chiede SEMPRE (policy dedicata nel loop)
      { tool: 'web_search', pattern: '*', mode: 'always_allow' },
      { tool: 'web_fetch', pattern: '*', mode: 'always_allow' },
      { tool: 'await_shell', pattern: '*', mode: 'always_allow' },
      { tool: 'copy_to_box', pattern: '*', mode: 'needs_approval' },
      { tool: 'copy_from_box', pattern: '*', mode: 'needs_approval' },
      { tool: 'mcp__*', pattern: '*', mode: 'needs_approval' },
      // fase 14: la LIBRERIA è interna all'utente (documenti, grafici, file):
      // scrittura e lettura passano sempre; l'EXPORT chiede SEMPRE la card
      // (intercettato dal loop prima del gate, come lo scambio di file);
      // fill_credential ha la SUA card (mai auto-review); i contatti sono
      // visibili (find_contacts) ma salvarli chiede la card dell'utente
      { tool: 'write_document', pattern: '*', mode: 'always_allow' },
      { tool: 'edit_document', pattern: '*', mode: 'always_allow' },
      { tool: 'read_document', pattern: '*', mode: 'always_allow' },
      { tool: 'visualize', pattern: '*', mode: 'always_allow' },
      { tool: 'save_to_library', pattern: '*', mode: 'always_allow' },
      { tool: 'list_library', pattern: '*', mode: 'always_allow' },
      { tool: 'export_from_library', pattern: '*', mode: 'needs_approval' },
      { tool: 'fill_credential', pattern: '*', mode: 'needs_approval' },
      { tool: 'request_secure_input', pattern: '*', mode: 'always_allow' },
      { tool: 'find_contacts', pattern: '*', mode: 'always_allow' },
      { tool: 'save_contact', pattern: '*', mode: 'always_allow' }
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
// fase 6: trigger esteso in trigger_json (schedule every, connector_poll,
// webhook, presence_return); la colonna schedule resta il cron delle routine
// pre-fase 6 e dei trigger cron.

export interface Routine {
  id: number; agent_id: string; title: string; prompt: string
  schedule: string; enabled: number; last_run: number | null; created_at: number
  /** fase 4: descrizione e fuso orario (update_state), chi ha creato la routine */
  description?: string; timezone?: string; provenance?: 'user' | 'agent' | 'template'
  /** fase 6: trigger esteso (null = cron della colonna schedule) */
  trigger?: RoutineTrigger | null
  /** fase 6: 1 = in pausa perché l'utente è via (riattivata solo al rientro) */
  paused_for_away?: number
  /** fase 6: ultimo poll eseguito (trigger connector_poll) */
  last_poll?: number | null
  /** fase 18b (H7): modello PROPRIo (null = quello del bot) */
  providerId?: string | null
  model?: string | null
  thinking?: import('../../shared/types').ThinkingSetting | null
}

interface RoutineRow {
  id: number; agent_id: string; title: string; prompt: string; schedule: string
  enabled: number; last_run: number | null; created_at: number
  description?: string | null; timezone?: string | null; provenance?: string | null
  trigger_json?: string | null; paused_for_away?: number | null; last_poll?: number | null
  provider_id?: string | null; model?: string | null; thinking?: string | null
}

function rowToRoutine(r: RoutineRow): Routine {
  return {
    id: r.id, agent_id: r.agent_id, title: r.title, prompt: r.prompt, schedule: r.schedule,
    enabled: r.enabled, last_run: r.last_run, created_at: r.created_at,
    description: r.description ?? '', timezone: r.timezone ?? '',
    provenance: (r.provenance as Routine['provenance']) ?? 'user',
    trigger: r.trigger_json ? (JSON.parse(r.trigger_json) as RoutineTrigger) : null,
    paused_for_away: r.paused_for_away ?? 0,
    last_poll: r.last_poll ?? null,
    providerId: r.provider_id ?? null,
    model: r.model ?? null,
    thinking: (r.thinking as Routine['thinking']) ?? null
  }
}

export function listRoutines(agentId?: string): Routine[] {
  const q = agentId ? 'SELECT * FROM routines WHERE agent_id = ? ORDER BY id' : 'SELECT * FROM routines ORDER BY id'
  const rows = (agentId ? db().prepare(q).all(agentId) : db().prepare(q).all()) as unknown as RoutineRow[]
  return rows.map(rowToRoutine)
}

export function getRoutine(id: number): Routine | null {
  const r = db().prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow | undefined
  return r ? rowToRoutine(r) : null
}

/** Campi opzionali alla creazione: le routine dell'agente (update_state) nascono in pausa con provenance 'agent' o 'template'. */
export interface CreateRoutineOpts {
  enabled?: number
  provenance?: 'user' | 'agent' | 'template'
  description?: string
  timezone?: string
  trigger?: RoutineTrigger
  /** fase 18b (H7): modello proprio (la RPC valida prima di arrivare qui) */
  providerId?: string | null
  model?: string | null
  thinking?: import('../../shared/types').ThinkingSetting | null
}

export function createRoutine(agentId: string, title: string, prompt: string, schedule: string, opts: CreateRoutineOpts = {}): Routine {
  const now = Date.now()
  const r = db()
    .prepare('INSERT INTO routines(agent_id, title, prompt, schedule, enabled, created_at, description, timezone, provenance, trigger_json, provider_id, model, thinking) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      agentId, title, prompt, schedule, opts.enabled ?? 1, now, opts.description ?? '', opts.timezone ?? '',
      opts.provenance ?? 'user', opts.trigger ? JSON.stringify(opts.trigger) : null,
      opts.providerId ?? null, opts.model ?? null, opts.thinking ?? null
    )
  return {
    id: Number(r.lastInsertRowid), agent_id: agentId, title, prompt, schedule,
    enabled: opts.enabled ?? 1, last_run: null, created_at: now,
    description: opts.description ?? '', timezone: opts.timezone ?? '', provenance: opts.provenance ?? 'user',
    trigger: opts.trigger ?? null, paused_for_away: 0, last_poll: null,
    providerId: opts.providerId ?? null, model: opts.model ?? null, thinking: opts.thinking ?? null
  }
}

export function updateRoutine(
  id: number,
  patch: Partial<Pick<Routine, 'enabled' | 'schedule' | 'title' | 'prompt' | 'description' | 'timezone' | 'provenance' | 'trigger' | 'paused_for_away' | 'providerId' | 'model' | 'thinking'>>
): void {
  const row = db().prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow | undefined
  if (!row) return
  const cur = rowToRoutine(row)
  db()
    .prepare('UPDATE routines SET enabled=?, schedule=?, title=?, prompt=?, description=?, timezone=?, provenance=?, trigger_json=?, paused_for_away=?, provider_id=?, model=?, thinking=? WHERE id=?')
    .run(
      patch.enabled ?? cur.enabled, patch.schedule ?? cur.schedule, patch.title ?? cur.title,
      patch.prompt ?? cur.prompt, patch.description ?? cur.description ?? '', patch.timezone ?? cur.timezone ?? '',
      patch.provenance ?? cur.provenance ?? 'user',
      patch.trigger !== undefined ? (patch.trigger ? JSON.stringify(patch.trigger) : null) : (cur.trigger ? JSON.stringify(cur.trigger) : null),
      patch.paused_for_away ?? cur.paused_for_away ?? 0,
      patch.providerId !== undefined ? patch.providerId : cur.providerId ?? null,
      patch.model !== undefined ? patch.model : cur.model ?? null,
      patch.thinking !== undefined ? patch.thinking : cur.thinking ?? null,
      id
    )
}

export function touchRoutineRun(id: number): void {
  db().prepare('UPDATE routines SET last_run = ? WHERE id = ?').run(Date.now(), id)
}

/** Registra l'ultimo poll di un trigger connector_poll (il claim del poll). */
export function touchRoutinePoll(id: number, at: number): void {
  db().prepare('UPDATE routines SET last_poll = ? WHERE id = ?').run(at, id)
}

export function deleteRoutine(id: number): void {
  db().prepare('DELETE FROM routines WHERE id=?').run(id)
}

// ---- outbox (fase 6, finestre di consegna) ----

export interface OutboxRow {
  entry_id: number
  agent_id: string
  created_at: number
}

/** Trattiene l'entry di un messaggio send_to_user (consegnato alla prossima finestra). */
export function holdOutboxEntry(entryId: number, agentId: string, createdAt: number): void {
  db().prepare('INSERT OR REPLACE INTO outbox(entry_id, agent_id, created_at) VALUES(?,?,?)').run(entryId, agentId, createdAt)
}

/** Le entry trattenute di un agente, in ordine. */
export function heldOutboxForAgent(agentId: string): OutboxRow[] {
  return db().prepare('SELECT * FROM outbox WHERE agent_id = ? ORDER BY entry_id').all(agentId) as unknown as OutboxRow[]
}

/** Tutte le entry trattenute, raggruppate per agente (consegna a finestra). */
export function allHeldOutbox(): OutboxRow[] {
  return db().prepare('SELECT * FROM outbox ORDER BY agent_id, entry_id').all() as unknown as OutboxRow[]
}

/** Segna consegnata (rimuove dalla outbox). */
export function releaseOutboxEntry(entryId: number): void {
  db().prepare('DELETE FROM outbox WHERE entry_id = ?').run(entryId)
}

// ---- task thread (fase 8, §3bis L7) ----

export type TaskStatus = 'working' | 'needs_input' | 'done' | 'failed' | 'cancelled'

export interface Task {
  id: number
  agent_id: string
  title: string
  status: TaskStatus
  created_at: number
  updated_at: number
  summary: string | null
  /** fase 8 (B1): nato da un turno non fidato (altro bot o evento esterno) */
  untrusted?: number
  /** fase 8 (B1): nato da un turno automatico (routine/trigger): outbox e tetto urgent anche nei suoi turni */
  automatic?: number
}

interface TaskRow {
  id: number; agent_id: string; title: string; status: string
  created_at: number; updated_at: number; summary: string | null
  untrusted?: number | null
  automatic?: number | null
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id, agent_id: r.agent_id, title: r.title,
    status: r.status as TaskStatus,
    created_at: r.created_at, updated_at: r.updated_at, summary: r.summary,
    untrusted: r.untrusted ?? 0,
    automatic: r.automatic ?? 0
  }
}

/** Origine del turno che crea il task (fase 8, correzione B1): si propaga a tutti i turni del task. */
export interface CreateTaskOpts {
  untrusted?: boolean
  automatic?: boolean
}

export function createTask(agentId: string, title: string, opts: CreateTaskOpts = {}): Task {
  const now = Date.now()
  const r = db()
    .prepare("INSERT INTO tasks(agent_id, title, status, created_at, updated_at, untrusted, automatic) VALUES(?,?, 'working', ?, ?, ?, ?)")
    .run(agentId, title, now, now, opts.untrusted ? 1 : 0, opts.automatic ? 1 : 0)
  return {
    id: Number(r.lastInsertRowid), agent_id: agentId, title, status: 'working', created_at: now, updated_at: now, summary: null,
    untrusted: opts.untrusted ? 1 : 0, automatic: opts.automatic ? 1 : 0
  }
}

export function getTask(id: number): Task | null {
  const r = db().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  return r ? rowToTask(r) : null
}

export function listTasks(agentId?: string): Task[] {
  const q = agentId ? 'SELECT * FROM tasks WHERE agent_id = ? ORDER BY id DESC' : 'SELECT * FROM tasks ORDER BY id DESC'
  const rows = (agentId ? db().prepare(q).all(agentId) : db().prepare(q).all()) as unknown as TaskRow[]
  return rows.map(rowToTask)
}

/**
 * Fase 8 (correzione B2): task APERTI (working o needs_input) di un agente —
 * crea_task rifiuta oltre il tetto (5): senza limite un modello crea catene
 * di task annidati che girano all'infinito.
 */
export const MAX_OPEN_TASKS = 5

export function openTasksOf(agentId: string): number {
  const r = db()
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status IN ('working', 'needs_input')")
    .get(agentId) as { n: number }
  return r.n
}

/** Aggiorna stato/summary (touch di updated_at); stato finale solo transizioni valide. */
export function updateTask(id: number, patch: Partial<Pick<Task, 'status' | 'summary'>>): Task | null {
  const cur = getTask(id)
  if (!cur) return null
  // i task chiusi non riaprono: done/failed/cancelled sono finali
  const nextStatus = patch.status ?? cur.status
  const closed = cur.status === 'done' || cur.status === 'failed' || cur.status === 'cancelled'
  const status = closed ? cur.status : nextStatus
  db()
    .prepare('UPDATE tasks SET status = ?, summary = ?, updated_at = ? WHERE id = ?')
    .run(status, patch.summary ?? cur.summary, Date.now(), id)
  return getTask(id)
}

// ---- fase 18a (E4): uso registrato dei modelli (i dati della pagina Uso e
// costi della 18b) — SOLO numeri: mai testo dei messaggi, mai chiavi ----

export interface ModelUsageRecord {
  at?: number
  agentId: string | null
  providerId: string
  providerKind: string
  model: string
  source: string
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  costUsd: number | null
}

/**
 * Una riga di uso per una chiamata completata (l'usage del chunk finale).
 * La chiama ogni chiamante di llmStream con la sua `source`; senza usage la
 * chiamata non si registra (fuori contratto: si è perso il chunk finale).
 */
export function recordModelUsage(rec: ModelUsageRecord): void {
  db()
    .prepare(
      `INSERT INTO model_usage(at, agent_id, provider_id, provider_kind, model, source, input, output, cache_read, cache_write, cost_usd)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      rec.at ?? Date.now(), rec.agentId, rec.providerId, rec.providerKind, rec.model, rec.source,
      rec.input, rec.output, rec.cacheRead ?? 0, rec.cacheWrite ?? 0, rec.costUsd
    )
}

/** La chiave di raggruppamento di usage:summary (fase 18b, H6.1). */
export type UsageGroupBy = 'model' | 'agent' | 'source'

/**
 * L'aggregato in una finestra [fromMs, toMs] (facoltativi), per
 * provider_kind + model (default), bot o origine. costUsd è null solo se
 * TUTTE le righe del gruppo sono null; costPartial segnala i gruppi con
 * costo MISTO (alcune righe note, altre no — costo sottostimato, H0).
 */
export function modelUsageSummary(fromMs?: number, toMs?: number, groupBy: UsageGroupBy = 'model'): ModelUsageRow[] {
  const where = [
    ...(fromMs !== undefined ? ['mu.at >= ?'] : []),
    ...(toMs !== undefined ? ['mu.at <= ?'] : [])
  ]
  const params = [
    ...(fromMs !== undefined ? [fromMs] : []),
    ...(toMs !== undefined ? [toMs] : [])
  ]
  // fase 18b (H6.1): il gruppo per modello diventa provider_id + kind + model
  // (il prezzo personalizzato vive per providerId); per bot c'è il nome
  // (LEFT JOIN: le chiamate senza bot → null, etichetta «Sistema» nella UI)
  const dims =
    groupBy === 'agent' ? 'mu.agent_id' :
    groupBy === 'source' ? 'mu.source' :
    'mu.provider_id, mu.provider_kind, mu.model'
  const rows = db()
    .prepare(
      `SELECT mu.provider_id AS providerId, mu.provider_kind AS providerKind, mu.model AS model, mu.source AS source,
              mu.agent_id AS agentId, a.name AS agentName,
              COUNT(*) AS calls,
              SUM(mu.input) AS input, SUM(mu.output) AS output,
              SUM(mu.cache_read) AS cacheRead, SUM(mu.cache_write) AS cacheWrite,
              SUM(mu.cost_usd) AS knownCost, COUNT(mu.cost_usd) AS costRows
       FROM model_usage mu LEFT JOIN agents a ON a.id = mu.agent_id
       ${where.length ? ' WHERE ' + where.join(' AND ') : ''}
       GROUP BY ${dims}
       ORDER BY calls DESC`
    )
    .all(...params) as Array<{
      providerId: string | null; providerKind: string; model: string; source: string
      agentId: string | null; agentName: string | null
      calls: number; input: number; output: number; cacheRead: number; cacheWrite: number
      knownCost: number | null; costRows: number
    }>
  return rows.map((r) => ({
    calls: r.calls,
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead,
    cacheWrite: r.cacheWrite,
    // costo noto solo se ALMENO una riga lo aveva; le righe null non pesano
    costUsd: r.costRows > 0 ? (r.knownCost ?? 0) : null,
    // H0: righe MISTE (alcune con costo, altre no) → il totale è parziale
    costPartial: r.costRows > 0 && r.costRows < r.calls,
    providerId: groupBy === 'model' ? (r.providerId ?? '') : '',
    providerKind: groupBy === 'model' ? r.providerKind : '',
    model: groupBy === 'model' ? r.model : '',
    source: groupBy === 'source' ? r.source : '',
    agentId: groupBy === 'agent' ? r.agentId : null,
    agentName: groupBy === 'agent' ? r.agentName : null
  }))
}
