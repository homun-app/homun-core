// Test della descrizione in linguaggio naturale delle schedule cron
// (fase 4: la card di approvazione di update_state mostra nome, schedule
// "umana" e prompt). Funzione pura condivisa main/renderer.
import { describe, expect, it } from 'vitest'
import { describeCron } from '../cron-human'

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
