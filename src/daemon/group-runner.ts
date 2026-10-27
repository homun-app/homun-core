// Fase 10 (§3): il runner dei job `group-turn`. Costruisce l'apertura del turno
// (blocco evidenza con i SOLI messaggi nuovi dopo il cursore, i pari e la
// descrizione del gruppo), gira runTurn nel contesto del MEMBRO, avanza il
// cursore e registra l'esito nel registro dei turni. Scadenza: 5 minuti per
// turno, poi TIMEOUT (oltre alle scadenze dello stream della fase 8). Le
// dipendenze sono iniettabili: nei test LLM finto e orologio finto.
import type { DatabaseSync } from 'node:sqlite'
import { getAgent, getEntries } from '../main/store/db'
import {
  getGroup, groupMemberIds, groupMessages, getGroupCursor, setGroupCursor,
  getGroupMessage, startGroupTurn, finishGroupTurn, type GroupTurnOutcome
} from '../main/store/groups'
import { buildGroupTurnOpening, GROUP_WINDING_DOWN_DEPTH } from '../main/agent/group-turns'
import { setJobEntryId, getJobById, type Job } from '../main/store/jobs'
import type { runTurn, RunTurnOptions } from '../main/agent/loop'
import type { SandbotEvent } from '../shared/types'

type Emitter = (e: SandbotEvent) => void
type RunTurnFn = typeof runTurn

/** La scadenza di un turno di gruppo (spec §3): 5 minuti, poi TIMEOUT. */
export const GROUP_TURN_TIMEOUT_MS = 5 * 60_000

export interface GroupRunnerDeps {
  runTurn: RunTurnFn
  /** interrompe il turno del membro (scatenza raggiunta): la stessa del loop */
  interrupt(agentId: string): void
  now(): number
  /** arma la scadenza del turno e torna la funzione di annullamento (test) */
  armTimeout(cb: () => void, ms: number): () => void
}

export const defaultArmTimeout = (cb: () => void, ms: number): (() => void) => {
  const t = setTimeout(cb, ms)
  t.unref?.()
  return () => clearTimeout(t)
}

/** Cursore e finestra di lettura di un membro (pura rispetto allo store passato). */
export function readWindow(
  groupId: number,
  memberId: string
): { messages: ReturnType<typeof groupMessages>; lastId: number; maxDepth: number; rootId: number | null } {
  const after = getGroupCursor(groupId, memberId)
  const messages = groupMessages(groupId, after)
  let lastId = after
  let maxDepth = -1
  let rootId: number | null = null
  for (const m of messages) {
    lastId = Math.max(lastId, m.id)
    if (m.author_kind !== 'system' && m.depth > maxDepth) {
      maxDepth = m.depth
      rootId = m.root_id ?? m.id
    }
  }
  return { messages, lastId, maxDepth, rootId }
}

/**
 * Esegue un job group-turn. Esiti nel registro: SENT (almeno un post del
 * membro), PASS (silenzio), TIMEOUT (scadenza dei 5 minuti), CANCELLED (turno
 * interrotto senza post), ERROR (runTurn ha lanciato), SKIPPED (gruppo/membro
 * spariti o nessun messaggio nuovo).
 */
