// A1 (fase centro-autorizzazioni): il centro «Da approvare» — tutte le
// richieste che spettano all'utente, in un posto. La tabella approvals è
// l'INDICE delle richieste pendenti (status = 'pending', con indice): la
// lettura NON scorre i transcript dei bot, costa come il numero delle
// richieste. La riga si unisce alla ENTRY della card (chiave primaria) per
// frase, categoria (squadApprovalCategory), perché (squadApprovalWhy), ora e
// marcatori di squadra. Il centro è una VISTA: decidere passa dai percorsi
// di oggi (approvals:resolve), qui si legge soltanto.
import { db } from './db'
import { squadApprovalCategory, squadApprovalWhy } from '../agent/squad-approvals'
import type { TranscriptEntry, ApprovalsCenterRow, ApprovalLogRow } from '../../shared/types'

/** A1: la riga dell'indice nasce CON la card pendente (idempotente). */
export function recordPendingApproval(e: {
  id: string
  agentId: string
  tool: string
  input: Record<string, unknown>
  entryId: number
  createdAt?: number
}): void {
  db()
    .prepare('INSERT OR REPLACE INTO approvals(id, agent_id, tool, input, status, created_at, entry_id) VALUES(?,?,?,?,?,?,?)')
    .run(e.id, e.agentId, e.tool, JSON.stringify(e.input ?? {}), 'pending', e.createdAt ?? Date.now(), e.entryId)
}

/** A1: lo stato dell'indice segue lo stato della card (decisa, scaduta…). */
export function setApprovalRowStatus(id: string, status: string): void {
  db().prepare('UPDATE approvals SET status = ? WHERE id = ?').run(status, id)
}

/**
 * A2 (fase approvazioni-chiare): la DECISIONE finisce nel registro — chi ha
 * deciso lo dice il via (chat / center / notification), come (decision +
 * mode) e quando (decided_at). La scadenza è una decisione anche lei
 * (decision 'expired', via 'expired'): le richieste rifiutate RESTANO.
 */
export function setApprovalRowDecision(
  id: string,
  status: string,
  decision: 'allow' | 'deny' | 'expired',
  mode: string | null,
  via: string | null
): void {
  db()
    .prepare('UPDATE approvals SET status = ?, decision = ?, mode = ?, decided_via = ?, decided_at = ? WHERE id = ?')
    .run(status, decision, mode, via, Date.now(), id)
}

/**
 * A2: la chiamata passata da sola (grant o regola) si segna nell'indice
 * dell'uso tool_use con allowed_by — la riga del tool-call c'è già (la
 * scrive appendEntry): qui si completa. Pura SQL, riceve la connessione.
 */
export function recordAutoAllow(
  db: import('node:sqlite').DatabaseSync,
  e: { entryId: number; tool: string; agentId: string; at: number; allowedBy: string }
): void {
  db.prepare('INSERT OR IGNORE INTO tool_use (entry_id, tool, agent_id, at, allowed_by) VALUES (?, ?, ?, ?, ?)')
    .run(BigInt(e.entryId), e.tool, e.agentId, BigInt(e.at), e.allowedBy)
  db.prepare('UPDATE tool_use SET allowed_by = ? WHERE entry_id = ?').run(e.allowedBy, BigInt(e.entryId))
}

/**
 * A2: il registro — le decisioni (dalla tabella approvals, anche le righe
 * vecchie coi campi vuoti) e le chiamate passate da sole (dall'indice
 * tool_use con allowed_by), dal più recente. Query indicizzate (decided_at;
 * allowed_by, at) con tetto in righe: il costo è del limite, non della
 * storia. La frase si rilegge dall'entry della card (una lettura per riga).
 */
