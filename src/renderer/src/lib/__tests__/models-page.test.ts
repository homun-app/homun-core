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

// fase locale correzioni (LC2): quali pulsanti mostra la scheda Integrato per
// ogni stato — Annulla SOLO col download attivo; Riprendi (Range) e
// Ricomincia (cancella il .part) con paused e con error.
import { localModelCardActions } from '../models-page'

describe('fase locale correzioni (LC2): i pulsanti della scheda Integrato', () => {
  it('downloading → SOLO Annulla (niente Riprendi/Ricomincia: è già attivo)', () => {
    expect(localModelCardActions('downloading')).toEqual({ cancel: true, resume: false, restart: false })
  })

  it('paused → Riprendi e Ricomincia, MAI Annulla (non c\'è niente da annullare)', () => {
    expect(localModelCardActions('paused')).toEqual({ cancel: false, resume: true, restart: true })
  })

  it('error → gli stessi due pulsanti di paused (il messaggio lo mostra la scheda)', () => {
    expect(localModelCardActions('error')).toEqual({ cancel: false, resume: true, restart: true })
  })

  it('not-installed / ready / running → nessuno dei tre (Installa e Rimuovi vivono a parte)', () => {
    expect(localModelCardActions('not-installed')).toEqual({ cancel: false, resume: false, restart: false })
    expect(localModelCardActions('ready')).toEqual({ cancel: false, resume: false, restart: false })
    expect(localModelCardActions('running')).toEqual({ cancel: false, resume: false, restart: false })
  })
})
