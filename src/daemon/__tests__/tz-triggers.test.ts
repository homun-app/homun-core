// Test del calcolo del prossimo run per i trigger (fase 6): fuso orario con
// ora legale (Europe/Rome, ultima domenica di marzo e di ottobre), schedule
// "ogni X" con mode 'at'/'around' (variazione ±15 min DETERMINISTICA per
// routine + data), orari inesistenti saltati e ambigui risolti alla prima
// occorrenza. Tutto puro: nessun timer, il tempo entra solo da `from`.
import { describe, expect, it } from 'vitest'
import { tzParts, wallToEpoch, parseHm } from '../tz'
import { nextCronRun } from '../cron'
import { nextEveryRun, nextScheduleRun, routineTimeZone, nextPollAt } from '../triggers'
import { aroundJitterMinutes } from '../../shared/triggers'

// Europe/Rome 2026: ora legale dal 29/3 (02:00 → 03:00) al 25/10 (03:00 → 02:00)
const ROME = 'Europe/Rome'

describe('tz: orologio da parete e conversioni', () => {
  it('tzParts legge l\'ora locale del fuso (non quella del processo)', () => {
    // 2026-03-29 00:30 UTC = 01:30 a Roma (ancora CET, l'STL è alle 02:00 locali)
    expect(tzParts(Date.UTC(2026, 2, 29, 0, 30), ROME)).toMatchObject({ hour: 1, minute: 30, day: 29 })
    // 2026-03-29 01:30 UTC = 03:30 a Roma (ora saltata alle 2, ora è CEST)
    expect(tzParts(Date.UTC(2026, 2, 29, 1, 30), ROME)).toMatchObject({ hour: 3, minute: 30 })
  })

  it('wallToEpoch: 02:30 del 29 marzo 2026 non esiste (ora saltata) → null', () => {
    expect(wallToEpoch(2026, 3, 29, 2, 30, ROME)).toBeNull()
  })

  it('wallToEpoch: 02:30 del 25 ottobre 2026 esiste DUE volte → prima occorrenza (CET dopo il cambio... la prima è ancora CEST)', () => {
    const t = wallToEpoch(2026, 10, 25, 2, 30, ROME)!
    expect(t).not.toBeNull()
    // prima occorrenza: 02:30 CEST = 00:30 UTC
    expect(t).toBe(Date.UTC(2026, 9, 25, 0, 30))
  })

  it('parseHm accetta HH:MM validi e rifiuta il resto', () => {
    expect(parseHm('09:30')).toEqual({ h: 9, m: 30 })
    expect(parseHm('23:59')).toEqual({ h: 23, m: 59 })
    expect(parseHm('24:00')).toBeNull()
    expect(parseHm('9:5')).toBeNull()
    expect(parseHm('abc')).toBeNull()
  })
})

