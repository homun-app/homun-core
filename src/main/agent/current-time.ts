// U4 (fase pulizia · ritocchi, sostituisce P10): l'ora di invio di un
// messaggio utente, per il modello. Il modello non ha orologio: ogni
// messaggio utente che gli arriva comincia con l'ora in cui è stato mandato,
// nel fuso dell'utente — calcolata dal createdAt GIÀ salvato dell'entry
// (history.ts), quindi lo stesso messaggio dà SEMPRE lo stesso testo e il
// prefisso della conversazione resta identico fra un turno e l'altro: la
// cache del provider tiene. La regola che spiega il timbro sta FISSA nel
// system prompt (prompts.ts, SENT_TIME_RULE). Il timbro non entra mai nella
// storia salvata né in chat: esiste solo nel contenuto per il modello.
//
// La resa di giorno, data e ora nel fuso IANA (formatToParts, ripiego su
// UTC) viene dall'adattamento di Rakazo di P10 (packages/adapters/src/
// current-time.ts, Apache 2.0 — vedi THIRD_PARTY_NOTICES.md).
//
// Modulo PURO: nessuna dipendenza, testabile in nodo puro.

/** Il fuso se Intl lo accetta, altrimenti null. */
function usableTimeZone(timeZone: string | null | undefined): string | null {
  if (!timeZone?.trim()) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return null
  }
}

/**
 * «[Sent: Friday, 2026-11-06 15:30 (Europe/Rome)]»: giorno, data e ora
 * locali nel fuso IANA, col nome del fuso. Fuso non valido o assente: UTC.
 */
export function formatSentStamp(ms: number, timeZone?: string | null): string {
  const zone = usableTimeZone(timeZone) ?? 'UTC'
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(ms))
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? ''
  return `[Sent: ${part('weekday')}, ${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} (${zone})]`
}

/** Il contenuto per il modello: il timbro all'inizio, una riga vuota, il testo. */
export function withSentStamp(text: string, ms: number, timeZone?: string | null): string {
  return `${formatSentStamp(ms, timeZone)}\n\n${text}`
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
  return usableTimeZone(tz) ?? 'UTC'
}
