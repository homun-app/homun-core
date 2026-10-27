// Store dei GRUPPI (fase 10, T7): stanza con fino a 6 bot + l'utente. Il gruppo
// NON è una riga di agents (scelta motivata nel REPORT): vive in tabelle proprie
// — gruppi, membri, messaggi (con catena causale root/depth e reply_to),
// cursori di lettura per membro e registro dei turni (nonce univoco, outcome).
// La programmazione dei turni è in agent/group-turns.ts (puro): qui c'è la
// colla che registra, accoda job e scrive le righe di sistema.
import type { DatabaseSync } from 'node:sqlite'
import { db, getAgent, listAgents } from './db'
import { enqueueJob } from './jobs'
import { planGroupTurns, GROUP_HOURLY_CAP_TEXT, type GroupPlanResult } from '../agent/group-turns'

export const GROUPS_DDL = `
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_by TEXT NOT NULL,
      coordinator_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      author_kind TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to INTEGER,
      root_id INTEGER,
      depth INTEGER NOT NULL DEFAULT 0,
      automatic INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id, id);
    CREATE TABLE IF NOT EXISTS group_cursors (
      group_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      last_seen INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (group_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS group_turns (
      nonce TEXT PRIMARY KEY,
      group_id INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      source_message_id INTEGER NOT NULL,
      outcome TEXT,
      started_at INTEGER,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_group_turns_member ON group_turns(group_id, member_id);
  `

// ---- righe e tipi ----

export interface Group {
  id: number
  name: string
  description: string
  created_by: string
  coordinator_id: string | null
  created_at: number
}

interface GroupRow {
  id: number; name: string; description: string; created_by: string
  coordinator_id: string | null; created_at: number
}

export interface GroupMessage {
  id: number
  group_id: number
  author_kind: 'user' | 'agent' | 'system'
  author_id: string | null
  author_name: string
  text: string
  reply_to: number | null
  root_id: number | null
  depth: number
  automatic: number
  created_at: number
}

interface GroupMessageRow {
  id: number; group_id: number; author_kind: string; author_id: string | null; author_name: string
  text: string; reply_to: number | null; root_id: number | null; depth: number
  automatic: number | null; created_at: number
}

export type GroupTurnOutcome = 'SENT' | 'PASS' | 'TIMEOUT' | 'CANCELLED' | 'ERROR' | 'SKIPPED'

export interface GroupTurn {
  nonce: string
  group_id: number
  member_id: string
  source_message_id: number
  outcome: GroupTurnOutcome | null
  started_at: number | null
  ended_at: number | null
}

function rowToGroup(r: GroupRow): Group {
  return {
    id: r.id, name: r.name, description: r.description, created_by: r.created_by,
    coordinator_id: r.coordinator_id, created_at: r.created_at
  }
}

function rowToMessage(r: GroupMessageRow): GroupMessage {
  return {
    id: r.id, group_id: r.group_id, author_kind: r.author_kind as GroupMessage['author_kind'],
    author_id: r.author_id, author_name: r.author_name, text: r.text, reply_to: r.reply_to,
    root_id: r.root_id, depth: r.depth, automatic: r.automatic ?? 0, created_at: r.created_at
  }
}

// ---- CRUD gruppi e membri ----

/** Crea il gruppo con i membri (il creatore è aggiunto se manca; errore oltre i 6 bot). */
export function createGroup(
  name: string,
  description: string,
  createdBy: string,
  memberIds: string[],
  coordinatorId: string | null = null
): Group {
  const members = [...new Set([...memberIds, createdBy])]
  const now = Date.now()
  const r = db()
    .prepare('INSERT INTO groups(name, description, created_by, coordinator_id, created_at) VALUES(?,?,?,?,?)')
    .run(name, description, createdBy, coordinatorId, now)
  const id = Number(r.lastInsertRowid)
  const ins = db().prepare('INSERT INTO group_members(group_id, agent_id, joined_at) VALUES(?,?,?)')
  for (const m of members) ins.run(id, m, now)
  return { id, name, description, created_by: createdBy, coordinator_id: coordinatorId, created_at: now }
}

export function getGroup(id: number): Group | null {
  const r = db().prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined
  return r ? rowToGroup(r) : null
}

