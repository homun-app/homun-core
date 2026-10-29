// Operazioni sui SOTTOAGENTI nel daemon (fase 12, punti 4 e 5): il controllo
// del lotto quando un figlio diventa terminale (UN messaggio di risveglio per
// lotto, atomico), la scadenza al tick dello scheduler e il recupero al boot
// dei lotti finiti ma mai svegliati (crash tra la fine e il risveglio).
// L'interrupt del figlio è una dipendenza iniettabile (come group-runner):
// niente import statici del loop, i test girano con orologio e interrupt finti.
import type { DatabaseSync } from 'node:sqlite'
import { enqueueJob } from '../main/store/jobs'
import {
  getSubagent, closeSubagent, subagentsOfBatch, wakeBatch, sealBatch, unsealedBatches,
  unwokenBatches, expiredSubagents, type SubagentRow
} from '../main/store/subagents'
import { formatSubagentsDone } from '../shared/agent-message'
import { expiredSummary } from '../main/agent/subagents'
import { getEntries } from '../main/store/db'
import type { SandbotEvent } from '../shared/types'

type Emitter = (e: SandbotEvent) => void

export interface SubagentOpsDeps {
  /** interrompe il turno del figlio (scadenza): la stessa del loop */
  interrupt(agentId: string): void
  now(): number
}

/** L'evento di cambio stato per la UI del padre (card e pannello, punto 7). */
export function subagentsChanged(parentId: string, emit: Emitter): void {
  emit({ type: 'subagents', parentId })
}

/**
 * L'ultimo testo libero di un agente (puro rispetto alle entry passate): il
 * ripiego del summary nelle chiusure non consegnate (scadenza, chiusura
 * automatica).
 */
export function lastFreeTextOf(entries: ReadonlyArray<{ kind: string; content: string }>): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind === 'thinking' && e.content.trim()) return e.content
  }
  return ''
}

/**
 * Punto 5: un figlio è diventato TERMINALE (done/failed/stopped/expired) — si
 * controlla il suo LOTTO. Il controllo vero sta in checkBatch: con il sigillo
 * (J2) un figlio che consegna a metà turno del padre NON sveglia da solo.
 */
export function onSubagentTerminal(db: DatabaseSync, subagentId: string, emit: Emitter): void {
  const row = getSubagent(db, subagentId)
  if (!row) return
  subagentsChanged(row.parent_id, emit)
  checkBatch(db, row.batch_id, emit)
}

/**
 * Il controllo del lotto: se TUTTI i figli sono terminali e il lotto è
 * SIGILLATO, l'UPDATE atomico wakeBatch li marca svegliati e accoda UN SOLO
 * job di risveglio per il padre (user-message SUBAGENTS_DONE nella chat
 * principale, task-run nel task che li ha lanciati). Due figli che finiscono
 * insieme non svegliano il padre due volte: il secondo UPDATE non restituisce
 * righe.
 */
function checkBatch(db: DatabaseSync, batchId: string, emit: Emitter): void {
  const sibs = subagentsOfBatch(db, batchId)
  if (sibs.some((s) => s.status === 'queued' || s.status === 'running')) return
  const woken = wakeBatch(db, batchId)
  if (!woken.length) return
  enqueueWakeJob(db, woken, emit)
}

/**
 * Correzione J2: il turno del padre è FINITO (qualunque esito) — si sigilla
 * il suo lotto e si controlla SUBITO: se i figli erano già tutti terminali il
 * risveglio parte da qui, non dalla prima consegna arrivata a metà turno
 * (padre che lancia, legge/cerca, lancia ancora: UN solo resoconto).
 */
export function sealTurnBatch(db: DatabaseSync, batchId: string, emit: Emitter): void {
  sealBatch(db, batchId)
  checkBatch(db, batchId, emit)
}

/** Il testo del risveglio: il formatter VERO del blocco <risultati_sottoagenti>. */
export function subagentsDoneText(rows: ReadonlyArray<SubagentRow>): string {
  return formatSubagentsDone(rows)
}