export function approvalLog(limit = 200): ApprovalLogRow[] {
  const r = db()
  const decided = r.prepare(
    `SELECT id, agent_id, tool, entry_id, status, decision, mode, decided_via,
            COALESCE(decided_at, created_at) AS at
     FROM approvals
     WHERE status IN ('allowed', 'denied', 'expired') OR decision IS NOT NULL
     ORDER BY decided_at DESC LIMIT ?`
  ).all(limit) as Array<{
    id: string; agent_id: string; tool: string; entry_id: number | null; status: string
    decision: string | null; mode: string | null; decided_via: string | null; at: number
  }>
  const autos = r.prepare(
    'SELECT entry_id, tool, agent_id, at, allowed_by FROM tool_use WHERE allowed_by IS NOT NULL ORDER BY at DESC LIMIT ?'
  ).all(limit) as Array<{ entry_id: number; tool: string; agent_id: string; at: number; allowed_by: string }>
  // i nomi dei bot (il PADRE per i sottoagenti, come nel centro)
  const agents = new Map<string, { name: string; parentId: string | null }>()
  for (const a of r.prepare('SELECT id, name, parent_id FROM agents').all() as Array<{ id: string; name: string; parent_id: string | null }>) {
    agents.set(a.id, { name: a.name, parentId: a.parent_id })
  }
  const botNameOf = (agentId: string): string => {
    const a = agents.get(agentId)
    if (!a) return agentId
    return a.parentId ? agents.get(a.parentId)?.name ?? a.name : a.name
  }
  const phraseOf = (entryId: number | null): string => {
    if (entryId == null) return ''
    const e = r.prepare('SELECT content FROM entries WHERE id = ?').get(entryId) as { content: string } | undefined
    return e?.content ?? ''
  }
  const out: ApprovalLogRow[] = []
  for (const row of decided) {
    out.push({
      kind: 'decision',
      key: row.id,
      approvalId: row.id,
      agentId: row.agent_id,
      botName: botNameOf(row.agent_id),
      phrase: phraseOf(row.entry_id),
      tool: row.tool,
      decision: row.decision === 'allow' || row.decision === 'deny' || row.decision === 'expired' ? row.decision : null,
      mode: (row.mode as ApprovalLogRow['mode']) ?? null,
      via: row.decided_via,
      allowedBy: null,
      at: Number(row.at),
      legacy: row.decision == null
    })
  }
  for (const row of autos) {
    out.push({
      kind: 'auto',
      key: `auto-${row.entry_id}`,
      approvalId: null,
      agentId: row.agent_id,
      botName: botNameOf(row.agent_id),
      phrase: row.tool,
      tool: row.tool,
      decision: 'auto',
      mode: null,
      via: null,
      allowedBy: row.allowed_by,
      at: Number(row.at),
      legacy: false
    })
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit)
}

/** L'entry della card per id di riga (chiave primaria: una lettura). */
function entryById(id: number): TranscriptEntry | null {
  const r = db().prepare('SELECT * FROM entries WHERE id = ?').get(id) as
    | { id: number; agent_id: string; kind: string; role: string; content: string; meta: string | null; created_at: number }
    | undefined
  if (!r) return null
  return {
    id: r.id, agentId: r.agent_id, kind: r.kind as TranscriptEntry['kind'], role: r.role as TranscriptEntry['role'],
    content: r.content, meta: r.meta ? JSON.parse(r.meta) : null, createdAt: r.created_at
  }
}

/** L'anteprima della card, solo con ciò che il meta contiene già. */
export function centerPreviewOf(meta: Record<string, unknown> | null | undefined): ApprovalsCenterRow['preview'] {
  const m = (meta ?? {}) as Record<string, unknown>
  const message = (m.message ?? null) as { to?: unknown; subject?: unknown } | null
  const browser = (m.browser ?? null) as { url?: unknown } | null
  const input = (m.input ?? null) as { origin?: unknown } | null
  const preview: NonNullable<ApprovalsCenterRow['preview']> = {}
  if (message && typeof message.to === 'string' && message.to) preview.to = message.to
  if (message && typeof message.subject === 'string' && message.subject) preview.subject = message.subject
  if (browser && typeof browser.url === 'string' && browser.url) preview.url = browser.url
  if (input && typeof input.origin === 'string' && input.origin) preview.origin = input.origin
  return Object.keys(preview).length ? preview : null
}

/**
 * A1: tutte le richieste pendenti, per il centro. Righe stantie (entry già
 * decisa o sparita, bot eliminato) non compaiono e l'indice si riallinea da
 * sé. L'ordine è quello della tavola 4: prima l'insieme fisso, poi le altre;
 * a parità, la più vecchia prima (il raggruppamento per squadra/bot lo fa
 * chi legge).
 */