export function updateGroup(
  id: number,
  patch: Partial<Pick<Group, 'name' | 'description' | 'coordinator_id'>>
): void {
  const cur = getGroup(id)
  if (!cur) return
  db()
    .prepare('UPDATE groups SET name=?, description=?, coordinator_id=? WHERE id=?')
    .run(patch.name ?? cur.name, patch.description ?? cur.description, patch.coordinator_id ?? cur.coordinator_id, id)
}

/** Tutti i gruppi (la sidebar li mostra in una sezione propria). */
export function listGroups(): Group[] {
  return (db().prepare('SELECT * FROM groups ORDER BY id').all() as unknown as GroupRow[]).map(rowToGroup)
}

/** I gruppi di cui un bot è membro (list_agents li mostra al modello). */
export function groupsOfMember(agentId: string): Group[] {
  return (db().prepare(`
    SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id
    WHERE m.agent_id = ? ORDER BY g.id
  `).all(agentId) as unknown as GroupRow[]).map(rowToGroup)
}

export function groupMemberIds(groupId: number): string[] {
  return (db().prepare('SELECT agent_id FROM group_members WHERE group_id = ? ORDER BY joined_at, agent_id').all(groupId) as Array<{ agent_id: string }>).map((r) => r.agent_id)
}

export function isGroupMember(groupId: number, agentId: string): boolean {
  return !!db().prepare('SELECT 1 FROM group_members WHERE group_id = ? AND agent_id = ?').get(groupId, agentId)
}

export function addGroupMember(groupId: number, agentId: string): void {
  db().prepare('INSERT OR IGNORE INTO group_members(group_id, agent_id, joined_at) VALUES(?,?,?)').run(groupId, agentId, Date.now())
}

export function removeGroupMember(groupId: number, agentId: string): void {
  db().prepare('DELETE FROM group_members WHERE group_id = ? AND agent_id = ?').run(groupId, agentId)
  db().prepare('DELETE FROM group_cursors WHERE group_id = ? AND agent_id = ?').run(groupId, agentId)
}

/** Fase 10 (residuo della cascata): l'agente eliminato esce da tutti i gruppi. */
export function removeAgentMemberships(agentId: string): void {
  db().prepare('DELETE FROM group_members WHERE agent_id = ?').run(agentId)
  db().prepare('DELETE FROM group_cursors WHERE agent_id = ?').run(agentId)
}

// ---- messaggi ----

export interface NewGroupMessage {
  groupId: number
  authorKind: 'user' | 'agent' | 'system'
  authorId: string | null
  authorName: string
  text: string
  replyTo?: number | null
  rootId?: number | null
  depth?: number
  automatic?: boolean
}

