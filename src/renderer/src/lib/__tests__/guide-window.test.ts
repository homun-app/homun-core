// OAC1 (fase guida, G1): la finestra decide cosa mostra da UNA funzione pura
// sullo status dell'onboarding — guida aperta (guideOpen), caricamento (il
// daemon ha detto needed ma lo stato non è ancora nato: splash, mai la shell
// vuota che lampeggia), shell normale. Così App.tsx non ragiona su needed.
import { describe, expect, it } from 'vitest'
import { guideWindowState } from '../guide-window'
import type { OnboardingStatus } from '../../../../shared/types'

const status = (patch: Partial<OnboardingStatus>): OnboardingStatus => ({
  needed: false,
  state: null,
  sequence: ['welcome', 'model', 'approvals', 'chat'],
  modelReady: false,
  guideOpen: false,
  ...patch
})

describe('OAC1 guideWindowState (pura): cosa mostra la finestra', () => {
  it('status ancora ignoto (null) → caricamento', () => {
    expect(guideWindowState(null)).toBe('loading')
  })

  it('needed: true con stato NULL (non ancora nato) → CARICAMENTO: niente shell vuota che lampeggia', () => {
    expect(guideWindowState(status({ needed: true, state: null }))).toBe('loading')
  })

  it('guideOpen: true (anche con needed false e messaggi nella storia) → GUIDA', () => {
    expect(guideWindowState(status({ needed: false, guideOpen: true, state: { step: 'model', done: ['welcome'], skipped: [], startedAt: 1 } }))).toBe('guide')
  })

  it('guideOpen: false e non in caricamento → shell (chat normale)', () => {
    expect(guideWindowState(status({}))).toBe('shell')
    expect(guideWindowState(status({ state: { step: 'chat', done: ['welcome'], skipped: [], startedAt: 1 } }))).toBe('shell')
  })
})
