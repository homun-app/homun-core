// Fase 10 (§3): il runner dei job `group-turn`. Costruisce l'apertura del turno
// (blocco evidenza con i SOLI messaggi nuovi dopo il cursore, i pari e la
// descrizione del gruppo), gira runTurn nel contesto del MEMBRO, avanza il
// cursore e registra l'esito nel registro dei turni. Scadenza: 5 minuti per
// turno, poi TIMEOUT (oltre alle scadenze dello stream della fase 8).
// Correzioni fase 10: C2 — a fine turno, se la catena si è spenta, il turno di
// CHIUSURA del coordinatore (il riepilogo all'utente che prima non arrivava
// mai); C5 — gli STOPPED col motivo in meta.stopReason diventano ERROR
// (model-error/rate-limit) invece di CANCELLED, e sul rate limit il cursore
// resta fermo, la coda del gruppo si svuota e nel gruppo compare una riga di
// sistema. Correzioni 2: D1 — la profondità della finestra conta SOLO la
// catena del turno, senza i post del membro (readChainDepth, pura); D3 —
// l'attesa del coordinatore conta da quando è nata la catena. Correzioni 3:
// E2 — un PASS senza pass esplicito e con testo libero non pubblicato porta
// il motivo 'testo non pubblicato' nel registro (decide la pura
// needsGroupRecovery, la stessa del recupero nel loop).
// Le dipendenze sono iniettabili: nei test LLM finto e orologio finto.
import type { DatabaseSync } from 'node:sqlite'
import { getAgent, getEntries } from '../main/store/db'
import {
  getGroup, groupMemberIds, groupMessages, getGroupCursor, setGroupCursor,
  getGroupMessage, startGroupTurn, finishGroupTurn, addGroupMessage,
  activeGroupTurnCount, lastBotPostAtInChain, coordinatorLastSendAt,
  scheduleClosingTurn, suspendGroupTurns, groupTurnByNonce,
  type GroupTurnOutcome
} from '../main/store/groups'
import {
  buildGroupTurnOpening, GROUP_WINDING_DOWN_DEPTH, GROUP_RATE_LIMIT_TEXT,
  shouldScheduleClosingTurn, memberWaitingForUser, closingTurnNonce, readChainDepth,
  needsGroupRecovery, parseMentions
} from '../main/agent/group-turns'
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

/**
 * Cursore e finestra di lettura di un membro (pura rispetto allo store
 * passato). Correzione D1: catena e profondità le calcola readChainDepth
 * (pura, in group-turns) — contano solo i messaggi della catena del turno,
 * senza i post del membro stesso; le catene vecchie restano nell'apertura.
 */
export function readWindow(
  groupId: number,
  memberId: string,
  sourceDepth: number | null = null
): { messages: ReturnType<typeof groupMessages>; lastId: number; maxDepth: number; rootId: number | null } {
  const after = getGroupCursor(groupId, memberId)
  const messages = groupMessages(groupId, after)
  let lastId = after
  for (const m of messages) lastId = Math.max(lastId, m.id)
  const { rootId, maxDepth } = readChainDepth({ messages, memberId, sourceDepth })
  return { messages, lastId, maxDepth, rootId }
}