export function addGroupMessage(m: NewGroupMessage): GroupMessage {
  const r = db()
    .prepare(`INSERT INTO group_messages(group_id, author_kind, author_id, author_name, text, reply_to, root_id, depth, automatic, created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(m.groupId, m.authorKind, m.authorId, m.authorName, m.text, m.replyTo ?? null, m.rootId ?? null, m.depth ?? 0, m.automatic ? 1 : 0, Date.now())
  const id = Number(r.lastInsertRowid)
  // catena: un messaggio a depth 0 SENZA root apre una catena ed è root di sé
  if ((m.depth ?? 0) === 0 && (m.rootId ?? null) === null) {
    db().prepare('UPDATE group_messages SET root_id = ? WHERE id = ?').run(id, id)
  }
  return getGroupMessage(id)!
}

export function getGroupMessage(id: number): GroupMessage | null {
  const r = db().prepare('SELECT * FROM group_messages WHERE id = ?').get(id) as GroupMessageRow | undefined
  return r ? rowToMessage(r) : null
}

export function groupMessages(groupId: number, afterId = 0): GroupMessage[] {
  return (db().prepare('SELECT * FROM group_messages WHERE group_id = ? AND id > ? ORDER BY id').all(groupId, afterId) as unknown as GroupMessageRow[]).map(rowToMessage)
}

export function lastGroupMessageId(groupId: number): number {
  const r = db().prepare('SELECT MAX(id) AS max FROM group_messages WHERE group_id = ?').get(groupId) as { max: number | null }
  return r.max ?? 0
}

/** I post di bot del gruppo nell'ultima ora (il tetto orario del planner). */
export function botPostsLastHour(groupId: number, now: number): number {
  const r = db().prepare("SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ? AND author_kind = 'agent' AND created_at > ?").get(groupId, now - 3_600_000) as { n: number }
  return r.n
}

// ---- cursori di lettura ----

export function getGroupCursor(groupId: number, agentId: string): number {
  const r = db().prepare('SELECT last_seen FROM group_cursors WHERE group_id = ? AND agent_id = ?').get(groupId, agentId) as { last_seen: number } | undefined
  return r?.last_seen ?? 0
}

export function setGroupCursor(groupId: number, agentId: string, lastSeen: number): void {
  db().prepare(`INSERT INTO group_cursors(group_id, agent_id, last_seen) VALUES(?,?,?)
                ON CONFLICT(group_id, agent_id) DO UPDATE SET last_seen = excluded.last_seen`)
    .run(groupId, agentId, lastSeen)
}

// ---- registro dei turni ----

/** Registra il turno PIANIFICATO (nonce univoco): false se già presente (dedup). */
export function registerPlannedTurn(input: { nonce: string; groupId: number; memberId: string; sourceMessageId: number }): boolean {
  const r = db()
    .prepare('INSERT OR IGNORE INTO group_turns(nonce, group_id, member_id, source_message_id) VALUES(?,?,?,?)')
    .run(input.nonce, input.groupId, input.memberId, input.sourceMessageId)
  return Number(r.changes) > 0
}

export function groupTurnByNonce(nonce: string): GroupTurn | null {
  const r = db().prepare('SELECT * FROM group_turns WHERE nonce = ?').get(nonce) as
    | { nonce: string; group_id: number; member_id: string; source_message_id: number; outcome: string | null; started_at: number | null; ended_at: number | null }
    | undefined
  return r ? { ...r, outcome: (r.outcome as GroupTurnOutcome | null) ?? null } : null
}

export function startGroupTurn(nonce: string, at: number): void {
  db().prepare('UPDATE group_turns SET started_at = COALESCE(started_at, ?) WHERE nonce = ?').run(at, nonce)
}

/**
 * Chiude il turno con l'esito. UPSERT: la riga di pianificazione di solito
 * esiste già, ma un esito senza di essa (job orfano, gruppo cancellato dopo
 * l'accodamento) va comunque registrato.
 */
export function finishGroupTurn(nonce: string, outcome: GroupTurnOutcome, at: number): void {
  db().prepare(`
    INSERT INTO group_turns(nonce, group_id, member_id, source_message_id, outcome, ended_at)
    VALUES(?, 0, '', 0, ?, ?)
    ON CONFLICT(nonce) DO UPDATE SET outcome = excluded.outcome, ended_at = excluded.ended_at
  `).run(nonce, outcome, at)
}

/** I turni PIANIFICATI (non ancora partiti) di un gruppo: la fusione del planner. */
export function pendingTurnNonces(groupId: number): string[] {
  return (db().prepare('SELECT nonce FROM group_turns WHERE group_id = ? AND started_at IS NULL AND outcome IS NULL').all(groupId) as Array<{ nonce: string }>).map((r) => r.nonce)
}

/** Tutti i nonce del gruppo (la dedup del planner). */
export function groupTurnNonces(groupId: number): string[] {
  return (db().prepare('SELECT nonce FROM group_turns WHERE group_id = ?').all(groupId) as Array<{ nonce: string }>).map((r) => r.nonce)
}

// ---- la colla: pianificare i turni per un messaggio nuovo ----

export interface ScheduledTurns {
  plan: GroupPlanResult
  /** i job group-turn accodati (agentId = membro) */
  jobs: Array<{ agentId: string; nonce: string }>
}

/**
 * Pianifica e accoda i turni generati da un messaggio nuovo del gruppo
 * (dell'utente o di un bot): registra i nonce, accoda i job group-turn e
 * scrive nel gruppo le righe di sistema (chiusura della catena, tetto orario
 * — quest'ultima una volta sola all'ora). Pura lettura degli agenti per i
 * nomi; il tempo passa da `now` (iniettabile nei test).
 */
export function scheduleTurnsForMessage(message: GroupMessage, emit: (e: { type: 'groups' }) => void, now = Date.now()): ScheduledTurns {
  const group = getGroup(message.group_id)
  const result: ScheduledTurns = { plan: { turns: [], skipped: [], systemNotice: null, capNotice: false }, jobs: [] }
  if (!group || message.author_kind === 'system') return result
  const memberIds = groupMemberIds(group.id)
  const members = memberIds
    .map((id) => getAgent(id))
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => ({ id: a.id, name: a.name }))
  const plan = planGroupTurns({
    group: { id: group.id, coordinatorId: group.coordinator_id },
    message: {
      id: message.id,
      authorKind: message.author_kind === 'user' ? 'user' : 'agent',
      authorId: message.author_id,
      text: message.text,
      depth: message.depth
    },
    members,
    pendingNonces: pendingTurnNonces(group.id),
    existingNonces: groupTurnNonces(group.id),
    postsLastHour: botPostsLastHour(group.id, now)
  })
  result.plan = plan
  // le righe di sistema NON generano turni (autore sistema)
  if (plan.capNotice) {
    // il tetto si segnala UNA volta: se c'è già la stessa riga di sistema
    // nell'ultima ora, non si ripete
    const recent = groupMessages(group.id).filter((m) => m.author_kind === 'system' && m.text === GROUP_HOURLY_CAP_TEXT && m.created_at > now - 3_600_000)
    if (!recent.length) {
      addGroupMessage({ groupId: group.id, authorKind: 'system', authorId: null, authorName: 'sistema', text: GROUP_HOURLY_CAP_TEXT })
      emit({ type: 'groups' })
    }
  } else if (plan.systemNotice) {
    addGroupMessage({ groupId: group.id, authorKind: 'system', authorId: null, authorName: 'sistema', text: plan.systemNotice })
    emit({ type: 'groups' })
  }
  for (const t of plan.turns) {
    if (!registerPlannedTurn({ nonce: t.nonce, groupId: group.id, memberId: t.memberId, sourceMessageId: message.id })) continue
    enqueueJob(db(), {
      agentId: t.memberId,
      kind: 'group-turn',
      payload: {
        groupId: group.id,
        memberId: t.memberId,
        nonce: t.nonce,
        sourceMessageId: message.id,
        ...(message.automatic ? { automatic: true } : {})
      },
      runAt: now,
      now
    })
    result.jobs.push({ agentId: t.memberId, nonce: t.nonce })
  }
  return result
}

/**
 * La vista di un gruppo per la UI e per list_agents: membri coi nomi e flag
 * coordinatore (l'utente è sempre membro e non compare tra i bot).
 */
export function groupWithMembers(group: Group): {
  id: number; name: string; description: string; createdBy: string
  coordinatorId: string | null; members: Array<{ agentId: string; name: string; coordinator: boolean }>; createdAt: number
} {
  const names = new Map(listAgents().map((a) => [a.id, a.name]))
  return {
    id: group.id, name: group.name, description: group.description,
    createdBy: group.created_by, coordinatorId: group.coordinator_id,
    members: groupMemberIds(group.id).map((id) => ({
      agentId: id, name: names.get(id) ?? id, coordinator: id === group.coordinator_id
    })),
    createdAt: group.created_at
  }
}

/** Annulla i job group-turn di un gruppo (membri rimossi, gruppo modificato). */
export function cancelGroupJobs(dbs: DatabaseSync, groupId: number): number {
  const r = dbs.prepare(`
    DELETE FROM jobs
    WHERE kind = 'group-turn' AND status IN ('queued','leased')
      AND json_extract(payload_json, '$.groupId') = ?
  `).run(groupId)
  return Number(r.changes)
}

/** Annulla i job group-turn di un membro rimosso da un gruppo. */
export function cancelMemberGroupJobs(dbs: DatabaseSync, groupId: number, memberId: string): number {
  const r = dbs.prepare(`
    DELETE FROM jobs
    WHERE kind = 'group-turn' AND status IN ('queued','leased')
      AND json_extract(payload_json, '$.groupId') = ?
      AND json_extract(payload_json, '$.memberId') = ?
  `).run(groupId, memberId)
  return Number(r.changes)
}
