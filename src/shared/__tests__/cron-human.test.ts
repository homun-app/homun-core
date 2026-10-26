// Test della descrizione in linguaggio naturale delle schedule cron
// (fase 4: la card di approvazione di update_state mostra nome, schedule
// "umana" e prompt). Funzione pura condivisa main/renderer.
// Fase 6: describeTrigger/describeEverySchedule estendono la descrizione ai
// nuovi tipi di trigger (schedule "ogni X", email, calendar_event, webhook).
import { describe, expect, it } from 'vitest'
import { describeCron, describeTrigger, describeEverySchedule } from '../cron-human'
import type { RoutineTrigger } from '../types'

describe('describeCron', () => {
  it('forme comuni in italiano', () => {
    expect(describeCron('* * * * *')).toBe('ogni minuto')
    expect(describeCron('*/15 * * * *')).toBe('ogni 15 minuti')
    expect(describeCron('0 9 * * *')).toBe('tutti i giorni alle 09:00')
    expect(describeCron('30 8 * * 1-5')).toBe('nei giorni feriali alle 08:30')
    expect(describeCron('0 10 * * mon')).toBe('il lunedì alle 10:00')
    expect(describeCron('0 10 * * sat,sun')).toBe('nel weekend alle 10:00')
    expect(describeCron('0 9 1 * *')).toBe('il giorno 1 del mese alle 09:00')
  })

  it('più orari e campi non banali: comunque leggibile', () => {
    expect(describeCron('0 9,18 * * *')).toBe('tutti i giorni alle 09:00, 18:00')
    expect(describeCron('*/6 * * * *')).toBe('ogni 6 minuti')
    expect(describeCron('0 */4 * * *')).toBe('ogni 4 ore')
  })

  it('espressione non cron a 5 campi → ripiego sulla forma grezza', () => {
    expect(describeCron(' nonsense ')).toBe('cron " nonsense "')
    expect(describeCron('0 9 * *')).toBe('cron "0 9 * *"')
    expect(describeCron('99 99 * * *')).toBe('cron "99 99 * * *"')
  })
})

describe('fase 6: describeEverySchedule e describeTrigger', () => {
  it('schedule "ogni X" in italiano, con around esplicito', () => {
    expect(describeEverySchedule({ every: 'day', at: '09:00', mode: 'at' })).toBe('ogni giorno alle 09:00')
    expect(describeEverySchedule({ every: 'day', at: '09:00', mode: 'around' })).toBe('ogni giorno verso le 09:00 (±15 min)')
    expect(describeEverySchedule({ every: 'weekday', at: '08:30', mode: 'at' })).toBe('nei giorni feriali alle 08:30')
    expect(describeEverySchedule({ every: 'week', at: '09:00', weekday: 3, mode: 'at' })).toBe('ogni settimana il mercoledì alle 09:00')
    expect(describeEverySchedule({ every: 'month', at: '09:00', monthDay: 15, mode: 'at' })).toBe('il giorno 15 di ogni mese alle 09:00')
    expect(describeEverySchedule({ every: 'hour', at: '09:30', mode: 'at' })).toBe('ogni ora al minuto 30')
  })

  it('describeTrigger per ogni tipo', () => {
    expect(describeTrigger({ type: 'schedule', kind: 'cron', cron: '0 9 * * *' })).toBe('tutti i giorni alle 09:00')
    expect(describeTrigger({ type: 'schedule', kind: 'every', every: 'day', at: '09:00', mode: 'around' })).toBe('ogni giorno verso le 09:00 (±15 min)')
    expect(describeTrigger({ type: 'webhook', token: 'x' })).toBe('quando riceve una chiamata webhook')
    expect(describeTrigger({ type: 'presence_return' })).toBe('quando torni al computer dopo un\'assenza')
    const email: RoutineTrigger = { type: 'connector_poll', connectorId: 'gmail', tool: 'mcp__gmail__search', intervalMin: 5, idField: 'messages[].id', preset: 'email', args: { query: 'fatture' } }
    expect(describeTrigger(email)).toBe('quando arriva un\'email che corrisponde a "fatture"')
    const cal: RoutineTrigger = { type: 'connector_poll', connectorId: 'gcalendar', tool: 'mcp__gcalendar__list', intervalMin: 15, idField: 'events[].id', preset: 'calendar_event', offsetMinutes: 10 }
    expect(describeTrigger(cal)).toBe('10 minuti prima di ogni evento del calendario')
    const poll: RoutineTrigger = { type: 'connector_poll', connectorId: 'sentry', tool: 'mcp__sentry__list', intervalMin: 5, idField: 'issues[].id' }
    expect(describeTrigger(poll)).toBe('quando il tool mcp__sentry__list del connettore sentry vede un nuovo elemento (issues[].id)')
  })

  it('trigger assente → describeCron della colonna schedule', () => {
    expect(describeTrigger(null, '0 9 * * 1-5')).toBe('nei giorni feriali alle 09:00')
  })
})