/**
 * Esegue un job group-turn. Esiti nel registro: SENT (almeno un post del
 * membro — o, nel turno di chiusura, un messaggio all'utente), PASS
 * (silenzio), TIMEOUT (scadenza dei 5 minuti), CANCELLED (turno interrotto
 * senza post: loop o interrupt), ERROR (errore del modello o limite d'uso del
 * provider, correzione C5), SKIPPED (gruppo/membro spariti o nessun messaggio
 * nuovo).
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
    /** correzione C2: è il turno di CHIUSURA del coordinatore di questa catena */
    closing?: boolean; rootId?: number
  }
  const finish = (outcome: GroupTurnOutcome, reason?: string): void => finishGroupTurn(p.nonce, outcome, deps.now(), reason)
  const group = getGroup(p.groupId)
  if (!group) return finish('SKIPPED')
  const memberIds = groupMemberIds(group.id)
  if (!memberIds.includes(p.memberId)) return finish('SKIPPED')
  const me = getAgent(p.memberId)
  if (!me || !me.providerId || !me.model) return finish('SKIPPED')

  // la finestra di lettura: i messaggi DOPO il cursore del membro. Il turno di
  // CHIUSURA parte anche a finestra vuota (C2): il coordinatore ha già letto
  // le consegne nei turni precedenti — quel turno è il passo del riepilogo.
  // Correzione D1: la depth del messaggio che ha generato il turno è il
  // fallback quando della catena non resta nulla da leggere
  const sourceDepth = getGroupMessage(p.sourceMessageId)?.depth ?? null
  const win = readWindow(group.id, p.memberId, sourceDepth)
  if (!win.messages.length && !p.closing) return finish('SKIPPED')

  startGroupTurn(p.nonce, deps.now())

  // l'apertura: blocco evidenza con pari, messaggi nuovi e flag di chiusura;
  // nel turno di CHIUSURA (C2) la catena è quella del payload (quella che si
  // sta chiudendo), non l'ultima arrivata nella finestra
  const chainRootId = p.closing && typeof p.rootId === 'number' ? p.rootId : win.rootId
  const agents = memberIds.map((id) => getAgent(id)).filter((a): a is NonNullable<typeof a> => !!a)
  // fase 11 (residuo 0b): il membro era @menzionato nella finestra letta
  // (@tutti compreso) oppure è il turno di chiusura — con risposta vuota il
  // loop farà UNA chiamata di recupero col sollecito dedicato
  const called = p.closing === true || win.messages.some((m) => {
    if (m.author_kind === 'system') return false
    const mentions = parseMentions(m.text, agents.map((a) => ({ id: a.id, name: a.name })))
    return mentions.all || mentions.ids.includes(p.memberId)
  })
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
    windingDown: win.maxDepth >= GROUP_WINDING_DOWN_DEPTH,
    ...(p.closing ? { closing: true } : {})
  })

  // il turno è un turno "di un altro bot" (fase 7): niente auto-review, il
  // testo del gruppo non è consenso dell'utente; l'automaticità della catena
  // si propaga (outbox e tetto urgent)
  // l'id dell'entry che apre il turno si ricava da onTurnEntry (la rilettura
  // dal job non basta: la sospensione C5 può cancellare la riga del job mentre
  // il turno gira ancora)
  let turnEntryId: number | null = typeof job.payload.entryId === 'number' ? job.payload.entryId : null
  const opts: RunTurnOptions = {
    source: 'user',
    initiator: 'GROUP_TURN',
    untrusted: true,
    ...(p.automatic ? { automatic: true } : {}),
    groupTurn: {
      groupId: group.id,
      readMaxDepth: win.maxDepth,
      rootId: chainRootId,
      ...(p.closing ? { closing: true } : {}),
      ...(called ? { called: true } : {})
    },
    ...(typeof job.payload.entryId === 'number' ? { resume: { entryId: job.payload.entryId } } : {}),
    onTurnEntry: (entryId: number): void => {
      turnEntryId = entryId
      setJobEntryId(db, job.id, entryId)
    },
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

  // l'entryId del turno: da onTurnEntry se questo tentativo ha aperto il
  // turno, altrimenti si rilegge dal job (ripresa R1)
  const entryId = turnEntryId ??
    (getJobById(db, job.id)?.payload as { entryId?: number } | undefined)?.entryId ?? null
  const turnEntry = entryId !== null ? getEntries(p.memberId, entryId) : []
  const turnEnd = turnEntry.find((e) => e.kind === 'event' && e.meta?.turnEnd) ?? null
  const stopReason = (turnEnd?.meta?.stopReason as string | undefined) ?? null

  // esito (C2/C5): un post del membro nella finestra del turno → SENT; la
  // scadenza → TIMEOUT; il turno di chiusura vale SENT se ha scritto
  // all'utente; model-error/rate-limit → ERROR; interrotto senza consegne →
  // CANCELLED; altrimenti il silenzio è PASS
  const posted = groupMessages(group.id, postsBefore).some(
    (m) => m.author_kind === 'agent' && m.author_id === p.memberId
  )
  // la consegna all'utente del turno di chiusura: un messaggio di TESTO (le
  // bozze e le card sono attese, non consegne)
  const sentToUser = turnEntry.some((e) => {
    if (e.kind !== 'send-message') return false
    return ((e.meta?.message ?? null) as { type?: string } | null)?.type === 'text'
  })
  let outcome: GroupTurnOutcome = 'PASS'
  if (timedOut) outcome = 'TIMEOUT'
  else if (posted || sentToUser) outcome = 'SENT'
  else if (stopReason === 'rate-limit' || stopReason === 'model-error') outcome = 'ERROR'
  else if (turnEnd?.meta?.turnEnd === 'STOPPED') outcome = 'CANCELLED'
  // correzione E2 (terzo giro): un PASS senza pass esplicito e con testo
  // libero non pubblicato porta il MOTIVO nel registro (si distingue dal
  // silenzio scelto) — la stessa pura che nel loop decide il recupero
  const unpublishedText = outcome === 'PASS' && needsGroupRecovery({
    finished: turnEnd?.meta?.turnEnd === 'FINISHED',
    passed: turnEntry.some((e) => e.kind === 'tool-call' && e.content === 'pass'),
    posted,
    userContact: turnEntry.some((e) => e.kind === 'send-message' || e.kind === 'approval'),
    // l'ultimo testo libero del modello = ultima thinking non vuota del turno
    freeText: [...turnEntry].reverse().find((e) => e.kind === 'thinking' && e.content.trim())?.content ?? '',
    // residuo 0b: stessa fonte del loop (menzione nella finestra o chiusura)
    called
  })
  finish(outcome, unpublishedText ? 'testo non pubblicato' : undefined)

  // correzione C5: limite d'uso del provider — il cursore NON avanza (i
  // messaggi restano da leggere), i job group-turn del gruppo ancora in coda
  // si annullano (SKIPPED col motivo) e nel gruppo compare UNA riga di
  // sistema; niente turno di chiusura: il giro riprende al prossimo messaggio
  if (stopReason === 'rate-limit') {
    suspendGroupTurns(db, group.id, 'rate limit del provider: giro sospeso', job.id)
    const now = deps.now()
    const recent = groupMessages(group.id).filter(
      (m) => m.author_kind === 'system' && m.text === GROUP_RATE_LIMIT_TEXT && m.created_at > now - 3_600_000
    )
    if (!recent.length) {
      addGroupMessage({ groupId: group.id, authorKind: 'system', authorId: null, authorName: 'sistema', text: GROUP_RATE_LIMIT_TEXT })
      emit({ type: 'groups' })
    }
    return
  }

  // il cursore avanza a fine turno: i messaggi arrivati MENTRE girava restano
  // nuovi (hanno già generato i loro turni per questo membro)
  setGroupCursor(group.id, p.memberId, win.lastId)

  // correzione C2: la catena si è SPENTA (nessun turno pianificato o in corso
  // per il gruppo) → il runner accoda UN turno di chiusura per il
  // coordinatore, se ha consegne da riportare che non ha già riportato
  // (rootId nullo = finestra senza messaggi di membri: non è una catena)
  const coordinatorId = group.coordinator_id
  if (coordinatorId && memberIds.includes(coordinatorId) && chainRootId !== null) {
    const lastBotPost = lastBotPostAtInChain(group.id, chainRootId, coordinatorId)
    const lastSend = coordinatorLastSendAt(group.id, chainRootId, coordinatorId)
    const decision = shouldScheduleClosingTurn({
      coordinatorId,
      chainEnded: activeGroupTurnCount(group.id) === 0,
      newsForCoordinator: lastBotPost !== null && lastBotPost > (lastSend ?? 0),
      // correzione D3: l'attesa conta solo da quando è NATA la catena (il
      // created_at del suo messaggio root) — un widget di settimane prima mai
      // risposto non blocca per sempre i turni di chiusura
      coordinatorWaiting: memberWaitingForUser(getEntries(coordinatorId), getGroupMessage(chainRootId)?.created_at ?? 0),
      closeTurnExists: groupTurnByNonce(closingTurnNonce(group.id, coordinatorId, chainRootId)) !== null
    })
    if (decision.schedule) {
      scheduleClosingTurn({
        groupId: group.id,
        coordinatorId,
        rootId: chainRootId,
        sourceMessageId: p.sourceMessageId,
        ...(p.automatic ? { automatic: true } : {}),
        emit
      })
    }
  }
}
