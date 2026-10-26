// Fusi orari con Intl (nessuna dipendenza nuova): conversioni tra epoch ms e
// orologio da parete di un fuso, corrette sui cambi dell'ora legale.
//
// - tzParts(t, tz): l'orologio da parete di `t` nel fuso (anno, mese, …)
// - wallToEpoch(y,m,d,h,mi,tz): l'epoch dell'orologio da parete dato. Alle
//   02:30 dell'ultima domenica di ottobre l'ora succede DUE volte: si prende
//   la PRIMA (standard per gli scheduler). Alle 02:30 dell'ultima domenica di
//   marzo NON esiste (ora saltata): torna null e l'occorrenza è saltata.
// - offsetMs(t, tz): offset del fuso da UTC all'istante t (dst incluso).
//
// Funzioni pure: nessun timer, nessun I/O — nei test il tempo è fintizio.

/** Parte dell'orologio da parete nel fuso (mese 1-12, giorno 1-31, dow 0-6 domenica). */
export interface TzParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  dow: number
}

/** Fuso locale del processo (default quando la routine non ne dichiara uno). */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

const partsCache = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, weekday: 'short'
    })
    partsCache.set(tz, f)
  }
  return f
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Fuso valido? (Intl throws sui nomi sconosciuti) */
export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

/** L'orologio da parete di `t` (epoch ms) nel fuso. */
export function tzParts(t: number, tz: string): TzParts {
  const p = formatter(tz).formatToParts(new Date(t))
  const get = (type: string): number => Number(p.find((x) => x.type === type)?.value ?? '0')
  // hour '24' appare con hour12:false su alcuni runtime: normalizzato a 0
  const hour = get('hour') % 24
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
    dow: DOW[p.find((x) => x.type === 'weekday')?.value ?? ''] ?? 0
  }
}

/** Offset del fuso da UTC all'istante t (ms, ora legale inclusa). */
export function offsetMs(t: number, tz: string): number {
  const p = tzParts(t, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(t / 1000) * 1000
}

/**
 * Epoch dell'orologio da parete (y,m,d,h,mi[,s]) nel fuso.
 * - ora AMBIGUA (due passaggi, fine ora legale): PRIMA occorrenza
 * - ora INESISTENTE (ora saltata, inizio ora legale): null
 */
export function wallToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
  second = 0
): number | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const off1 = offsetMs(guess, tz)
  const t1 = guess - off1
  const off2 = offsetMs(t1, tz)
  if (off1 === off2) return t1
  // gli offset divergono: o l'ora è nel buco (saltata) o è ambigua
  const t2 = guess - off2
  const same = (t: number): boolean => {
    const p = tzParts(t, tz)
    return p.hour === hour && p.minute === minute && (second === 0 || p.second === second)
  }
  if (same(t1)) return t1 // prima occorrenza valida
  if (same(t2)) return t2 // la seconda
  return null // nel buco: l'orologio da parete non esiste in quel fuso
}

/** 'HH:MM' → {h, m}; null se malformato. */
export function parseHm(hm: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h > 23 || mm > 59) return null
  return { h, m: mm }
}