describe('nextCronRun con fuso orario (Europe/Rome)', () => {
  it('cron 09:00 di ogni giorno: il prossimo run da un istante qualsiasi è le 9 di Roma', () => {
    // 2026-07-10 20:00 UTC = 22:00 a Roma → prossimo 9:00 l'11 luglio (07:00 UTC, CEST)
    const from = Date.UTC(2026, 6, 10, 20, 0)
    expect(nextCronRun('0 9 * * *', from, ROME)).toBe(Date.UTC(2026, 6, 11, 7, 0))
  })

  it('attraversa l\'inizio dell\'ora legale: il run delle 09:00 resta alle 09:00 locali', () => {
    // dalla vigilia del cambio (28/3, CET) al giorno dopo (29/3, CEST)
    const from = Date.UTC(2026, 2, 28, 12, 0)
    expect(nextCronRun('0 9 * * *', from, ROME)).toBe(Date.UTC(2026, 2, 29, 7, 0)) // 09:00 CEST
    const after = Date.UTC(2026, 2, 29, 8, 0) // 10:00 a Roma
    expect(nextCronRun('0 9 * * *', after, ROME)).toBe(Date.UTC(2026, 2, 30, 7, 0))
  })

  it('attraversa la fine dell\'ora legale (25/10/2026): le 09:00 restano le 09:00 locali', () => {
    const from = Date.UTC(2026, 9, 24, 20, 0)
    expect(nextCronRun('0 9 * * *', from, ROME)).toBe(Date.UTC(2026, 9, 25, 8, 0)) // 09:00 CET
  })

  it('un cron alle 02:30 il 29 marzo (ora inesistente) salta al giorno dopo', () => {
    const from = Date.UTC(2026, 2, 28, 20, 0) // 21:00 a Roma del 28/3
    const next = nextCronRun('30 2 * * *', from, ROME)!
    expect(next).not.toBeNull()
    // il 29/3 le 02:30 non esistono → si passa al 30/3, 02:30 CEST = 00:30 UTC
    expect(next).toBe(Date.UTC(2026, 2, 30, 0, 30))
  })

  it('due fusi diversi danno run diversi dallo stesso istante', () => {
    const from = Date.UTC(2026, 5, 1, 5, 0)
    const rome = nextCronRun('0 9 * * *', from, ROME)!
    const ny = nextCronRun('0 9 * * *', from, 'America/New_York')!
    expect(rome).toBe(Date.UTC(2026, 5, 1, 7, 0)) // 09:00 CEST
    expect(ny).toBe(Date.UTC(2026, 5, 1, 13, 0)) // 09:00 EDT
  })
})

describe('schedule "ogni X" (nextEveryRun)', () => {
  it('ogni giorno alle 09:00, mode at', () => {
    const from = Date.UTC(2026, 5, 1, 10, 0) // 12:00 a Roma
    expect(nextEveryRun(1, { every: 'day', at: '09:00', mode: 'at' }, from, ROME)).toBe(Date.UTC(2026, 5, 2, 7, 0))
  })

  it('nei giorni feriali: salta il weekend', () => {
    // 2026-07-03 è venerdì: il prossimo weekday run è lunedì 6
    const from = Date.UTC(2026, 6, 3, 15, 0)
    expect(nextEveryRun(1, { every: 'weekday', at: '09:00', mode: 'at' }, from, ROME)).toBe(Date.UTC(2026, 6, 6, 7, 0))
  })

  it('ogni settimana il lunedì', () => {
    const from = Date.UTC(2026, 6, 8, 15, 0) // mercoledì 8/7
    expect(nextEveryRun(1, { every: 'week', at: '09:00', weekday: 1, mode: 'at' }, from, ROME)).toBe(Date.UTC(2026, 6, 13, 7, 0))
  })

  it('il giorno 31 di ogni mese salta febbraio senza esplodere', () => {
    const from = Date.UTC(2026, 0, 31, 15, 0) // 31 gennaio
    const next = nextEveryRun(1, { every: 'month', at: '09:00', monthDay: 31, mode: 'at' }, from, ROME)!
    // il 31/1 è passato (17:00 locali) → marzo (febbraio non ha il 31): 09:00 CEST = 07:00 UTC
    expect(next).toBe(Date.UTC(2026, 2, 31, 7, 0))
  })

  it('ogni ora al minuto 30 (at "09:30": conta il minuto)', () => {
    const from = Date.UTC(2026, 5, 1, 8, 45) // 10:45 a Roma
    const next = nextEveryRun(1, { every: 'hour', at: '09:30', mode: 'at' }, from, ROME)!
    expect(tzParts(next, ROME)).toMatchObject({ hour: 11, minute: 30 }) // l'ora dopo, al minuto 30
  })

  it('mode around: la variazione è DETERMINISTICA (stesso seed stesso minuto) e sta in ±15', () => {
    const spec = { every: 'day' as const, at: '09:00', mode: 'around' as const }
    const from = Date.UTC(2026, 5, 1, 0, 0)
    const a = nextEveryRun(42, spec, from, ROME)!
    const b = nextEveryRun(42, spec, from, ROME)!
    expect(a).toBe(b)
    // l'istante base è le 09:00 locali: lo scarto sta in [-15, +15] minuti
    const base = Date.UTC(2026, 5, 1, 7, 0) // 09:00 CEST
    expect(Math.abs(a - base)).toBeLessThanOrEqual(15 * 60_000)
    expect(Math.abs(a - base)).toBe(Math.abs(aroundJitterMinutes('42:2026-6-1')) * 60_000)
  })

  it('mode around: routine diverse (seed diverso) possono avere offset diversi, tutti in range', () => {
    const offsets = new Set<number>()
    for (let id = 1; id <= 60; id++) {
      const j = aroundJitterMinutes(`${id}:2026-6-1`)
      expect(Math.abs(j)).toBeLessThanOrEqual(15)
      offsets.add(j)
    }
    expect(offsets.size).toBeGreaterThan(10) // davvero vari, non costante
  })

  it('around: un jitter positivo può proiettare nel futuro un\'occorrenza base appena passata', () => {
    // routine 42, 1/6/2026: seed con jitter noto
    const jitter = aroundJitterMinutes('7:2026-6-2')
    const base = Date.UTC(2026, 5, 2, 7, 0) // 09:00 CEST del 2/6
    const from = base - 60_000 // l'occorrenza base è passata da 1 minuto
    const next = nextEveryRun(7, { every: 'day', at: '09:00', mode: 'around' }, from, ROME)
    if (jitter > 1) {
      // il jitter la riporta nel futuro: il run resta OGGI
      expect(next).toBe(base + jitter * 60_000)
    } else {
      // il jitter non basta: si passa a domani
      const tomorrowBase = Date.UTC(2026, 5, 3, 7, 0)
      expect(next).toBe(tomorrowBase + aroundJitterMinutes('7:2026-6-3') * 60_000)
    }
  })
})

