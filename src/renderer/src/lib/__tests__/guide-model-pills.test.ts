// GC2 (fase guida-correzioni): le pillole dei modelli del pannello con chiave
// — funzione PURA: al massimo 4 (il consigliato per primo, poi gli altri
// NELL'ORDINE dell'elenco), e un modello scelto dal picker che non è fra le
// pillole DIVENTA una pillola, selezionata, al posto dell'ultima.
import { describe, expect, it } from 'vitest'
import { guideModelPills, MAX_GUIDE_MODEL_PILLS } from '../guide-model-pills'

const MODELS = ['claude-sonnet-4-5', 'bravo', 'sciocco', 'lungo', 'vecchio', 'nuovo']

describe('GC2 guideModelPills (pura): le pillole dei modelli dell\'elenco', () => {
  it('al massimo 4, col consigliato per primo e gli altri nell\'ordine dell\'elenco', () => {
    // kind anthropic: il consigliato è claude-sonnet (il più alto fra i combaci)
    const pills = guideModelPills('anthropic', MODELS, null)
    expect(pills).toHaveLength(MAX_GUIDE_MODEL_PILLS)
    expect(pills[0]).toBe('claude-sonnet-4-5')
    expect(pills.slice(1)).toEqual(['bravo', 'sciocco', 'lungo'])
  })

  it('un modello scelto dal picker che NON è fra le pillole diventa una pillola, al posto dell\'ultima', () => {
    const pills = guideModelPills('anthropic', MODELS, 'estratto-dal-picker')
    expect(pills).toHaveLength(MAX_GUIDE_MODEL_PILLS)
    expect(pills[pills.length - 1]).toBe('estratto-dal-picker')
    // il consigliato resta per primo e i primi due dell'elenco restano
    expect(pills.slice(0, 3)).toEqual(['claude-sonnet-4-5', 'bravo', 'sciocco'])
  })

  it('un modello scelto che è GIÀ fra le pillole non cambia l\'elenco', () => {
    expect(guideModelPills('anthropic', MODELS, 'sciocco')).toEqual(['claude-sonnet-4-5', 'bravo', 'sciocco', 'lungo'])
  })

  it('con pochi modelli restano tutti; elenco vuoto → nessuna pillola', () => {
    expect(guideModelPills('anthropic', ['solo-io'], null)).toEqual(['solo-io'])
    expect(guideModelPills('anthropic', [], 'qualunque')).toEqual(['qualunque'])
  })

  it('senza preferenze che combaciano vince il primo dell\'elenco (mai nomi inventati)', () => {
    expect(guideModelPills('openai-compatible', ['primo', 'secondo'], null)).toEqual(['primo', 'secondo'])
  })
})
