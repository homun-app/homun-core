// Scheduler delle routine: niente timer per routine — a ogni tick si calcola
// (funzione pura) il prossimo run di ogni routine abilitata e, se è scaduto,
// si accoda un job 'routine-run' nella coda durevole. Se l'agente è occupato
// la routine viene scartata con una notice (stessa semantica della fase 1).
// Senza stato: legge le routine dal db a ogni tick, quindi CRUD e riavvii
// non richiedono ricaricamenti.
//
// Fase 6: il prossimo run rispetta il trigger (cron, "ogni X" con around)
// e il fuso orario della routine (triggers.ts/tz.ts); i trigger
// connector_poll hanno un tick proprio (tickConnectorPolls) che chiama il
// tool MCP in sola lettura, tiene il set dei visti (ultimi 1000) e accoda un
// job per ogni id NUOVO (la prima esecuzione è silenziosa); il preset
// calendar_event programma il job a start - offsetMinutes.
import type { DatabaseSync } from 'node:sqlite'
import { listRoutines, touchRoutineRun, touchRoutinePoll, appendEntry, getEntries, getSetting, setSetting, type Routine } from '../main/store/db'
import { activeJobForAgent, enqueueJob, type Job } from '../main/store/jobs'
import { nextScheduleRun, nextPollAt } from './triggers'
import { extractIds, extractByPath, splitIdField, guessEventStart, guessItemTitle, mergeSeenIds, type SeenState } from '../shared/triggers'
import type { SandbotEvent, TriggerEventPayload } from '../shared/types'

type Emitter = (e: SandbotEvent) => void

export interface SchedulerDeps {
  now(): number
}

/** Accoda il job di run di una routine (con l'evento che l'ha causata, se c'è). */
export function enqueueRoutineRun(
  db: DatabaseSync,
  r: Pick<Routine, 'id' | 'agent_id' | 'title' | 'prompt'>,
  now: number,
  event?: TriggerEventPayload,
  runAt?: number
): Job {
  const payload: Record<string, unknown> = { routineId: r.id, title: r.title, prompt: r.prompt }
  if (event) payload.event = event
  return enqueueJob(db, {
    agentId: r.agent_id,
    kind: 'routine-run',
    payload,
    runAt: runAt ?? now,
    now
  })
}

/** Routine abilitate il cui prossimo run pianificato è già scaduto (pure, per i test). */
export function dueRoutines(routines: Routine[], now: number): Routine[] {
  return routines.filter((r) => {
    if (!r.enabled) return false
    // base di partenza: ultimo run, o la creazione per le routine mai girate
    const from = r.last_run ?? r.created_at
    const next = nextScheduleRun(r, from)
    return next !== null && next <= now
  })
}

/**
 * Un tick dello scheduler: per ogni routine dovuta registra il run
 * (last_run) e accoda il job, oppure la scarta con notice se l'agente ha un
 * job attivo.
 */
export function tickScheduler(db: DatabaseSync, emit: Emitter, now: number): Job[] {
  const due = dueRoutines(listRoutines(), now)
  const enqueued: Job[] = []
  for (const r of due) {
    touchRoutineRun(r.id)
    if (activeJobForAgent(db, r.agent_id)) {
      appendEntry({
        agentId: r.agent_id, kind: 'notice', role: 'system',
        content: `Routine "${r.title}" saltata: l'agente è occupato.`
      })
      emit({ type: 'entries', agentId: r.agent_id, entries: getEntries(r.agent_id).slice(-1) })
      continue
    }
    enqueued.push(enqueueRoutineRun(db, r, now))
  }
  return enqueued
}

// ---- trigger connector_poll ----

export interface PollDeps {
  db: DatabaseSync
  emit: Emitter
  now(): number
  /** Chiama un tool MCP (nome completo mcp__…) e ne torna l'output testuale. */
  callMcpTool(tool: string, args: Record<string, unknown>): Promise<string>
}

/** Il set dei visti di una routine (settings, iniettabile per coerenza col resto). */
function seenOf(routineId: number): SeenState {
  return getSetting<SeenState>(`trigger.seen.${routineId}`, { ids: [], primed: false })
}

