// Descrizione in linguaggio naturale di un'espressione cron a 5 campi, per
// le card di approvazione di update_state ("l'utente vede nome, schedule in
// linguaggio naturale e prompt"). Modulo PURO condiviso (main e renderer):
// copre le forme comuni, ripiega sull'espressione grezza per le altre.
// Fase 6: describeEverySchedule e describeTrigger estendono la descrizione ai
// nuovi tipi di trigger (schedule "ogni X", email, calendar_event, webhook,
// poll, presence_return).

import type { EveryScheduleSpec, RoutineTrigger } from './types'

const DOW_IT = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato']
const DOW_SHORT: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function fields(expr: string): string[] | null {
  const f = expr.trim().split(/\s+/)
  return f.length === 5 ? f : null
}

/** Espande un campo cron in lista di numeri; null se non è un elenco semplice. */
function numbers(field: string, min: number, max: number, names?: Record<string, number>): number[] | null {
  if (field === '*') return null
  const out: number[] = []
  for (const part of field.split(',')) {
    const [range, step] = part.split('/')
    const stepN = step === undefined ? 1 : Number(step)
    if (!Number.isInteger(stepN) || stepN < 1) return null
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min; hi = max
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-')
      lo = names?.[a!.toLowerCase()] ?? Number(a)
      hi = names?.[b!.toLowerCase()] ?? Number(b)
    } else {
      lo = names?.[range!.toLowerCase()] ?? Number(range)
      hi = step === undefined ? lo : max
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += stepN) out.push(v)
  }
  return out
}

const hhmm = (h: number, m: number): string => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

function atTimes(hours: number[], minutes: number[]): string {
  const times = hours.map((h) => hhmm(h, minutes[0] ?? 0)).slice(0, 3)
  const extra = hours.length > 3 ? ` (+${hours.length - 3} orari)` : ''
  return times.length > 1 ? `alle ${times.join(', ')}` + extra : `alle ${times[0] ?? '00:00'}`
}

/** Descrizione italiana dell'espressione (forma grezza come ripiego). */
export function describeCron(expr: string): string {
  const f = fields(expr)
  if (!f) return `cron "${expr}"`
  const [minF, hourF, domF, monF, dowF] = f as [string, string, string, string, string]

  // ogni minuto / ogni N minuti (qualsiasi resto)
  const everyMin = numbers(minF, 0, 59)
  if (minF.startsWith('*/') && hourF === '*' && domF === '*' && monF === '*' && dowF === '*') {
    return `ogni ${minF.slice(2)} minuti`
  }
  if (minF === '*' && hourF === '*' && domF === '*' && monF === '*' && dowF === '*') return 'ogni minuto'
  if (hourF.startsWith('*/') && domF === '*' && monF === '*' && dowF === '*') {
    const m = everyMin?.length === 1 ? everyMin[0]! : 0
    return `ogni ${hourF.slice(2)} ore${m ? ` al minuto ${m}` : ''}`
  }

  const hours = hourF === '*' ? null : numbers(hourF, 0, 23)
  const minutes = everyMin?.length ? everyMin : [0]
  const dow = dowF === '*' ? null : numbers(dowF, 0, 7, DOW_SHORT)?.map((d) => (d === 7 ? 0 : d))
  const dom = domF === '*' ? null : numbers(domF, 1, 31)
  const mon = monF === '*' ? null : numbers(monF, 1, 12)
  if (hours === null || hours.length === 0) return `cron "${expr}"` // troppo irregolare: forma grezza

  let when: string
  if (dow?.length === 5 && [1, 2, 3, 4, 5].every((d) => dow.includes(d))) when = 'nei giorni feriali'
  else if (dow?.length === 2 && dow.includes(0) && dow.includes(6)) when = 'nel weekend'
  else if (dow?.length && !dom) when = dow.length === 1 ? `il ${DOW_IT[dow[0]!]}` : `il ${dow.map((d) => DOW_IT[d]).join(', ')}`
  else if (dom?.length === 1 && !dow) when = `il giorno ${dom[0]} del mese`
  else if (dom && dow) when = `il giorno ${dom.join(', ')} del mese (${dow.map((d) => DOW_IT[d]).join(', ')})`
  else if (mon?.length) when = `il ${mon.join('/')} di ogni mese`
  else when = 'tutti i giorni'

  return `${when} ${atTimes(hours, minutes)}`
}

/** L'orario di uno schedule "ogni X": "alle 09:00" / "verso le 09:00" (around = ±15 min). */
function everyAt(at: string | undefined, mode: 'at' | 'around'): string {
  const t = at ?? '00:00'
  return mode === 'around' ? `verso le ${t} (±15 min)` : `alle ${t}`
}

/** Descrizione italiana di uno schedule "ogni X" (fase 6). */
export function describeEverySchedule(s: EveryScheduleSpec): string {
  if (s.every === 'hour') return `ogni ora al minuto ${(s.at ?? '00:00').split(':')[1] ?? '00'}`
  const at = everyAt(s.at, s.mode)
  switch (s.every) {
    case 'day': return `ogni giorno ${at}`
    case 'weekday': return `nei giorni feriali ${at}`
    case 'week': return `ogni settimana il ${DOW_IT[s.weekday ?? 1]} ${at}`
    case 'month': return `il giorno ${s.monthDay ?? 1} di ogni mese ${at}`
  }
}

/**
 * Descrizione italiana di un trigger di routine (fase 6). `legacySchedule` è
 * l'espressione cron della colonna schedule, usata quando il trigger è assente.
 */
export function describeTrigger(t: RoutineTrigger | null | undefined, legacySchedule?: string): string {
  if (!t) return describeCron(legacySchedule ?? '* * * * *')
  if (t.type === 'schedule') return t.kind === 'cron' ? describeCron(t.cron) : describeEverySchedule(t)
  if (t.type === 'webhook') return 'quando riceve una chiamata webhook'
  if (t.type === 'presence_return') return 'quando torni al computer dopo un\'assenza'
  const q = typeof t.args?.query === 'string' ? ` che corrisponde a "${t.args.query}"` : ''
  if (t.preset === 'email') return `quando arriva un'email${q}`
  if (t.preset === 'calendar_event') return `${t.offsetMinutes ?? 0} minuti prima di ogni evento del calendario`
  return `quando il tool ${t.tool} del connettore ${t.connectorId} vede un nuovo elemento (${t.idField})`
}
