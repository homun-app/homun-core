// Calcolo del prossimo run per le routine: cron a 5 campi (con secondi
// opzionali a 6 campi, come node-cron).
// Le routine smettono di usare node-cron in-process: lo scheduler chiama
// nextCronRun per calcolare il run_at dei job nella coda durevole.
// Fase 6: il calcolo rispetta il fuso orario della routine (parametro tz,
// default il fuso locale del processo) — l'iterazione avviene sull'orologio
// da parete del fuso (tz.ts), quindi l'ora legale è gestita da Intl.
// Funzioni pure: stesso input → stesso output, nessun accesso a timer o rete.
import { tzParts, wallToEpoch, localTimeZone } from './tz'

export interface CronFields {
  /** null = espressione a 5 campi (granularità al minuto) */
  seconds: Set<number> | null
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number> // 1-12
  daysOfWeek: Set<number> // 0-6, 0 = domenica
  /** campo dom ristretto (non '*') — per la semantica OR dom/dow del cron standard */
  domRestricted: boolean
  dowRestricted: boolean
}

const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const MONTH_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

function parseValue(s: string, names: Record<string, number> | null, max: number): number | null {
  const n = Number(s)
  if (Number.isInteger(n)) return n >= 0 && n <= max ? n : null
  if (names) {
    const v = names[s.toLowerCase()]
    if (v !== undefined) return v
  }
  return null
}

/** Parsifica un campo cron: '*', 'step' su stella, 'a', 'a-b', range con step, liste. null se invalido. */
function parseField(s: string, min: number, max: number, names: Record<string, number> | null): Set<number> | null {
  const out = new Set<number>()
  for (const part of s.split(',')) {
    if (!part) return null
    const [rangePart, stepPart] = part.split('/')
    if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || Number(stepPart) < 1)) return null
    const step = stepPart === undefined ? 1 : Number(stepPart)
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = min; hi = max
    } else if (rangePart.includes('-')) {
      const pieces = rangePart.split('-')
      if (pieces.length !== 2) return null
      lo = parseValue(pieces[0]!, names, max) ?? -1
      hi = parseValue(pieces[1]!, names, max) ?? -1
      if (lo < 0 || hi < 0 || lo > hi) return null
    } else {
      const v = parseValue(rangePart, names, max)
      if (v === null) return null
      lo = v
      // "5/15" nel cron standard: dal 5 alla fine del campo, passo 15
      hi = stepPart !== undefined ? max : v
    }
    if (lo < min || hi > max) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size ? out : null
}

/** Parsifica un'espressione cron completa; null se invalida. */
export function parseCron(expr: string): CronFields | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5 && fields.length !== 6) return null
  const rest = fields.length === 6 ? fields.slice(1) : fields
  const seconds = fields.length === 6 ? parseField(fields[0]!, 0, 59, null) : null
  if (fields.length === 6 && !seconds) return null
  const minutes = parseField(rest[0]!, 0, 59, null)
  const hours = parseField(rest[1]!, 0, 23, null)
  const daysOfMonth = parseField(rest[2]!, 1, 31, null)
  const months = parseField(rest[3]!, 1, 12, MONTH_NAMES)
  // dow accetta 0-7 (7 = domenica, normalizzato a 0)
  const dowRaw = parseField(rest[4]!, 0, 7, DOW_NAMES)
  if (!minutes || !hours || !daysOfMonth || !months || !dowRaw) return null
  const daysOfWeek = new Set(dowRaw)
  if (daysOfWeek.delete(7)) daysOfWeek.add(0)
  return {
    seconds,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: rest[2] !== '*',
    dowRestricted: rest[4] !== '*'
  }
}

/** Confronto del giorno con la semantica OR del cron standard (dom e dow entrambi ristretti). */
function dayMatches(f: CronFields, dom: number, dow: number): boolean {
  const dm = f.daysOfMonth.has(dom)
  const dw = f.daysOfWeek.has(dow)
  return f.domRestricted && f.dowRestricted ? dm || dw : dm && dw
}

/**
 * Prossima esecuzione strettamente successiva a `from` (ms epoch), nel fuso
 * orario `tz` (default: fuso locale del processo). Itera sui giorni
 * dell'orologio da parete del fuso e converte solo i candidati orario:minuto
 * che matchano; null se l'espressione non è valida o non ha mai match
 * (es. 30 febbraio). Le ore inesistenti per l'ora legale vengono saltate.
 */
export function nextCronRun(expr: string, from: number, tz?: string): number | null {
  const f = parseCron(expr)
  if (!f) return null
  const zone = tz ?? localTimeZone()
  // partenza: minuto (o secondo) successivo a from
  const t0 = f.seconds
    ? Math.floor(from / 1000) * 1000 + 1000
    : Math.floor(from / 60_000) * 60_000 + 60_000
  const p0 = tzParts(t0, zone)
  // giorno corrente dell'orologio da parete (iterato in UTC, indipendente dal fuso)
  let day = Date.UTC(p0.year, p0.month - 1, p0.day)
  const hours = [...f.hours].sort((a, b) => a - b)
  const minutes = [...f.minutes].sort((a, b) => a - b)
  const seconds = f.seconds ? [...f.seconds].sort((a, b) => a - b) : [0]
  for (let guard = 0; guard < 10_000; guard++) {
    const dc = new Date(day)
    const y = dc.getUTCFullYear()
    const mo = dc.getUTCMonth() + 1
    const d = dc.getUTCDate()
    if (!f.months.has(mo)) {
      // salta al primo giorno del mese successivo (dell'orologio da parete)
      day = Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1)
      continue
    }
    if (!dayMatches(f, d, dc.getUTCDay())) {
      day += 86_400_000
      continue
    }
    for (const h of hours) {
      for (const mi of minutes) {
        for (const s of seconds) {
          const epoch = wallToEpoch(y, mo, d, h, mi, zone, s)
          if (epoch !== null && epoch > from) return epoch
        }
      }
    }
    day += 86_400_000
  }
  return null
}