function saveSeen(routineId: number, seen: SeenState): void {
  setSetting(`trigger.seen.${routineId}`, seen)
}

/** Parca la risposta del tool come oggetto (best-effort JSON), per estrarre gli id. */
function parseToolOutput(out: string): unknown {
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

/**
 * Un tick dei poll: per ogni routine attiva con trigger connector_poll il
 * cui intervallo è scaduto, chiama il tool e produce gli eventi (id nuovi).
 * Il last_poll viene registrato PRIMA della chiamata: un crash a metà non
 * ripete il poll subito. La prima esecuzione registra gli id esistenti senza
 * scatenare eventi.
 */
export async function tickConnectorPolls(deps: PollDeps, now: number): Promise<void> {
  for (const r of listRoutines()) {
    if (!r.enabled || r.trigger?.type !== 'connector_poll') continue
    const t = r.trigger
    if (nextPollAt(r.last_poll ?? null, r.created_at, t.intervalMin) > now) continue
    touchRoutinePoll(r.id, now) // claim del poll

    let out: string
    try {
      out = await deps.callMcpTool(t.tool, t.args ?? {})
    } catch (e) {
      // tool non raggiungibile (connettore needs_auth, rete): silenzioso nel
      // transcript, si riprova al prossimo intervallo
      console.error(`[sandbotd] poll routine "${r.title}" (${t.tool}) fallito:`, e instanceof Error ? e.message : e)
      continue
    }
    const seen = seenOf(r.id)
    const parsed = parseToolOutput(out)
    if (parsed === null) continue

    // preset calendar_event: job programmato a start - offsetMinutes
    if (t.preset === 'calendar_event') {
      const split = splitIdField(t.idField)
      if (!split) continue
      const items = extractByPath(parsed, split.itemsPath)
      const newIds: string[] = []
      const known = new Set(seen.ids)
      for (const item of items) {
        const id = String((item as Record<string, unknown>)?.[split.idKey] ?? '')
        if (!id || known.has(id)) continue
        const start = guessEventStart(item)
        // eventi delle prossime 24 ore non ancora iniziati; già passati → skip
        if (start === null || start < now || start > now + 86_400_000) {
          known.add(id) // comunque visto: non riprovarlo al prossimo poll
          newIds.push(id)
          continue
        }
        const offset = (t.offsetMinutes ?? 0) * 60_000
        const runAt = Math.max(start - offset, now)
        const title = guessItemTitle(item)
        enqueueRoutineRun(deps.db, r, now, {
          source: 'calendar_event',
          title: `Evento del calendario in arrivo${title ? `: ${title}` : ''}`,
          data: item,
          at: start
        }, runAt)
        known.add(id)
        newIds.push(id)
      }
      if (newIds.length) saveSeen(r.id, mergeSeenIds({ ...seen, primed: true }, newIds))
      else if (!seen.primed) saveSeen(r.id, { ...seen, primed: true })
      continue
    }

    // poll generico (preset email incluso): un evento per ogni id NUOVO
    const ids = extractIds(parsed, t.idField)
    if (!seen.primed) {
      // prima esecuzione: registra gli id esistenti senza scatenare eventi
      saveSeen(r.id, { ids: ids.slice(-1000), primed: true })
      continue
    }
    const known = new Set(seen.ids)
    const fresh = ids.filter((id) => !known.has(id))
    if (fresh.length) {
      const split = splitIdField(t.idField)
      const items = split ? extractByPath(parsed, split.itemsPath) : []
      for (const id of fresh) {
        const item = items.find((x) => String((x as Record<string, unknown>)?.[split!.idKey] ?? '') === id)
        const title = guessItemTitle(item)
        enqueueRoutineRun(deps.db, r, now, {
          source: 'connector_poll',
          title: t.preset === 'email'
            ? `Nuova email${title ? `: ${title}` : ` (id ${id})`}`
            : `Nuovo elemento${title ? `: ${title}` : ` (id ${id})`}`,
          data: item ?? id,
          at: now
        })
      }
      saveSeen(r.id, mergeSeenIds(seen, fresh))
    }
  }
}
