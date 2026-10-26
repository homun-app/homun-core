// Calcolo del prossimo run per le routine: cron a 5 campi (con secondi
// opzionali a 6 campi, come node-cron) valutato nel fuso orario locale.
// Le routine smettono di usare node-cron in-process: lo scheduler chiama
// nextCronRun per calcolare il run_at dei job nella coda durevole.
// Funzioni pure: stesso input → stesso output, nessun accesso a timer o rete.

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
function dayMatches(f: CronFields, d: Date): boolean {
  const dom = f.daysOfMonth.has(d.getDate())
  const dow = f.daysOfWeek.has(d.getDay())
  return f.domRestricted && f.dowRestricted ? dom || dow : dom && dow
}

/**
 * Prossima esecuzione strettamente successiva a `from` (ms epoch), in fuso
 * orario locale. Avanza campo per campo (mese → giorno → ora → minuto →
 * secondo) invece di scandire ogni minuto; null se l'espressione non ha mai
 * match (es. 30 febbraio) o non è valida.
 */
export function nextCronRun(expr: string, from: number): number | null {
  const f = parseCron(expr)
  if (!f) return null
  const start = new Date(from)
  const d = f.seconds
    ? new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes(), start.getSeconds() + 1)
    : new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes() + 1, 0)
  for (let guard = 0; guard < 10_000; guard++) {
    if (!f.months.has(d.getMonth() + 1)) {
      let y = d.getFullYear()
      let m = d.getMonth() + 1 // 1-12
      do {
        m++
        if (m > 12) { m = 1; y++ }
      } while (!f.months.has(m))
      d.setFullYear(y, m - 1, 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(f, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!f.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!f.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
      continue
    }
    if (f.seconds && !f.seconds.has(d.getSeconds())) {
      d.setSeconds(d.getSeconds() + 1, 0)
      continue
    }
    return d.getTime()
  }
  return null
}
