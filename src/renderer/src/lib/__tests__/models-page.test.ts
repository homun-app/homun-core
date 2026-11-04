// Fase impostazioni (I2): le funzioni PURE della pagina Modelli — ordine e
// spostamento delle riserve, stato della riga del revisore.
import { describe, expect, it } from 'vitest'
import { moveFallback, removeFallback, reviewerMissing } from '../models-page'

const chain = [
  { providerId: 'a', model: 'm1' },
  { providerId: 'b', model: 'm2' },
  { providerId: 'c', model: 'm3' }
]

describe('moveFallback: l\'ordine delle riserve', () => {
  it('su e giù di una posizione; la catena originale non si muta', () => {
    expect(moveFallback(chain, 1, -1).map((r) => r.model)).toEqual(['m2', 'm1', 'm3'])
    expect(moveFallback(chain, 1, 1).map((r) => r.model)).toEqual(['m1', 'm3', 'm2'])
    expect(chain.map((r) => r.model)).toEqual(['m1', 'm2', 'm3'])
  })

  it('fuori dai limiti: la catena non cambia', () => {
    expect(moveFallback(chain, 0, -1)).toEqual(chain)
    expect(moveFallback(chain, 2, 1)).toEqual(chain)
  })
})

describe('removeFallback', () => {
  it('toglie la voce scelta e basta', () => {
    expect(removeFallback(chain, 1).map((r) => r.model)).toEqual(['m1', 'm3'])
  })
})

describe('reviewerMissing: lo stato della riga del revisore (I2.2)', () => {
  it('Automatico senza modello → l\'avviso in arancio', () => {
    expect(reviewerMissing('auto', { providerId: null, model: null })).toBe(true)
    expect(reviewerMissing('auto', { providerId: 'p', model: null })).toBe(true)
    expect(reviewerMissing('auto', { providerId: null, model: 'm' })).toBe(true)
  })

  it('Automatico col modello scelto, o Chiedi/Non chiedere: nessun avviso', () => {
    expect(reviewerMissing('auto', { providerId: 'p', model: 'm' })).toBe(false)
    expect(reviewerMissing('ask', { providerId: null, model: null })).toBe(false)
    expect(reviewerMissing('never', { providerId: null, model: null })).toBe(false)
  })
})
