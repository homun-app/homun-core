// Fase 16c correzioni (R5.3): la valuta segue la lingua dell'interfaccia.
// «$0,012» in italiano, «$0.012» in inglese — e le cifre decimali restano
// quelle di oggi (2 per ≥ 1, 3 sotto).
import { describe, expect, it } from 'vitest'
import { fmtUsd } from '../fmt'

describe('R5.3 — fmtUsd con Intl.NumberFormat nella lingua dell\'interfaccia', () => {
  it('italiano: virgola decimale', () => {
    expect(fmtUsd(0.012, 'it')).toBe('$0,012')
    expect(fmtUsd(1.5, 'it')).toBe('$1,50')
    expect(fmtUsd(12.3456, 'it')).toBe('$12,35')
  })

  it('inglese: punto decimale', () => {
    expect(fmtUsd(0.012, 'en')).toBe('$0.012')
    expect(fmtUsd(1.5, 'en')).toBe('$1.50')
    expect(fmtUsd(12.3456, 'en')).toBe('$12.35')
  })

  it('le cifre decimali sono quelle di oggi: 2 per ≥ 1 (anche in valore assoluto), 3 sotto', () => {
    expect(fmtUsd(2, 'it')).toBe('$2,00')
    expect(fmtUsd(0.5, 'it')).toBe('$0,500')
    expect(fmtUsd(-0.012, 'it')).toBe('-$0,012')
  })
})
