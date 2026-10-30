// Descrizione in linguaggio naturale di un'espressione cron a 5 campi, per
// le card di approvazione di update_state ("l'utente vede nome, schedule in
// linguaggio naturale e prompt"). Modulo PURO condiviso (main e renderer):
// copre le forme comuni, ripiega sull'espressione grezza per le altre.
// Fase 6: describeEverySchedule e describeTrigger estendono la descrizione ai
// nuovi tipi di trigger (schedule "ogni X", email, calendar_event, webhook,
// poll, presence_return).
// Fase 17c (C6): la lingua è un argomento (default 'it', la lingua storica
// delle card); i nomi dei giorni arrivano da Intl.DateTimeFormat (niente
// tabelle a mano) e le frasi fisse sono id del catalogo UI
// (src/shared/ui-messages.ts), formattati con l'istanza i18n propria di
// shared/ui-text.ts — funziona nel daemon, nel main e nel renderer.

import type { EveryScheduleSpec, RoutineTrigger } from './types'
import type { UiLanguage } from './ui-language'
import { UI } from './ui-messages'
import { formatUi, ui, type UiMessageDescriptor } from './ui-text'
import type { UiLanguage as Lang } from './ui-language'

/** formato rapido: messaggio del catalogo + valori → testo nella lingua. */
const fmt = (m: UiMessageDescriptor, lang: Lang, values?: Record<string, string | number>): string =>
  formatUi(ui(m, values), lang)

const DOW_SHORT: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

/** Il locale Intl della lingua (le date inglesi seguono il glossario: en-GB). */
function localeOf(lang: UiLanguage): string {
  return lang === 'en' ? 'en-GB' : 'it-IT'
}

/**
 * Il nome del giorno della settimana nella lingua richiesta, da Intl (2024-01-07
 * era una domenica: la data fissa dà il nome lungo senza tabelle a mano).
 */
function dowName(dow: number, lang: UiLanguage): string {
  const d = new Date(Date.UTC(2024, 0, 7 + dow))
  return new Intl.DateTimeFormat(localeOf(lang), { weekday: 'long', timeZone: 'UTC' }).format(d)
}

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

function atTimes(hours: number[], minutes: number[], lang: UiLanguage): string {
  const times = hours.map((h) => hhmm(h, minutes[0] ?? 0)).slice(0, 3)
  if (times.length > 1) {
    return fmt(UI.cronAtTimes, lang, {
      times: times.join(', '),
      extra: hours.length > 3 ? 'yes' : 'no',
      ...(hours.length > 3 ? { more: hours.length - 3 } : {})
    })
  }
  return fmt(UI.cronAtTime, lang, { time: times[0] ?? '00:00' })
}