export async function runGroupTurnJob(
  db: DatabaseSync,
  deps: GroupRunnerDeps,
  job: Job,
  emit: Emitter
): Promise<void> {
  const p = job.payload as {
    groupId: number; memberId: string; nonce: string; sourceMessageId: number
    automatic?: boolean; entryId?: number
  }
  const finish = (outcome: GroupTurnOutcome): void => finishGroupTurn(p.nonce, outcome, deps.now())
  const group = getGroup(p.groupId)
  if (!group) return finish('SKIPPED')
  const memberIds = groupMemberIds(group.id)
  if (!memberIds.includes(p.memberId)) return finish('SKIPPED')
  const me = getAgent(p.memberId)
  if (!me || !me.providerId || !me.model) return finish('SKIPPED')

  // la finestra di lettura: i messaggi DOPO il cursore del membro
  const win = readWindow(group.id, p.memberId)
  if (!win.messages.length) return finish('SKIPPED')

  startGroupTurn(p.nonce, deps.now())

  // l'apertura: blocco evidenza con pari, messaggi nuovi e flag di chiusura
  const agents = memberIds.map((id) => getAgent(id)).filter((a): a is NonNullable<typeof a> => !!a)
  const opening = buildGroupTurnOpening({
    group: { id: group.id, name: group.name, description: group.description },
    me: { name: me.name },
    peers: agents
      .filter((a) => a.id !== p.memberId)
      .map((a) => ({ name: a.name, role: a.description, coordinator: a.id === group.coordinator_id })),
    newMessages: win.messages.map((m) => ({
      id: m.id,
      authorKind: m.author_kind,
      authorName: m.author_name,
      text: m.text,
      replyTo: m.reply_to
        ? (() => {
            const r = getGroupMessage(m.reply_to)
            return r ? { authorName: r.author_name, quote: r.text.slice(0, 120) } : null
          })()
        : null
    })),
    windingDown: win.maxDepth >= GROUP_WINDING_DOWN_DEPTH
  })

  // il turno è un turno "di un altro bot" (fase 7): niente auto-review, il
  // testo del gruppo non è consenso dell'utente; l'automaticità della catena
  // si propaga (outbox e tetto urgent)
  const opts: RunTurnOptions = {
    source: 'user',
    initiator: 'GROUP_TURN',
    untrusted: true,
    ...(p.automatic ? { automatic: true } : {}),
    groupTurn: { groupId: group.id, readMaxDepth: win.maxDepth, rootId: win.rootId },
    ...(typeof job.payload.entryId === 'number' ? { resume: { entryId: job.payload.entryId } } : {}),
    onTurnEntry: (entryId: number): void => setJobEntryId(db, job.id, entryId),
    extraMeta: { groupId: group.id, groupTurnNonce: p.nonce }
  }

  // scadenza del turno: 5 minuti, poi si interrompe il membro e vale TIMEOUT
  let timedOut = false
  const cancelTimer = deps.armTimeout(() => {
    timedOut = true
    deps.interrupt(p.memberId)
  }, GROUP_TURN_TIMEOUT_MS)

  const postsBefore = win.lastId
  try {
    await deps.runTurn(p.memberId, opening, emit, undefined, opts)
  } catch (e) {
    cancelTimer()
    finish('ERROR')
    throw e
  }
  cancelTimer()

  // esito: un post del membro nella finestra del turno → SENT; scadenza →
  // TIMEOUT; interrotto senza post → CANCELLED; altrimenti il silenzio è PASS
  const posted = groupMessages(group.id, postsBefore).some(
    (m) => m.author_kind === 'agent' && m.author_id === p.memberId
  )
  let outcome: GroupTurnOutcome = 'PASS'
  if (posted) outcome = 'SENT'
  else if (timedOut) outcome = 'TIMEOUT'
  else {
    // l'entryId sta nel payload aggiornato del job (onTurnEntry lo scrive nel
    // DB, non nell'oggetto in memoria): si rilegge per trovare il turnEnd
    const entryId = typeof job.payload.entryId === 'number'
      ? job.payload.entryId
      : (getJobById(db, job.id)?.payload as { entryId?: number } | undefined)?.entryId ?? null
    const turnEnd = entryId !== null
      ? getEntries(p.memberId, entryId).find((e) => e.kind === 'event' && e.meta?.turnEnd)
      : null
    if (turnEnd?.meta?.turnEnd === 'STOPPED') outcome = 'CANCELLED'
  }
  finish(outcome)

  // il cursore avanza a fine turno: i messaggi arrivati MENTRE girava restano
  // nuovi (hanno già generato i loro turni per questo membro)
  setGroupCursor(group.id, p.memberId, win.lastId)
}