export function pendingApprovalsAll(): ApprovalsCenterRow[] {
  const rows = db().prepare('SELECT id, agent_id, created_at, entry_id FROM approvals WHERE status = ?').all('pending') as Array<{
    id: string; agent_id: string; created_at: number; entry_id: number | null
  }>
  if (!rows.length) return []
  // una lettura per agente esistente (i bot eliminati non chiedono più)
  const agents = new Map<string, { name: string; parentId: string | null }>()
  for (const a of db().prepare('SELECT id, name, parent_id FROM agents').all() as Array<{ id: string; name: string; parent_id: string | null }>) {
    agents.set(a.id, { name: a.name, parentId: a.parent_id })
  }
  // le squadre di ogni bot (per la riga senza marcatore: la squadra se è unica)
  const groupsOf = new Map<string, number[]>()
  for (const m of db().prepare('SELECT group_id, agent_id FROM group_members').all() as Array<{ group_id: number; agent_id: string }>) {
    const list = groupsOf.get(m.agent_id) ?? []
    list.push(m.group_id)
    groupsOf.set(m.agent_id, list)
  }
  const groupName = (gid: number): { id: number; name: string } | null => {
    const g = db().prepare('SELECT id, name FROM groups WHERE id = ?').get(gid) as { id: number; name: string } | undefined
    return g ? { id: g.id, name: g.name } : null
  }
  const out: ApprovalsCenterRow[] = []
  for (const row of rows) {
    const agent = agents.get(row.agent_id)
    if (!agent) {
      // il bot non esiste più: la richiesta non è dell'utente, l'indice si pulisce
      setApprovalRowStatus(row.id, 'agent-gone')
      continue
    }
    const entry = row.entry_id != null ? entryById(row.entry_id) : null
    const meta = (entry?.meta ?? null) as Record<string, unknown> | null
    // le card vere si riconoscono dall'approvalId; le BOZZE (id sintetico
    // draft:<entry>) dal payload in attesa
    const isDraftRow = row.id.startsWith('draft:')
    const entryPending = meta?.status === 'pending' &&
      (isDraftRow ? (meta?.message as { type?: string } | undefined)?.type === 'draft' : meta?.approvalId === row.id)
    if (!entry || !entryPending) {
      // l'indice era rimasto indietro (la entry è già decisa o sparita)
      setApprovalRowStatus(row.id, entry ? String(meta?.status ?? 'closed') : 'closed')
      continue
    }
    const parent = agent.parentId ? agents.get(agent.parentId) ?? null : null
    const botId = parent ? agent.parentId! : row.agent_id
    const botName = parent ? parent.name : agent.name
    // la squadra: il marcatore della card vince; altrimenti quella del bot
    // (il padre, per i sottoagenti) se è UNICA; altrimenti nessuna
    let squad: ApprovalsCenterRow['squad'] = null
    const marker = Number(meta?.squadId ?? 0)
    if (marker && groupName(marker)) squad = groupName(marker)
    else {
      const own = groupsOf.get(botId) ?? []
      if (own.length === 1) squad = groupName(own[0]!)
    }
    out.push({
      agentId: row.agent_id,
      agentName: agent.name,
      parentId: agent.parentId,
      parentName: parent?.name ?? null,
      fromSubagent: !!parent,
      botId,
      botName,
      squad,
      approvalId: row.id,
      entryId: entry.id,
      // le bozze non hanno meta.tool: il nome della chiamata (draft_external)
      tool: String(meta?.tool ?? (meta?.call as { name?: unknown } | undefined)?.name ?? ''),

      phrase: entry.content,
      // la categoria dalla entry col tool risolto (le bozze: draft_external → invio)
      category: squadApprovalCategory({ kind: entry.kind, content: entry.content, meta: { ...meta, tool: String(meta?.tool ?? (meta?.call as { name?: unknown } | undefined)?.name ?? '') } }),
      why: squadApprovalWhy(meta),
      when: entry.createdAt || row.created_at,
      // la BOZZA si riconosce dal payload (le card fill/modulo sono anch'esse
      // kind 'send-message' ma non hanno message.type 'draft')
      isDraft: ((meta?.message as { type?: string } | null)?.type) === 'draft',
      preview: centerPreviewOf(meta),
      // A1 (fase approvazioni-chiare): il meta della card, perché il centro
      // calcola le STESSE scelte della chat (approvalChoicesOf)
      meta
    })
  }
  return out.sort((a, b) => {
    const fa = a.why === 'fisso' ? 0 : 1
    const fb = b.why === 'fisso' ? 0 : 1
    if (fa !== fb) return fa - fb
    return a.when - b.when
  })
}
