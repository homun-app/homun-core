// P10 (fase pulizia): la data e l'ora nel turno. Il modello non ha orologio:
// senza un'ancora esplicita deduce «oggi» dall'addestramento o dai timestamp
// che capitano nella conversazione, e ragiona su scadenze e routine da una
// data vecchia. Come Rakazo (packages/adapters/src/current-time.ts, Apache
// 2.0 — adattamento, vedi THIRD_PARTY_NOTICES.md), ogni turno dichiara il
// presente REALE sul messaggio utente che lo apre; resta FUORI dal system
// prompt, che resterebbe diverso a ogni chiamata rompendo la cache.
//
// Col fuso IANA dell'utente guida l'ora locale («domani mattina», «stasera»
// significano ciò che l'utente intende), con l'istante UTC esatto accanto.
// Fuso sconosciuto o non valido: si ripiega su UTC, solo UTC.
//
// Modulo PURO: nessuna dipendenza, testabile in nodo puro.

/**
 * La riga (unica, senza a capo) con l'ora locale dell'utente nel fuso IANA,
 * il fuso e l'istante UTC, seguita dalle istruzioni di Rakazo: quel momento
 * è il presente, date assolute e non relative, mai dedurre la data
 * dall'addestramento.
 */
export function formatCurrentTimeInstruction(now: Date, timeZone?: string | null): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const local = timeZone ? localDateTime(now, timeZone) : undefined
  const anchor = local
    ? `Current date and time for the user: ${local} (${timeZone}). That is ${iso} (UTC).`
    : `Current date and time: ${weekdayIn(now, 'UTC')}, ${iso} (UTC).`
  return [
    anchor,
    'Treat this as the present moment for everything you say and do.',
    local
      ? "Use the user's time zone for times you mention unless they ask otherwise, judge what is past, upcoming, or overdue from it, and write absolute dates rather than relative ones."
      : 'Use it to judge what is past, upcoming, or overdue, convert it to the user\'s time zone when one is known, and write absolute dates rather than relative ones.',
    "Never infer today's date from your training data or from timestamps quoted in the conversation."
  ].join(' ')
}

function weekdayIn(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(now)
}

/** "Saturday, 2026-10-17 22:15 (UTC+13:00)", o undefined per un fuso inutilizzabile. */
export function localDateTime(now: Date, timeZone: string): string | undefined {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset'
    }).formatToParts(now)
  } catch {
    return undefined
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? ''
  // "GMT+13:00" / "GMT" da longOffset, mostrato come UTC per stare accanto all'istante
  const offset = part('timeZoneName').replace(/^GMT/, 'UTC') || 'UTC'
  return `${part('weekday')}, ${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} (${offset === 'UTC' ? 'UTC+00:00' : offset})`
}

/**
 * Il fuso del sistema: `Intl.DateTimeFormat().resolvedOptions().timeZone`,
 * con UTC quando manca o non è valido.
 */
export function systemTimeZone(): string {
  let tz = ''
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    tz = ''
  }
  if (!tz.trim()) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}
