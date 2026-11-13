// OB2 (fase onboarding-b): il passo «Computer» nella guida — quando c'è e
// quando si chiude da solo. Le funzioni PURA: computerStepAvailable (il
// passo c'è se la macchina regge il motore Apple E non è già tutto pronto,
// oppure la preparazione è in corso), la sequenza col passo al posto
// giusto (fra Modello e Permessi), l'avanzare automatico quando la
// preparazione finisce mentre la guida è ferma lì (come il modello in
// OA3) e il wiring di computerBecameReady del controller dell'onboarding.
import { describe, expect, it } from 'vitest'
import type { BoxSetupPhase, OnboardingState, OnboardingStepId } from '../../shared/types'
import {
  onboardingStepSequence, computerStepAvailable, autoAdvanceOnboarding, initialOnboardingState, createOnboarding
} from '../onboarding'
import type { OnboardingDeps } from '../onboarding'

const avail = (computer: boolean): { computer: boolean; memory: boolean } => ({ computer, memory: false })
const seq: readonly OnboardingStepId[] = onboardingStepSequence(avail(true))

const stateAt = (step: OnboardingStepId): OnboardingState => ({ step, done: [], skipped: [], startedAt: 1 })

describe('OB2: la disponibilità del passo Computer (PURa)', () => {
  it('c\'è se la macchina è supportata e il motore non è pronto con immagine', () => {
    expect(computerStepAvailable({ supported: true, readyWithImage: false }, null)).toBe(true)
    expect(computerStepAvailable({ supported: true, readyWithImage: false }, 'idle')).toBe(true)
  })

  it('con ready più immagine il passo è FATTO DA SOLO: non c\'è (come il modello in OA3)', () => {
    expect(computerStepAvailable({ supported: true, readyWithImage: true }, null)).toBe(false)
    expect(computerStepAvailable({ supported: true, readyWithImage: true }, 'ready')).toBe(false)
  })

  it('la preparazione in CORSO lo tiene acceso anche se il motore è pronto', () => {
    for (const phase of ['checking-space', 'downloading', 'verifying', 'awaiting-installer', 'starting-service', 'installing-kernel', 'building-image'] as const) {
      expect(computerStepAvailable({ supported: true, readyWithImage: true }, phase)).toBe(true)
    }
    // errore o annullato: la preparazione NON corre → il passo resta, si riprova
    expect(computerStepAvailable({ supported: true, readyWithImage: true }, 'error')).toBe(false)
    expect(computerStepAvailable({ supported: true, readyWithImage: true }, 'cancelled')).toBe(false)
  })

  it('su una macchina NON supportata il passo non c\'è mai (Docker resta la riserva in Impostazioni)', () => {
    expect(computerStepAvailable({ supported: false, readyWithImage: false }, null)).toBe(false)
    expect(computerStepAvailable({ supported: false, readyWithImage: false }, 'downloading')).toBe(false)
  })
})

describe('OB2: la sequenza col passo Computer', () => {
  it('il passo sta fra Modello e Permessi', () => {
    expect(onboardingStepSequence(avail(true))).toEqual(['welcome', 'model', 'computer', 'approvals', 'chat'])
  })

  it('senza disponibilità la sequenza è quella di oggi (il passo salta, senza segnarlo)', () => {
    expect(onboardingStepSequence(avail(false))).toEqual(['welcome', 'model', 'approvals', 'chat'])
  })

  it('lo stato iniziale parte dal primo passo anche con il computer', () => {
    expect(initialOnboardingState(1, avail(true)).step).toBe('welcome')
  })
})

describe('OB2: il passo si chiude DA SOLO quando la preparazione finisce (OA3 per il computer)', () => {
  it('autoAdvanceOnboarding: guida ferma su computer e preparazione pronta → fatto', () => {
    const next = autoAdvanceOnboarding(stateAt('computer'), { modelReady: false, computerReady: true }, seq)
    expect(next.step).toBe('approvals')
    expect(next.done).toEqual(['computer'])
  })

  it('la preparazione pronta NON tocca gli altri passi', () => {
    const s = stateAt('model')
    expect(autoAdvanceOnboarding(s, { modelReady: false, computerReady: true }, seq)).toBe(s)
    const a = stateAt('approvals')
    expect(autoAdvanceOnboarding(a, { modelReady: false, computerReady: true }, seq)).toBe(a)
  })

  it('senza preparazione pronta il passo resta aperto', () => {
    const s = stateAt('computer')
    expect(autoAdvanceOnboarding(s, { modelReady: false, computerReady: false }, seq)).toBe(s)
  })
})

describe('OB2: computerBecameReady del controller dell\'onboarding', () => {
  const mkDeps = (step: OnboardingStepId | null): OnboardingDeps => {
    const store = new Map<string, unknown>()
    if (step) store.set('onboarding.state', { step, done: [], skipped: [], startedAt: 1 })
    return {
      now: () => 1,
      getSetting: <T,>(k: string, f: T): T => (store.has(k) ? (store.get(k) as T) : f),
      setSetting: (k: string, v: unknown) => { store.set(k, v) },
      listAgents: () => [],
      createAgent: () => { throw new Error('mai') },
      getAgent: () => null,
      getEntries: () => [],
      tx: <T,>(fn: () => T): T => fn(),
      updateAgent: () => undefined,
      listProviders: () => [],
      appendSystemSend: () => undefined,
      markWidgetResponded: () => undefined,
      markWidgetDismissed: () => undefined,
      connectedAppIds: async () => new Set(),
      emit: () => undefined,
      stepAvailability: () => avail(step === 'computer'),
      computerReady: () => true
    } as OnboardingDeps
  }

  it('guida ferma su computer: il passo si chiude, torna true', () => {
    const onboarding = createOnboarding(mkDeps('computer'))
    expect(onboarding.computerBecameReady()).toBe(true)
    expect(onboarding.status().state?.step).toBe('approvals')
  })

  it('guida altrove (o chiusa): niente cambia, torna false', () => {
    expect(createOnboarding(mkDeps('model')).computerBecameReady()).toBe(false)
    expect(createOnboarding(mkDeps('chat')).computerBecameReady()).toBe(false)
    expect(createOnboarding(mkDeps(null)).computerBecameReady()).toBe(false)
  })
})
