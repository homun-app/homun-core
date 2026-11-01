// Il feed ATTIVITÀ del computer del bot (fase 19b, T4): ciò che il bot ha
// fatto sul suo computer, dal vivo e nello storico. Le due fonti:
// - i COMANDI sono la tabella shell_jobs, che dalla 11b registra OGNI
//   run-command (foreground e background) con log ed exit code — NON si crea
//   una seconda tabella;
// - le AZIONI SUI FILE (write-file, copy_to_box, copy_from_box, upload e
//   download dell'utente) sono la tabella nuova computer_actions.
//
// Regola di Rakazo (T4.1): il feed è una VISTA — un errore nel registrare NON
// fa fallire il tool: si logga nel daemon e basta.
//
// Evento push `computer-activity` { ownerId } a ogni nuova riga di
// computer_actions e a ogni cambio di stato di shell_jobs (avvio, fine, kill,
// perso): niente payload pesante, la UI ricarica.
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { db as dbFn, familyAgents } from '../store/db'
import { boxOwnerOf } from '../sandbox'
import {
  createComputerAction, getComputerAction, recentComputerActionsOf,
  type ComputerAction, type ComputerActionKind
} from '../store/computer-actions'
import { recentShellJobsOfAgents, type ShellJob } from '../store/shell-jobs'
import type { SandbotEvent } from '../../shared/types'

/** L'output di una voce del feed non supera mai questi caratteri (come Rakazo). */
export const ACTIVITY_OUTPUT_MAX_CHARS = 16_000

/** Il testo (comando o path) di una voce del feed, troncato a 500 caratteri. */
export const ACTIVITY_TEXT_MAX_CHARS = 500

/** Il default di activity:list. */
export const ACTIVITY_LIST_LIMIT = 100

// ---- l'emettitore dell'evento (lo registra il wiring del daemon) ----

let emitActivity: (e: SandbotEvent) => void = () => undefined

/** Il daemon registra il broadcast del server ws. */
export function setComputerActivityEmitter(emit: (e: SandbotEvent) => void): void {
  emitActivity = emit
}

/** L'evento push di un agente (idemPotente: senza emitter è un no-op). */
export function emitComputerActivity(agentId: string): void {
  try {
    emitActivity({ type: 'computer-activity', ownerId: boxOwnerOf(agentId) })
  } catch (e) {
    console.error('[activity] evento non emesso:', e)
  }
}

// ---- la registrazione delle azioni sui file (T4.1) ----

export interface RecordActionInput {
  /** chi ha fatto l'azione (di solito il bot chiamante). */
  agentId: string
  kind: ComputerActionKind
  /** path del box (per copy_out/download: anche il nome del file del Mac, mai il percorso completo). */
  target: string
  actor?: 'bot' | 'user'
  bytes?: number | null
  error?: string | null
  /** connessione iniettabile per i test; default il db del daemon. */
  db?: DatabaseSync
  now?: () => number
}

/**
 * Registra un'azione sui file in computer_actions. La regola di Rakazo: un
 * errore qui NON fa fallire il tool — si logga nel daemon e basta.
 */
export function recordComputerAction(input: RecordActionInput): void {
  try {
    const database = input.db ?? dbFn()
    const at = (input.now ?? Date.now)()
    createComputerAction(database, {
      id: `act-${randomUUID().slice(0, 12)}`,
      agent_id: input.agentId,
      owner_id: boxOwnerOf(input.agentId),
      actor: input.actor ?? 'bot',
      kind: input.kind,
      target: truncateText(input.target),
      bytes: input.bytes ?? null,
      error: input.error ? String(input.error).slice(0, 500) : null,
      created_at: at
    })
    emitComputerActivity(input.agentId)
  } catch (e) {
    // il feed è una vista: la registrazione non può rompere il tool
    console.error('[activity] azione non registrata:', e)
  }
}

/** Il testo troncato (PURO). */
export function truncateText(text: string): string {
  return text.length > ACTIVITY_TEXT_MAX_CHARS ? text.slice(0, ACTIVITY_TEXT_MAX_CHARS) : text
}

// ---- la famiglia del proprietario (T4.1: nel feed ci sono anche i figli) ----

/**
 * Gli agenti della famiglia di un proprietario: lui e i suoi FIGLI (righe di
 * agents con parent_id — escluse dal roster, ma i loro comandi stanno in
 * shell_jobs). Iniettabile per i test.
 */
export function familyAgentIds(owner: string, deps: { family?: (owner: string) => Array<{ id: string; name: string }> } = {}): Array<{ id: string; name: string }> {
  try {
    return (deps.family ?? familyAgents)(owner)
  } catch {
    return [] // store non disponibile: lista vuota
  }
}

// ---- activity:list (T4.2): l'unione delle due fonti, ordinata ----