/**
 * Accoda l'UNICO job di risveglio del padre col testo del lotto: untrusted se
 * UN figlio lo era, automatic se il lotto lo era (nascono dallo stesso turno
 * del padre), contaminated se UN figlio ha letto contenuti non fidati — il
 * turno del padre parte già contaminato (lift F8 sui tool con effetti).
 */
function enqueueWakeJob(db: DatabaseSync, rows: ReadonlyArray<SubagentRow>, emit: Emitter): void {
  const first = rows[0]!
  const text = subagentsDoneText(rows)
  const now = Date.now()
  const flags = {
    ...(rows.some((r) => r.untrusted) ? { untrusted: true } : {}),
    ...(rows.some((r) => r.automatic) ? { automatic: true } : {}),
    ...(rows.some((r) => r.contaminated) ? { contaminated: true } : {})
  }
  if (first.parent_task_id != null) {
    // padre in un task: il risultato torna al task (brief = stesso testo)
    enqueueJob(db, {
      agentId: first.parent_id,
      kind: 'task-run',
      payload: { taskId: first.parent_task_id, brief: text, ...flags },
      runAt: now,
      now
    })
  } else {
    enqueueJob(db, {
      agentId: first.parent_id,
      kind: 'user-message',
      payload: {
        text,
        initiator: 'SUBAGENTS_DONE',
        extraMeta: { subagentBatch: first.batch_id },
        ...flags
      },
      runAt: now,
      now
    })
  }
  subagentsChanged(first.parent_id, emit)
}

/**
 * Correzione J2, il boot: i lotti NON sigillati si sigillano e si controllano
 * subito — un daemon morto a metà turno del padre lasciava il lotto aperto e
 * nessun figlio poteva più svegliarlo. Al boot nessun padre ha un turno in
 * corso, quindi si sigillano TUTTI (i figli ancora aperti restano aperti: il
 * loro sigillo non c'entra con la loro esecuzione, conta solo per il
 * risveglio). Torna quanti lotti ha sigillato.
 */
export function sealBatchesAtBoot(db: DatabaseSync, emit: Emitter): number {
  let sealed = 0
  for (const batchId of unsealedBatches(db)) {
    sealBatch(db, batchId)
    sealed++
    checkBatch(db, batchId, emit)
  }
  return sealed
}

/**
 * Al boot (punto 5): i lotti TUTTI terminali SIGILLATI con woken = 0 vengono
 * svegliati — il daemon può morire tra l'ultima chiusura di un figlio e
 * l'accodamento del risveglio. Torna quanti lotti ha svegliato.
 */
export function wakeDueBatchesAtBoot(db: DatabaseSync, emit: Emitter): number {
  let wokenBatches = 0
  for (const batchId of unwokenBatches(db)) {
    const rows = wakeBatch(db, batchId)
    if (rows.length) {
      enqueueWakeJob(db, rows, emit)
      wokenBatches++
    }
  }
  return wokenBatches
}

/**
 * Punto 4, la scadenza: figli queued/running oltre deadline_at → interrupt,
 * poi status expired con summary = ultimo testo libero + "(scaduto dopo N
 * minuti)". Conta come terminale: il controllo del lotto parte da qui.
 * Torna i figli scaduti.
 */
export function tickSubagentDeadlines(db: DatabaseSync, deps: SubagentOpsDeps, emit: Emitter): SubagentRow[] {
  const due = expiredSubagents(db, deps.now())
  for (const row of due) {
    deps.interrupt(row.id)
    const minutes = Math.max(1, Math.round((deps.now() - row.created_at) / 60_000))
    closeSubagent(db, row.id, {
      status: 'expired',
      summary: expiredSummary(lastFreeTextOf(getEntries(row.id)), minutes),
      finishedAt: deps.now()
    })
    onSubagentTerminal(db, row.id, emit)
  }
  return due
}
