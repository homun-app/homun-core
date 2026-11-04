// Fase impostazioni (I3/I4/I8): le migrazioni dei setting che rendono visibile
// ciò che il motore faceva in silenzio. Test PURI del core (dict in/dict out)
// su una FIXTURE coi setting della 0.3.1000/0.3.1001: providers.modelDefaults,
// autoReview.enabled, catena vuota, models.main su Ollama. Ogni migrazione è
// una tantum col suo flag: al secondo giro non si tocca più niente.
import { describe, expect, it } from 'vitest'
import {
  runSettingsMigrations, materializeFallbackChain, materializeReviewer, materializeApprovalsMode,
  type MigrationInput
} from '../settings-migrations'
import type { AutoReviewSettings, MainModel } from '../../../shared/types'
import { DEFAULT_AUTO_REVIEW } from '../../../shared/types'

const MAIN_OLLAMA: MainModel = { providerId: 'ollama', model: 'kimi-k3:cloud', thinking: null }

/** La fixture di una cartella dati della 0.3.1000/0.3.1001 (i setting di oggi). */
const fixture = (over: Partial<MigrationInput> = {}): MigrationInput => ({
  main: MAIN_OLLAMA,
  chain: [],
  providers: [{ id: 'ollama', kind: 'ollama', enabled: true }],
  // la riserva implicita di Ollama: default del kind (glm-5.3:cloud), nessun override
  modelDefaults: {},
  autoReview: { ...DEFAULT_AUTO_REVIEW },
  approvalsMode: undefined,
  flags: {},
  ...over
})

describe('I3.1 — materializeFallbackChain (la riserva implicita diventa visibile)', () => {
  it('fixture 0.3.1001: catena vuota + Ollama → la riserva del KIND è la prima (e unica) voce', () => {
    expect(materializeFallbackChain(fixture())).toEqual([{ providerId: 'ollama', model: 'glm-5.3:cloud' }])
  })

  it("l'OVERRIDE dell'utente vince sul default del kind", () => {
    const out = materializeFallbackChain(fixture({ modelDefaults: { ollama: { fallbackModel: 'mio-fallback' } } }))
    expect(out).toEqual([{ providerId: 'ollama', model: 'mio-fallback' }])
  })

  it('catena GIÀ piena → non si tocca nulla (l\'utente ha già scelto)', () => {
    expect(materializeFallbackChain(fixture({ chain: [{ providerId: 'p2', model: 'x' }] }))).toBeUndefined()
  })

  it('senza models.main → niente (niente da materializzare)', () => {
    expect(materializeFallbackChain(fixture({ main: null }))).toBeUndefined()
  })

  it('riserva uguale al principale o provider senza riserva → niente', () => {
    expect(materializeFallbackChain(fixture({ modelDefaults: { ollama: { fallbackModel: 'kimi-k3:cloud' } } }))).toBeUndefined()
    expect(materializeFallbackChain(fixture({
      main: { providerId: 'groq', model: 'x', thinking: null },
      providers: [{ id: 'groq', kind: 'groq', enabled: true }]
    }))).toBeUndefined()
  })

  it('FLAG già scritto → mai due volte', () => {
    expect(materializeFallbackChain(fixture({ flags: { fallbackMaterialized: true } }))).toBeUndefined()
  })
})

