// OA3 (fase onboarding-a): le scelte del passo autorizzazioni della guida,
// PURE — «Automatico» ha bisogno del modello (il revisore che decide se una
// azione può passare è un modello): senza, la scelta c'è ma resta spenta con
// la riga che dice perché.
import { describe, expect, it } from 'vitest'
import { approvalsChoices } from '../guide-steps'

describe('OA3 approvalsChoices: le due scelte del passo autorizzazioni', () => {
  it('«Chiedi prima» sempre disponibile', () => {
    for (const modelReady of [false, true]) {
      const ask = approvalsChoices(modelReady).find((c) => c.id === 'ask')!
      expect(ask.enabled).toBe(true)
      expect(ask.hint).toBeUndefined()
    }
  })

  it('«Automatico» SENZA modello spento, con la riga «Serve un modello»', () => {
    const auto = approvalsChoices(false).find((c) => c.id === 'auto')!
    expect(auto.enabled).toBe(false)
    expect(auto.hint).toMatch(/modello/i)
  })

  it('«Automatico» col modello acceso e senza righe', () => {
    const auto = approvalsChoices(true).find((c) => c.id === 'auto')!
    expect(auto.enabled).toBe(true)
    expect(auto.hint).toBeUndefined()
  })

  it('sono DUE scelte, in ordine fisso: ask poi auto', () => {
    expect(approvalsChoices(true).map((c) => c.id)).toEqual(['ask', 'auto'])
  })
})
