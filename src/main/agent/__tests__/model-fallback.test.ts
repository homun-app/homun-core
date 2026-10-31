// Fase 9 (punto 1) — test puri della decisione della RISERVA:
// 5xx/timeout/scadenza sì, 4xx mai, una sola volta per turno.
import { describe, expect, it } from 'vitest'
import { fallbackEligible, shouldUseFallback } from '../model-fallback'

const httpError = (status: number): Error => {
  const e = new Error(`HTTP ${status}`)
  ;(e as Error & { status?: number }).status = status
  return e
}
const deadline = (): Error => {
  // fase 17c correzioni (D2): il messaggio di StreamDeadlineError è inglese
  const e = new Error('no token within 150 s')
  e.name = 'StreamDeadlineError'
  return e
}
const state = (patch: Partial<Parameters<typeof shouldUseFallback>[1]> = {}) => ({
  fallbackModel: 'riserva',
  model: 'principale',
  fallbackUsed: false,
  aborted: false,
  ...patch
})

describe('fallbackEligible', () => {
  it('5xx → sì (502, 500, 503)', () => {
    expect(fallbackEligible(httpError(500))).toBe(true)
    expect(fallbackEligible(httpError(502))).toBe(true)
    expect(fallbackEligible(httpError(503))).toBe(true)
  })

  it('4xx → MAI (richiesta sbagliata: la riserva farebbe lo stesso errore)', () => {
    expect(fallbackEligible(httpError(400))).toBe(false)
    expect(fallbackEligible(httpError(401))).toBe(false)
    expect(fallbackEligible(httpError(404))).toBe(false)
    expect(fallbackEligible(httpError(429))).toBe(false)
  })

  it('scadenza dello stream (fase 8) → sì', () => {
    expect(fallbackEligible(deadline())).toBe(true)
  })

  it('timeout e errori di rete del provider → sì (il principale non risponde)', () => {
    expect(fallbackEligible(new Error('Request timed out'))).toBe(true)
    expect(fallbackEligible(new Error('fetch failed'))).toBe(true)
    expect(fallbackEligible(new Error('ECONNREFUSED 127.0.0.1:11434'))).toBe(true)
    expect(fallbackEligible(new Error('socket hang up'))).toBe(true)
  })

  it('altri errori senza status → no (non si sa cosa sia: si chiude e basta)', () => {
    expect(fallbackEligible(new Error('invalid JSON response'))).toBe(false)
    expect(fallbackEligible('una stringa')).toBe(false)
  })
})

describe('shouldUseFallback', () => {
  it('decisione completa: 5xx con riserva disponibile → una riprova', () => {
    expect(shouldUseFallback(httpError(502), state())).toBe(true)
  })

  it('UNA volta sola per turno; senza riserva configurata mai; riserva uguale al principale mai', () => {
    expect(shouldUseFallback(httpError(502), state({ fallbackUsed: true }))).toBe(false)
    expect(shouldUseFallback(httpError(502), state({ fallbackModel: null }))).toBe(false)
    expect(shouldUseFallback(httpError(502), state({ fallbackModel: 'principale' }))).toBe(false)
  })

  it('turno interrotto dall\'utente → mai riserva', () => {
    expect(shouldUseFallback(httpError(502), state({ aborted: true }))).toBe(false)
  })

  it('4xx con tutto il resto a posto → no', () => {
    expect(shouldUseFallback(httpError(400), state())).toBe(false)
  })
})
