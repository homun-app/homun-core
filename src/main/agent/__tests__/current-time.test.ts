// P10 (fase pulizia): la data e l'ora nel turno — il modello non ha orologio.
// La funzione pura formatCurrentTimeInstruction (come Rakazo
// current-time.ts, Apache 2.0): ora locale dell'utente col fuso IANA,
// l'istante UTC accanto, e le istruzioni (presente, date assolute, mai
// dedurre la data dall'addestramento). L'invariante d'integrazione sta nei
// test del loop: la riga entra nel contenuto per il modello (ultimo
// messaggio utente del turno), NON nel system prompt (cache), NON nella
// storia salvata né in chat.
import { describe, expect, it } from 'vitest'
import { formatCurrentTimeInstruction, systemTimeZone } from '../current-time'

describe('P10 — formatCurrentTimeInstruction (pura)', () => {
  it('fuso valido: ora locale dell’utente, fuso IANA e istante UTC, poi le istruzioni', () => {
    const out = formatCurrentTimeInstruction(new Date('2026-11-06T14:30:00Z'), 'Europe/Rome')
    expect(out.startsWith(
      'Current date and time for the user: Friday, 2026-11-06 15:30 (UTC+01:00) (Europe/Rome). That is 2026-11-06T14:30:00Z (UTC).'
    )).toBe(true)
    expect(out).toContain('Treat this as the present moment for everything you say and do.')
    expect(out).toContain("Use the user's time zone for times you mention unless they ask otherwise, judge what is past, upcoming, or overdue from it, and write absolute dates rather than relative ones.")
    expect(out).toContain('Never infer today\'s date from your training data or from timestamps quoted in the conversation.')
  })

  it('fuso con ora legale (Pacific/Auckland, UTC+13 a novembre): offset giusto e giorno dopo', () => {
    const out = formatCurrentTimeInstruction(new Date('2026-11-06T14:30:00Z'), 'Pacific/Auckland')
    expect(out).toContain('Current date and time for the user: Saturday, 2026-11-07 03:30 (UTC+13:00) (Pacific/Auckland). That is 2026-11-06T14:30:00Z (UTC).')
  })

  it('UTC esplicito: offset UTC+00:00', () => {
    const out = formatCurrentTimeInstruction(new Date('2026-11-06T14:30:00Z'), 'UTC')
    expect(out).toContain('Current date and time for the user: Friday, 2026-11-06 14:30 (UTC+00:00) (UTC). That is 2026-11-06T14:30:00Z (UTC).')
  })

  it('fuso NON valido: ripiega su UTC, senza il fuso sbagliato nel testo', () => {
    const out = formatCurrentTimeInstruction(new Date('2026-11-06T14:30:00Z'), 'Non/Fuso!')
    expect(out).toContain('Current date and time: Friday, 2026-11-06T14:30:00Z (UTC).')
    expect(out).not.toContain('Non/Fuso')
    expect(out).toContain('Never infer today\'s date from your training data')
  })

  it('fuso nullo o assente: come non valido (UTC)', () => {
    expect(formatCurrentTimeInstruction(new Date('2026-11-06T14:30:00Z'), null)).toBe(
      formatCurrentTimeInstruction(new Date('2026-11-06T14:30:00Z'), undefined)
    )
  })

  it('la riga è UNA riga sola: nessun a capo nel messaggio', () => {
    expect(formatCurrentTimeInstruction(new Date('2026-11-06T14:30:00Z'), 'Europe/Rome')).not.toContain('\n')
  })

  it('systemTimeZone: un fuso IANA valido (o UTC)', () => {
    const tz = systemTimeZone()
    expect(tz.length).toBeGreaterThan(0)
    // un fuso IANA si usa senza che Intl protesti; UTC è il ripiego
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow()
  })
})