export interface ActivityItem {
  id: string
  source: 'shell' | 'action'
  agentId: string
  agentName: string
  actor: 'bot' | 'user'
  kind: 'shell' | ComputerActionKind
  text: string
  status: 'running' | 'done' | 'killed' | 'lost' | 'expired' | 'ok' | 'error'
  exitCode: number | null
  bytes: number | null
  startedAt: number
  finishedAt: number | null
}

/** La voce del feed di una riga shell_jobs (PURO). */
export function shellItem(job: ShellJob, agentName: string): ActivityItem {
  return {
    id: job.id,
    source: 'shell',
    agentId: job.agent_id,
    agentName,
    actor: 'bot',
    kind: 'shell',
    text: truncateText(job.command),
    status: job.status,
    exitCode: job.exit_code,
    bytes: null,
    startedAt: job.started_at,
    finishedAt: job.finished_at
  }
}

/** La voce del feed di una riga computer_actions (PURO). */
export function actionItem(action: ComputerAction, agentName: string): ActivityItem {
  return {
    id: action.id,
    source: 'action',
    agentId: action.agent_id,
    agentName,
    actor: action.actor,
    kind: action.kind,
    text: truncateText(action.target),
    status: action.error ? 'error' : 'ok',
    exitCode: null,
    bytes: action.bytes,
    startedAt: action.created_at,
    finishedAt: action.created_at
  }
}

/**
 * L'unione e l'ORDINAMENTO delle due fonti (PURO, T7): dalla più recente.
 * Un winner per id non serve: le due fonti hanno id diversi per costruzione
 * (sh-… e act-…).
 */
export function mergeActivity(shells: ShellJob[], actions: ComputerAction[], agentNameOf: (agentId: string) => string, limit: number): ActivityItem[] {
  const items = [...shells.map((j) => shellItem(j, agentNameOf(j.agent_id))), ...actions.map((a) => actionItem(a, agentNameOf(a.agent_id)))]
  items.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1))
  return items.slice(0, limit)
}

/**
 * RPC `activity:list [agentId, limit?]` → le ultime N voci della FAMIGLIA del
 * pannello (i comandi dei figli compresi, col nome del figlio). Risponde
 * anche l'`owner`, così la UI collega gli eventi `computer-activity` al bot
 * giusto.
 */
export function listComputerActivity(
  agentId: string,
  limitIn?: number,
  deps: { db?: DatabaseSync; family?: (owner: string) => Array<{ id: string; name: string }> } = {}
): { owner: string; items: ActivityItem[] } {
  const database = deps.db ?? dbFn()
  const owner = boxOwnerOf(agentId)
  const limit = Math.min(500, Math.max(1, Math.floor(limitIn ?? ACTIVITY_LIST_LIMIT)))
  const family = familyAgentIds(owner, deps)
  const nameOf = (id: string): string => family.find((a) => a.id === id)?.name ?? ''
  const shells = recentShellJobsOfAgents(database, family.map((a) => a.id), limit)
  const acts = recentComputerActionsOf(database, owner, limit)
  return { owner, items: mergeActivity(shells, acts, nameOf, limit) }
}

// ---- activity:output (T4.2): la coda dell'output di UNA voce ----

/**
 * RPC `activity:output [agentId, id]`: per una voce `shell` la coda del log
 * con la redazione di oggi (redactedTail, ultime 200 righe, al massimo
 * ACTIVITY_OUTPUT_MAX_CHARS caratteri); per una `action` l'eventuale errore.
 * Il log si legge SOLO se la shell appartiene alla famiglia del proprietario:
 * altrimenti errore. L'output dal vivo si legge SU RICHIESTA (niente push
 * ogni 400 ms: il log esiste già nel box).
 */
export async function computerActivityOutput(agentId: string, id: string): Promise<string> {
  const database = dbFn()
  const owner = boxOwnerOf(agentId)
  if (id.startsWith('sh-')) {
    const { getShellJob } = await import('../store/shell-jobs')
    const job = getShellJob(database, id)
    if (!job) throw new Error(`No activity with id "${id}".`)
    if (boxOwnerOf(job.agent_id) !== owner) {
      throw new Error('That command belongs to another bot\'s family: its log cannot be read here.')
    }
    const { shellOutputTail } = await import('./shells')
    const tail = await shellOutputTail(job.agent_id, job)
    return tail.slice(-ACTIVITY_OUTPUT_MAX_CHARS)
  }
  const action = getComputerAction(database, id)
  if (!action) throw new Error(`No activity with id "${id}".`)
  if (boxOwnerOf(action.agent_id) !== owner) {
    throw new Error('That action belongs to another bot\'s family: it cannot be read here.')
  }
  return action.error ?? ''
}
