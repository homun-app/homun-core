// Test della formula dello sguardo (fase 16, U1): k = min(1, d/400), x·4, y·3
// — la stessa di Lovable, ora calcolata dai soli abbonati del tracker.
import { describe, expect, it } from 'vitest'
import { gazeFrom } from '../pointer'

describe('fase 16 (U1): gazeFrom', () => {
  it('puntatore sul centro → sguardo zero', () => {
    expect(gazeFrom(100, 100, 100, 100)).toEqual({ x: 0, y: 0 })
  })
  it('vicino al centro si muove poco, lontano si satura (k ≤ 1)', () => {
    const near = gazeFrom(100, 100, 140, 100)
    const far = gazeFrom(100, 100, 10000, 100)
    expect(near.x).toBeCloseTo(4 * (40 / 400), 5)
    expect(near.y).toBe(0)
    // a 400 px di distanza k = 1: spostamento massimo x·4
    expect(far.x).toBeCloseTo(4, 5)
  })
  it('il componente y si muove al massimo di 3', () => {
    const down = gazeFrom(100, 100, 100, 10000)
    expect(down.y).toBeCloseTo(3, 5)
    expect(down.x).toBeCloseTo(0, 5)
  })
})
