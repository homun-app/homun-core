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
import type { TranscriptEntry, ApprovalsCenterRow } from '../../shared/types'

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
    if (!entry || meta?.status !== 'pending' || meta?.approvalId !== row.id) {
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
      tool: String(meta?.tool ?? ''),
      phrase: entry.content,
      category: squadApprovalCategory(entry),
      why: squadApprovalWhy(meta),
      when: entry.createdAt || row.created_at,
      isDraft: entry.kind === 'send-message',
      preview: centerPreviewOf(meta)
    })
  }
  return out.sort((a, b) => {
    const fa = a.why === 'fisso' ? 0 : 1
    const fb = b.why === 'fisso' ? 0 : 1
    if (fa !== fb) return fa - fb
    return a.when - b.when
  })
}