/** Descrizione dell'espressione nella lingua richiesta (forma grezza come ripiego). */
export function describeCron(expr: string, lang: UiLanguage = 'it'): string {
  const f = fields(expr)
  if (!f) return fmt(UI.cronRaw, lang, { expr })
  const [minF, hourF, domF, monF, dowF] = f as [string, string, string, string, string]

  // ogni minuto / ogni N minuti (qualsiasi resto)
  const everyMin = numbers(minF, 0, 59)
  if (minF.startsWith('*/') && hourF === '*' && domF === '*' && monF === '*' && dowF === '*') {
    return fmt(UI.cronEveryNMinutes, lang, { n: minF.slice(2) })
  }
  if (minF === '*' && hourF === '*' && domF === '*' && monF === '*' && dowF === '*') return fmt(UI.cronEveryMinute, lang, {})
  if (hourF.startsWith('*/') && domF === '*' && monF === '*' && dowF === '*') {
    const m = everyMin?.length === 1 ? everyMin[0]! : 0
    return fmt(UI.cronEveryNHours, lang, { n: hourF.slice(2), withMin: m ? 'yes' : 'no', ...(m ? { m } : {}) })
  }

  const hours = hourF === '*' ? null : numbers(hourF, 0, 23)
  const minutes = everyMin?.length ? everyMin : [0]
  const dow = dowF === '*' ? null : numbers(dowF, 0, 7, DOW_SHORT)?.map((d) => (d === 7 ? 0 : d))
  const dom = domF === '*' ? null : numbers(domF, 1, 31)
  const mon = monF === '*' ? null : numbers(monF, 1, 12)
  if (hours === null || hours.length === 0) return fmt(UI.cronRaw, lang, { expr }) // troppo irregolare: forma grezza

  let when: string
  if (dow?.length === 5 && [1, 2, 3, 4, 5].every((d) => dow.includes(d))) when = fmt(UI.cronWeekdays, lang, {})
  else if (dow?.length === 2 && dow.includes(0) && dow.includes(6)) when = fmt(UI.cronWeekend, lang, {})
  else if (dow?.length && !dom) {
    when = fmt(UI.cronOnDays, lang, { days: dow.map((d) => dowName(d, lang)).join(', ') })
  } else if (dom?.length === 1 && !dow) when = fmt(UI.cronDayOfMonth, lang, { days: dom[0]! })
  else if (dom && dow) {
    when = fmt(UI.cronDayOfMonthDow, lang, {
      days: dom.join(', '),
      dows: dow.map((d) => dowName(d, lang)).join(', ')
    })
  } else if (mon?.length) when = fmt(UI.cronMonthsOfYear, lang, { months: mon.join('/') })
  else when = fmt(UI.cronEveryDay, lang, {})

  return `${when} ${atTimes(hours, minutes, lang)}`
}

/** L'orario di uno schedule "ogni X": "alle 09:00" / "verso le 09:00" (around = ±15 min). */
function everyAt(at: string | undefined, mode: 'at' | 'around', lang: UiLanguage): string {
  const t = at ?? '00:00'
  return mode === 'around' ? fmt(UI.cronAroundTime, lang, { time: t }) : fmt(UI.cronAtTime, lang, { time: t })
}

/** Descrizione di uno schedule "ogni X" nella lingua richiesta (fase 6). */
export function describeEverySchedule(s: EveryScheduleSpec, lang: UiLanguage = 'it'): string {
  if (s.every === 'hour') return fmt(UI.cronEveryHourAt, lang, { min: (s.at ?? '00:00').split(':')[1] ?? '00' })
  const at = everyAt(s.at, s.mode, lang)
  switch (s.every) {
    case 'day': return fmt(UI.cronEveryDayAt, lang, { at })
    case 'weekday': return fmt(UI.cronWeekdayAt, lang, { at })
    case 'week': return fmt(UI.cronWeeklyAt, lang, { day: dowName(s.weekday ?? 1, lang), at })
    case 'month': return fmt(UI.cronMonthlyAt, lang, { day: s.monthDay ?? 1, at })
  }
}

/**
 * Descrizione di un trigger di routine nella lingua richiesta (fase 6).
 * `legacySchedule` è l'espressione cron della colonna schedule, usata quando
 * il trigger è assente.
 */
export function describeTrigger(t: RoutineTrigger | null | undefined, legacySchedule?: string, lang: UiLanguage = 'it'): string {
  if (!t) return describeCron(legacySchedule ?? '* * * * *', lang)
  if (t.type === 'schedule') return t.kind === 'cron' ? describeCron(t.cron, lang) : describeEverySchedule(t, lang)
  if (t.type === 'webhook') return fmt(UI.triggerWebhook, lang, {})
  if (t.type === 'presence_return') return fmt(UI.triggerPresence, lang, {})
  const query = typeof t.args?.query === 'string' ? t.args.query : ''
  if (t.preset === 'email') {
    return fmt(UI.triggerEmail, lang, { withQuery: query ? 'yes' : 'no', ...(query ? { query } : {}) })
  }
  if (t.preset === 'calendar_event') return fmt(UI.triggerCalendar, lang, { minutes: t.offsetMinutes ?? 0 })
  return fmt(UI.triggerTool, lang, { tool: t.tool, connector: t.connectorId, field: t.idField })
}
