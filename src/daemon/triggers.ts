// Prossima esecuzione di una routine per tipo di trigger (fase 6, §3bis L3),
// sul muro del fuso orario della routine: schedule cron (colonna legacy o
// trigger), schedule "ogni X" con mode 'at'/'around' (variazione ±15 min
// DETERMINISTICA per routine + data), poll dei connettori (intervallo),
// webhook e presence_return (nessun run pianificato: scattano a evento).
// Funzioni pure: il tempo entra solo da `from`, nessun timer né I/O.
import { nextCronRun } from './cron'
import { tzParts, wallToEpoch, localTimeZone, isValidTimeZone, parseHm } from './tz'
import { aroundJitterMinutes, AROUND_MAX_MIN } from '../shared/triggers'
import type { EveryScheduleSpec, RoutineTrigger } from '../shared/types'

export interface RoutineTiming {
  id: number
  /** colonna schedule (cron a 5 campi): valida per le routine pre-fase 6 e i trigger cron */
  schedule: string
  timezone?: string
  trigger?: RoutineTrigger | null
}

/** Il fuso orario valido della routine (o quello locale del processo). */
export function routineTimeZone(tz?: string): string {
  return tz && isValidTimeZone(tz) ? tz : localTimeZone()
}

/** Il giorno matcha lo schedule "ogni X"? (day-of-month + giorno della settimana) */
function dayMatchesEvery(e: EveryScheduleSpec, dayOfMonth: number, dow: number): boolean {
  switch (e.every) {
    case 'day': return true
    case 'weekday': return dow >= 1 && dow <= 5
    case 'week': return dow === (e.weekday ?? 1)
    case 'month': return dayOfMonth === (e.monthDay ?? 1)
    // 'hour' non è basato su giorni: gestito a parte
    case 'hour': return true
  }
}

const DAY_MS = 86_400_000

/** Seed del jitter 'around': id routine + data dell'occorrenza (fuso locale della routine). */
function aroundSeed(routineId: number, y: number, mo: number, d: number): string {
  return `${routineId}:${y}-${mo}-${d}`
}

/**
 * Prossima occorrenza (epoch ms) di uno schedule "ogni X" строго dopo `from`.
 * Con mode 'around' ogni occorrenza base è spostata di ±15 min deterministici
 * (seed = id routine + data): si parte dal giorno di `from - 15 min` perché
 * l'occorrenza di ieri/giù può avere un jitter che la proietta nel futuro.
 */
export function nextEveryRun(routineId: number, spec: EveryScheduleSpec, from: number, zone: string): number | null {
  const at = spec.at !== undefined ? parseHm(spec.at) : null
  if (spec.at !== undefined && !at) return null // at malformato: mai in esecuzione (la creazione lo rifiuta)
  const hour = at?.h ?? 0
  const minute = at?.m ?? 0

  // ogni ora al minuto `minute`: candiati ore intere, giorni a seguire
  if (spec.every === 'hour') {
    const jitterBase = spec.mode === 'around' ? AROUND_MAX_MIN * 60_000 : 0
    let t = from - jitterBase
    for (let guard = 0; guard < 800; guard++) {
      const p = tzParts(t, zone)
      const seed = aroundSeed(routineId, p.year, p.month, p.day)
      const jitter = spec.mode === 'around' ? aroundJitterMinutes(seed) * 60_000 : 0
      for (let h = p.hour; h <= 23; h++) {
        const base = wallToEpoch(p.year, p.month, p.day, h, minute, zone)
        if (base !== null && base + jitter > from) return base + jitter
      }
      t += DAY_MS
      // dal giorno dopo si riparte dall'ora 0
      const np = tzParts(t, zone)
      t = wallToEpoch(np.year, np.month, np.day, 0, 0, zone) ?? t
    }
    return null
  }

  const jitterBase = spec.mode === 'around' ? AROUND_MAX_MIN * 60_000 : 0
  const start = tzParts(from - jitterBase, zone)
  let day = Date.UTC(start.year, start.month - 1, start.day)
  for (let guard = 0; guard < 800; guard++) {
    const dc = new Date(day)
    const y = dc.getUTCFullYear()
    const mo = dc.getUTCMonth() + 1
    const d = dc.getUTCDate()
    if (dayMatchesEvery(spec, d, dc.getUTCDay())) {
      const base = wallToEpoch(y, mo, d, hour, minute, zone)
      if (base !== null) {
        const jitter = spec.mode === 'around' ? aroundJitterMinutes(aroundSeed(routineId, y, mo, d)) * 60_000 : 0
        if (base + jitter > from) return base + jitter
      }
    }
    day += DAY_MS
  }
  return null
}

/**
 * Prossimo run pianificato di una routine (schedule): trigger schedule (cron
 * o every) oppure la colonna schedule legacy per le routine pre-fase 6.
 * null se non pianificabile. I trigger a evento (webhook, presence_return,
 * connector_poll) non hanno run pianificati: tornano null.
 */
export function nextScheduleRun(r: RoutineTiming, from: number): number | null {
  const zone = routineTimeZone(r.timezone)
  const t = r.trigger
  if (!t || t.type !== 'schedule') return nextCronRun(r.schedule, from, zone)
  if (t.kind === 'cron') return nextCronRun(t.cron, from, zone)
  return nextEveryRun(r.id, t, from, zone)
}

/** Prossimo poll di un trigger connector_poll: ultimo poll (o creazione) + intervallo. */
export function nextPollAt(lastPoll: number | null, createdAt: number, intervalMin: number): number {
  return (lastPoll ?? createdAt) + intervalMin * 60_000
}
