// U4 (fase pulizia · ritocchi, sostituisce P10): l'ora del messaggio, stabile
// per la cache. La REGOLA è fissa nel system prompt; il DATO è l'ora di invio
// di ogni messaggio utente, dal createdAt già salvato dell'entry — lo stesso
// messaggio dà SEMPRE lo stesso testo, a ogni turno, quindi il prefisso della
// conversazione resta identico e la cache del provider tiene. Qui la funzione
// pura formatSentStamp(ms, timeZone): «[Sent: Friday, 2026-11-06 15:30
// (Europe/Rome)]». L'invariante d'integrazione (stabilità del prefisso, mai
// nella storia né in chat) sta nei test di history e del loop.
import { describe, expect, it } from 'vitest'
import { formatSentStamp, systemTimeZone } from '../current-time'

const FRI_1430Z = Date.UTC(2026, 10, 6, 14, 30)

describe('U4 — formatSentStamp (pura)', () => {
  it('data e fuso fissi: giorno, data, ora locale e il fuso IANA', () => {
    expect(formatSentStamp(FRI_1430Z, 'Europe/Rome')).toBe('[Sent: Friday, 2026-11-06 15:30 (Europe/Rome)]')
    expect(formatSentStamp(FRI_1430Z, 'UTC')).toBe('[Sent: Friday, 2026-11-06 14:30 (UTC)]')
  })

  it('il fuso decide anche il GIORNO (Pacific/Auckland, UTC+13 a novembre)', () => {
    expect(formatSentStamp(FRI_1430Z, 'Pacific/Auckland')).toBe('[Sent: Saturday, 2026-11-07 03:30 (Pacific/Auckland)]')
  })

  it('mezzanotte: 00:05, mai 24:05', () => {
    expect(formatSentStamp(Date.UTC(2026, 10, 6, 23, 5), 'Europe/Rome')).toBe('[Sent: Saturday, 2026-11-07 00:05 (Europe/Rome)]')
  })

  it('fuso NON valido, vuoto o assente: UTC (e il fuso sbagliato non compare)', () => {
    expect(formatSentStamp(FRI_1430Z, 'Non/Fuso!')).toBe('[Sent: Friday, 2026-11-06 14:30 (UTC)]')
    expect(formatSentStamp(FRI_1430Z, '')).toBe('[Sent: Friday, 2026-11-06 14:30 (UTC)]')
    expect(formatSentStamp(FRI_1430Z, null)).toBe('[Sent: Friday, 2026-11-06 14:30 (UTC)]')
    expect(formatSentStamp(FRI_1430Z, undefined)).toBe('[Sent: Friday, 2026-11-06 14:30 (UTC)]')
  })

  it('cambio d\'ora legale (Europe/Rome, 29 marzo 2026): 01:30 prima, 03:30 un\'ora dopo', () => {
    // alle 01:00 UTC le 02:00 ora solare diventano le 03:00 ora legale
    expect(formatSentStamp(Date.UTC(2026, 2, 29, 0, 30), 'Europe/Rome')).toBe('[Sent: Sunday, 2026-03-29 01:30 (Europe/Rome)]')
    expect(formatSentStamp(Date.UTC(2026, 2, 29, 1, 30), 'Europe/Rome')).toBe('[Sent: Sunday, 2026-03-29 03:30 (Europe/Rome)]')
  })

  it('ritorno all\'ora solare (Europe/Rome, 25 ottobre 2026): l\'ora locale dei due lati', () => {
    // alle 01:00 UTC le 03:00 ora legale tornano le 02:00 ora solare
    expect(formatSentStamp(Date.UTC(2026, 9, 25, 0, 30), 'Europe/Rome')).toBe('[Sent: Sunday, 2026-10-25 02:30 (Europe/Rome)]')
    expect(formatSentStamp(Date.UTC(2026, 9, 25, 2, 30), 'Europe/Rome')).toBe('[Sent: Sunday, 2026-10-25 03:30 (Europe/Rome)]')
  })

  it('pura e stabile: lo stesso istante dà SEMPRE lo stesso testo, su una riga sola', () => {
    const a = formatSentStamp(FRI_1430Z, 'Europe/Rome')
    const b = formatSentStamp(FRI_1430Z, 'Europe/Rome')
    expect(a).toBe(b)
    expect(a).not.toContain('\n')
  })

  it('systemTimeZone: un fuso IANA valido (o UTC)', () => {
    const tz = systemTimeZone()
    expect(tz.length).toBeGreaterThan(0)
    // un fuso IANA si usa senza che Intl protesti; UTC è il ripiego
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow()
  })
})