describe('I3.2 — materializeReviewer (il ripiego silenzioso si scrive in autoReview)', () => {
  it('revisore non scelto + Ollama attivo → glm-5.3-flash:cloud del KIND, regole ed enabled al loro posto', () => {
    const out = materializeReviewer(fixture({ autoReview: { ...DEFAULT_AUTO_REVIEW, enabled: true, allowRules: ['r1'] } }))
    expect(out).toEqual({ enabled: true, allowRules: ['r1'], blockRules: [], providerId: 'ollama', model: 'glm-5.3-flash:cloud' })
  })

  it("provider scelto SENZA modello → l'auto-review del TIPO di quel provider (come reviewWithConfiguredModel)", () => {
    const out = materializeReviewer(fixture({ autoReview: { ...DEFAULT_AUTO_REVIEW, providerId: 'ollama' } }))
    expect(out).toEqual({ ...DEFAULT_AUTO_REVIEW, providerId: 'ollama', model: 'glm-5.3-flash:cloud' })
  })

  it("l'OVERRIDE utente dell'auto-review vince sul kind", () => {
    const out = materializeReviewer(fixture({ modelDefaults: { ollama: { autoReviewModel: 'piccolo-mio' } } }))
    expect(out).toMatchObject({ providerId: 'ollama', model: 'piccolo-mio' })
  })

  it('revisore GIÀ scelto (provider+modello) → non si tocca', () => {
    const chosen: AutoReviewSettings = { ...DEFAULT_AUTO_REVIEW, providerId: 'p9', model: 'mio' }
    expect(materializeReviewer(fixture({ autoReview: chosen }))).toBeUndefined()
  })

  it('nessun provider con un revisore di default → niente (il ripiego di oggi non troverebbe nulla)', () => {
    expect(materializeReviewer(fixture({
      providers: [{ id: 'groq', kind: 'groq', enabled: true }]
    }))).toBeUndefined()
  })

  it('FLAG già scritto → mai due volte', () => {
    expect(materializeReviewer(fixture({ flags: { reviewerMaterialized: true } }))).toBeUndefined()
  })
})

describe('I4.1 — materializeApprovalsMode (il modo nasce da enabled)', () => {
  it('enabled true → auto; false → ask', () => {
    expect(materializeApprovalsMode(fixture({ autoReview: { ...DEFAULT_AUTO_REVIEW, enabled: true } }))).toBe('auto')
    expect(materializeApprovalsMode(fixture())).toBe('ask')
  })

  it('approvals.mode GIÀ presente → non si tocca (nemmeno se è never: è scelta dell’utente)', () => {
    expect(materializeApprovalsMode(fixture({ approvalsMode: 'never' }))).toBeUndefined()
    expect(materializeApprovalsMode(fixture({ approvalsMode: 'ask', autoReview: { ...DEFAULT_AUTO_REVIEW, enabled: true } }))).toBeUndefined()
  })

  it('la migrazione non scrive MAI never', () => {
    expect(materializeApprovalsMode(fixture())).not.toBe('never')
  })
})

describe('I8 — runSettingsMigrations: la fixture della 0.3.1001 si apre con tutto visibile', () => {
  it('prima: riserva invisibile, revisore invisibile, nessun modo → dopo: tutto scritto + flag', () => {
    const before = fixture({ autoReview: { ...DEFAULT_AUTO_REVIEW, enabled: true, allowRules: ['comandi ls'], blockRules: [] } })
    const r = runSettingsMigrations(before)
    expect(r.chain).toEqual([{ providerId: 'ollama', model: 'glm-5.3:cloud' }])
    expect(r.autoReview).toEqual({ enabled: true, allowRules: ['comandi ls'], blockRules: [], providerId: 'ollama', model: 'glm-5.3-flash:cloud' })
    expect(r.approvalsMode).toBe('auto')
    expect(r.flags).toEqual({ fallbackMaterialized: true, reviewerMaterialized: true, modeSet: true })
  })

  it('nessuna regola persa: allowRules e blockRules passano integre', () => {
    const r = runSettingsMigrations(fixture({
      autoReview: { enabled: true, allowRules: ['a', 'b'], blockRules: ['c'], providerId: null, model: null }
    }))
    expect(r.autoReview?.allowRules).toEqual(['a', 'b'])
    expect(r.autoReview?.blockRules).toEqual(['c'])
  })

  it("IDEMPOTENTE: al secondo giro (flag scritti) non c'è niente da scrivere", () => {
    const first = runSettingsMigrations(fixture())
    const second = runSettingsMigrations(fixture({
      chain: first.chain ?? [],
      autoReview: first.autoReview ?? { ...DEFAULT_AUTO_REVIEW },
      approvalsMode: first.approvalsMode,
      flags: first.flags
    }))
    expect(second.chain).toBeUndefined()
    expect(second.autoReview).toBeUndefined()
    expect(second.approvalsMode).toBeUndefined()
  })

  it('i flag si scrivono SEMPRE al primo giro, anche quando non c\'è niente da materializzare', () => {
    const r = runSettingsMigrations(fixture({ main: null, providers: [] }))
    expect(r.chain).toBeUndefined()
    expect(r.autoReview).toBeUndefined()
    expect(r.flags.fallbackMaterialized).toBe(true)
  })
})