describe('nextScheduleRun: routine complete (colonna schedule vs trigger)', () => {
  it('routine legacy (solo colonna cron): usa il cron con il fuso della routine', () => {
    const r = { id: 1, schedule: '0 9 * * *', timezone: ROME, trigger: null }
    expect(nextScheduleRun(r, Date.UTC(2026, 5, 1, 10, 0))).toBe(Date.UTC(2026, 5, 2, 7, 0))
  })

  it('trigger cron: vince sul fuso e sulla colonna', () => {
    const r = { id: 1, schedule: '0 5 * * *', timezone: ROME, trigger: { type: 'schedule', kind: 'cron', cron: '0 9 * * *' } as const }
    expect(nextScheduleRun(r, Date.UTC(2026, 5, 1, 10, 0))).toBe(Date.UTC(2026, 5, 2, 7, 0))
  })

  it('trigger a evento (webhook/presence_return/poll): nessun run pianificato', () => {
    expect(nextScheduleRun({ id: 1, schedule: '', timezone: ROME, trigger: { type: 'webhook', token: 'x' } }, 0)).toBeNull()
    expect(nextScheduleRun({ id: 1, schedule: '', timezone: ROME, trigger: { type: 'presence_return' } }, 0)).toBeNull()
  })

  it('fuso non valido → fuso locale del processo (mai crash)', () => {
    expect(routineTimeZone('Roma/Italia')).toBe(routineTimeZone(''))
    expect(routineTimeZone('Europe/Rome')).toBe('Europe/Rome')
  })

  it('nextPollAt: ultimo poll + intervallo (o la creazione per il primo)', () => {
    expect(nextPollAt(null, 1000, 5)).toBe(1000 + 5 * 60_000)
    expect(nextPollAt(200_000, 1000, 2)).toBe(200_000 + 2 * 60_000)
  })
})
