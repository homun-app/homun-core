// Test dell'onboarding al primo avvio. OA1 (fase onboarding-a): UNA sola
// strada per il primo avvio — il main NON crea più «Bot» (lo crea solo il
// daemon, dentro l'onboarding, con ensureMainBot single-flight e transazione);
// onboardingNeeded (pura) decide chi fa l'onboarding, ADOZIONE del «Bot» vuoto
// delle beta compresa. Il resto del flusso vecchio (widget del ruolo, due bot
// da template, benvenuto, widget del provider) resta testato qui finché la
// guida a passi non lo sostituisce.
// Dipendenze registrate (niente LLM, niente rete): l'"LLM finto" non serve,
// il kickstart vero partirà come job della coda sui bot creati.
import { describe, expect, it, beforeEach } from 'vitest'
import {
  createOnboarding, startOnboarding,
  onboardingNeeded, createMainBotEnsurer,
  onboardingStepSequence, initialOnboardingState, advanceOnboardingStep, reopenOnboarding, autoAdvanceOnboarding,
  ONBOARDING_STATE_SETTING,
  providerPathsOf,
  MAIN_BOT_NAME, DONE_SETTING,
  type OnboardingDeps
} from '../onboarding'
import type { Agent, OnboardingState, ProviderConfig, SendMessagePayload, SandbotEvent, TranscriptEntry } from '../../shared/types'
import type { BotTemplate } from '../../shared/types'
// fase 17c: i test della lingua scrivono i setting dello store reale (test-setup).
// La lingua di default qui è l'italiano (i testi fissi erano italiani prima);
// il test della lingua EN la cambia e la rimette.
import { setSetting, deleteSetting } from '../../main/store/db'
setSetting('ui.activeLanguage', 'it')

interface Log {
  settings: Record<string, unknown>
  agents: Agent[]
  providers: ProviderConfig[]
  sends: Array<{ agentId: string; message: SendMessagePayload; meta?: Record<string, unknown> }>
  marked: Array<{ agentId: string; entryId: number; value: string | string[] }>
  dismissed: number[]
  connectedApps: string[]
  updates: Array<{ id: string; patch: Record<string, unknown> }>
  events: SandbotEvent[]
  /** le entry per agente, come getEntries del daemon (vuote = chat vuota) */
  agentEntries: Record<string, TranscriptEntry[]>
  nextEntryId: number
}

function mkDeps(log: Log): OnboardingDeps {
  return {
    now: () => 1_000_000_000_000,
    getSetting: <T,>(key: string, fallback: T) => (key in log.settings ? (log.settings[key] as T) : fallback),
    setSetting: (key, value) => { log.settings[key] = value },
    listAgents: () => log.agents,
    getAgent: (id) => log.agents.find((a) => a.id === id) ?? null,
    getEntries: (agentId) => log.agentEntries[agentId] ?? [],
    tx: <T,>(fn: () => T): T => fn(),
    createAgent: (name, description) => {
      const a: Agent = {
        id: `agent_${log.agents.length + 1}`, name, description,
        providerId: null, model: null, status: 'idle', unread: 0, createdAt: log.agents.length + 1
      }
      log.agents.push(a)
      return a
    },
    updateAgent: (id, patch) => { log.updates.push({ id, patch: patch as Record<string, unknown> }) },
    listProviders: () => log.providers,
    markWidgetDismissed: (agentId, entryId) => { log.dismissed.push(entryId) },
    connectedAppIds: async () => new Set(log.connectedApps),
    appendSystemSend: (agentId, message, meta) => {
      log.sends.push({ agentId, message, meta })
      // come il daemon vero: la send di sistema è anche una ENTRY (il controllo
      // anti-widget-doppio del riavvio la rilegge dalla chat)
      log.agentEntries[agentId] = [...(log.agentEntries[agentId] ?? []), {
        id: log.nextEntryId++, agentId, kind: 'send-message', role: 'assistant',
        content: '', meta: { message, ...(meta ?? {}) }, createdAt: log.nextEntryId
      }]
    },
    markWidgetResponded: (agentId, entryId, value) => { log.marked.push({ agentId, entryId, value }) },
    emit: (e: SandbotEvent) => { log.events.push(e) }
  }
}

let log: Log
let deps: OnboardingDeps

beforeEach(() => {
  log = {
    settings: {}, agents: [], providers: [], sends: [], marked: [], dismissed: [], connectedApps: [],
    updates: [], events: [], agentEntries: {}, nextEntryId: 1
  }
  deps = mkDeps(log)
})

// il widget del ruolo viene da una entry send-message di sistema: id noto per i test
const roleWidgetEntryId = 7

// ---- OA1: chi fa l'onboarding (onboardingNeeded, PURA) ----
describe('OA1 onboardingNeeded (pura): chi fa l\'onboarding', () => {
  it('onboarding.done vero → no, e non chiede di scriverlo', () => {
    expect(onboardingNeeded({ done: true, hasUserMessages: false, agents: [], mainAgentId: null }))
      .toEqual({ needed: false, adoptAgentId: null, markDone: false })
  })

  it('c\'è almeno un messaggio dell\'utente in un qualunque bot → no, e onboarding.done si scrive (chi usa già Homun non la rifà)', () => {
    expect(onboardingNeeded({ done: false, hasUserMessages: true, agents: [{ id: 'a_1', name: 'Bot' }], mainAgentId: 'a_1' }))
      .toEqual({ needed: false, adoptAgentId: null, markDone: true })
  })

  it('dati vuoti → sì, nessuna adozione', () => {
    expect(onboardingNeeded({ done: false, hasUserMessages: false, agents: [], mainAgentId: null }))
      .toEqual({ needed: true, adoptAgentId: null, markDone: false })
  })

  it('un «Bot» vuoto delle beta 1–4 → sì, e quel bot si ADOZZA (mai un secondo Bot)', () => {
    expect(onboardingNeeded({ done: false, hasUserMessages: false, agents: [{ id: 'a_1', name: 'Bot' }], mainAgentId: null }))
      .toEqual({ needed: true, adoptAgentId: 'a_1', markDone: false })
  })

  it('mainAgentId che punta ancora a un bot esistente → nessuna adozione (è già il principale)', () => {
    expect(onboardingNeeded({ done: false, hasUserMessages: false, agents: [{ id: 'a_1', name: 'Bot' }], mainAgentId: 'a_1' }))
      .toEqual({ needed: true, adoptAgentId: null, markDone: false })
  })

  it('un bot con ALTRO nome (senza «Bot») non si adotta: la chat nuova parte da zero', () => {
    expect(onboardingNeeded({ done: false, hasUserMessages: false, agents: [{ id: 'a_1', name: 'Mio bot' }], mainAgentId: null }))
      .toEqual({ needed: true, adoptAgentId: null, markDone: false })
  })
})

// ---- OA1: ensureMainBot single-flight, UN solo bot ----
describe('OA1 ensureMainBot: single-flight, un solo bot anche con la race', () => {
  const mkEnsurerDeps = (log: Log) => ({
    now: () => 1_000_000_000_000,
    getSetting: <T,>(key: string, fallback: T) => (key in log.settings ? (log.settings[key] as T) : fallback),
    setSetting: (key: string, value: unknown) => { log.settings[key] = value },
    getAgent: (id: string) => log.agents.find((a) => a.id === id) ?? null,
    createAgent: (name: string, description: string) => {
      const a: Agent = {
        id: `agent_${log.agents.length + 1}`, name, description,
        providerId: null, model: null, status: 'idle', unread: 0, createdAt: log.agents.length + 1
      }
      log.agents.push(a)
      return a
    },
    tx: <T,>(fn: () => T): T => fn()
  })

  it('due chiamate concorrenti → UN solo bot, mainAgentId scritto una volta', async () => {
    const ensurer = createMainBotEnsurer(mkEnsurerDeps(log))
    const [a, b] = await Promise.all([ensurer.ensureMainBot(), ensurer.ensureMainBot()])
    expect(log.agents).toHaveLength(1)
    expect(a.id).toBe(b.id)
    expect(log.settings['mainAgentId']).toBe(log.agents[0]!.id)
  })

  it('la chiamata DOPO la prima riusa il bot di mainAgentId (niente secondo bot)', async () => {
    const ensurer = createMainBotEnsurer(mkEnsurerDeps(log))
    const first = await ensurer.ensureMainBot()
    const second = await ensurer.ensureMainBot()
    expect(log.agents).toHaveLength(1)
    expect(second.id).toBe(first.id)
  })

  it('un riavvio a metà (ensurer NUOVO, stesso store) → riusa il bot, non ne crea un secondo', async () => {
    const first = await createMainBotEnsurer(mkEnsurerDeps(log)).ensureMainBot()
    // il daemon riparte: nuovo ensurer, mainAgentId persistito
    const second = await createMainBotEnsurer(mkEnsurerDeps(log)).ensureMainBot()
    expect(log.agents).toHaveLength(1)
    expect(second.id).toBe(first.id)
  })

  it('mainAgentId stantio (bot eliminato) → ne crea UNO nuovo e se lo segna', async () => {
    log.settings['mainAgentId'] = 'agent_sparito'
    const bot = await createMainBotEnsurer(mkEnsurerDeps(log)).ensureMainBot()
    expect(log.agents).toHaveLength(1)
    expect(log.settings['mainAgentId']).toBe(bot.id)
  })

  it("l\\'adozione: il «Bot» vuoto della beta diventa principale SENZA crearne un altro", async () => {
    const beta: Agent = { id: 'agent_beta', name: 'Bot', description: 'della beta', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }
    log.agents.push(beta)
    const bot = await createMainBotEnsurer(mkEnsurerDeps(log), 'agent_beta').ensureMainBot()
    expect(log.agents).toHaveLength(1)
    expect(bot.id).toBe('agent_beta')
    expect(log.settings['mainAgentId']).toBe('agent_beta')
  })
})

// ---- OA2: la guida a passi che si riprende (tutto PURO) ----
describe('OA2 onboardingStepSequence: la sequenza dei passi disponibili', () => {
  it('fase A: computer e memory NON ci sono ancora — la sequenza li salta (passi non disponibili su questa macchina)', () => {
    expect(onboardingStepSequence({ computer: false, memory: false }))
      .toEqual(['welcome', 'model', 'approvals', 'chat'])
  })

  it("con i passi disponibili (fasi B e C) l\\'ordine è welcome, model, computer, memory, approvals, chat", () => {
    expect(onboardingStepSequence({ computer: true, memory: true }))
      .toEqual(['welcome', 'model', 'computer', 'memory', 'approvals', 'chat'])
    expect(onboardingStepSequence({ computer: true, memory: false }))
      .toEqual(['welcome', 'model', 'computer', 'approvals', 'chat'])
    expect(onboardingStepSequence({ computer: false, memory: true }))
      .toEqual(['welcome', 'model', 'memory', 'approvals', 'chat'])
  })
})

describe('OA2 advanceOnboardingStep (pura): esito del passo e passo successivo', () => {
  const SEQ = onboardingStepSequence({ computer: false, memory: false })

  it('stato iniziale: welcome, niente fatto né saltato', () => {
    const st = initialOnboardingState(1_000, { computer: false, memory: false })
    expect(st).toEqual({ step: 'welcome', done: [], skipped: [], startedAt: 1_000 })
  })

  it('done: il passo finisce in done e si passa al successivo', () => {
    const st = advanceOnboardingStep(initialOnboardingState(1_000, { computer: false, memory: false }), 'welcome', 'done', SEQ)
    expect(st.step).toBe('model')
    expect(st.done).toEqual(['welcome'])
    expect(st.skipped).toEqual([])
    expect(st.startedAt).toBe(1_000)
  })

  it('skipped: la guida avanza lo stesso, il passo resta segnato saltato', () => {
    const st = advanceOnboardingStep(initialOnboardingState(1_000, { computer: false, memory: false }), 'welcome', 'done', SEQ)
    const st2 = advanceOnboardingStep(st, 'model', 'skipped', SEQ)
    expect(st2.step).toBe('approvals')
    expect(st2.done).toEqual(['welcome'])
    expect(st2.skipped).toEqual(['model'])
  })

  it('SOLO il passo corrente avanza: un passo diverso non cambia nulla', () => {
    const st = initialOnboardingState(1_000, { computer: false, memory: false })
    expect(advanceOnboardingStep(st, 'model', 'done', SEQ)).toEqual(st)
    // e un passo fuori sequenza nemmeno
    expect(advanceOnboardingStep(st, 'memory', 'done', SEQ)).toEqual(st)
  })

  it("l\\'ultimo passo utile porta a chat: la guida è chiusa", () => {
    let st = initialOnboardingState(1_000, { computer: false, memory: false })
    st = advanceOnboardingStep(st, 'welcome', 'done', SEQ)
    st = advanceOnboardingStep(st, 'model', 'skipped', SEQ)
    st = advanceOnboardingStep(st, 'approvals', 'done', SEQ)
    expect(st.step).toBe('chat')
  })
})

describe('OA2 reopenOnboarding (pura): riprendere i saltati, rifare da capo', () => {
  const SEQ = onboardingStepSequence({ computer: false, memory: false })
  const skippedModel = advanceOnboardingStep(
    advanceOnboardingStep(initialOnboardingState(1_000, { computer: false, memory: false }), 'welcome', 'done', SEQ),
    'model', 'skipped', SEQ
  )

  it('Riprendi: UN passo saltato diventa il corrente ed esce dai saltati', () => {
    const st = reopenOnboarding(skippedModel, 'model', SEQ, 2_000)!
    expect(st.step).toBe('model')
    expect(st.skipped).toEqual([])
    // i passi FATTI restano fatti: da lì in poi si rifà solo model
    expect(st.done).toEqual(['welcome'])
    expect(st.startedAt).toBe(1_000) // la guida NON ricomincia nel tempo
  })

  it('Riprendi su un passo NON saltato non si può (null: solo i saltati si riprendono)', () => {
    expect(reopenOnboarding(skippedModel, 'welcome', SEQ, 2_000)).toBeNull()
    expect(reopenOnboarding(skippedModel, 'approvals', SEQ, 2_000)).toBeNull()
  })

  it('Rifai da capo: stato fresco (si riparte da welcome), startedAt nuovo', () => {
    const st = reopenOnboarding(skippedModel, 'restart', SEQ, 2_000)
    expect(st).toEqual({ step: 'welcome', done: [], skipped: [], startedAt: 2_000 })
  })
})

// ---- OA3: il passo del modello si chiude da solo quando il modello c'è ----
describe('OA3 autoAdvanceOnboarding (pura): il passo model si salta da solo se il modello c\'è già', () => {
  const SEQ = onboardingStepSequence({ computer: false, memory: false })
  const atModel = advanceOnboardingStep(initialOnboardingState(1_000, { computer: false, memory: false }), 'welcome', 'done', SEQ)

  it('a model CON modello pronto → il passo è FATTO e si passa oltre (da solo)', () => {
    const st = autoAdvanceOnboarding(atModel, { modelReady: true }, SEQ)
    expect(st.step).toBe('approvals')
    expect(st.done).toEqual(['welcome', 'model'])
    expect(st.skipped).toEqual([])
  })

  it('a model SENZA modello → non si tocca: la scelta resta all\'utente', () => {
    expect(autoAdvanceOnboarding(atModel, { modelReady: false }, SEQ)).toEqual(atModel)
  })

  it('solo il passo CORRENTE si auto-avanza: a welcome non succede nulla anche col modello pronto', () => {
    const st = initialOnboardingState(1_000, { computer: false, memory: false })
    expect(autoAdvanceOnboarding(st, { modelReady: true }, SEQ)).toEqual(st)
  })

  it('i passi dopo model non si toccano mai da soli', () => {
    const st = advanceOnboardingStep(atModel, 'model', 'skipped', SEQ)
    expect(autoAdvanceOnboarding(st, { modelReady: true }, SEQ)).toEqual(st)
  })
})

describe('OA3 facciata: modelBecameReady e status con modelReady', () => {
  it('status dice modelReady quando c\'è un provider ATTIVO col modello principale', async () => {
    const onboarding = createOnboarding(deps)
    expect(onboarding.status().modelReady).toBe(false)
    log.providers.push({ id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://x', apiKey: '', enabled: true })
    log.settings['models.main'] = { providerId: 'ollama', model: 'kimi' }
    expect(onboarding.status().modelReady).toBe(true)
    // un provider SPENTO non basta
    log.providers[0]!.enabled = false
    expect(onboarding.status().modelReady).toBe(false)
  })

  it('modelBecameReady col modello che arriva chiude il passo DA SOLO (stato persistito, evento)', async () => {
    const onboarding = createOnboarding(deps)
    await onboarding.start()
    await onboarding.advance('welcome', 'done')
    expect((log.settings[ONBOARDING_STATE_SETTING] as OnboardingState).step).toBe('model')
    log.providers.push({ id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://x', apiKey: '', enabled: true })
    log.settings['models.main'] = { providerId: 'ollama', model: 'kimi' }
    const closed = onboarding.modelBecameReady()
    expect(closed).toBe(true)
    expect((log.settings[ONBOARDING_STATE_SETTING] as OnboardingState).step).toBe('approvals')
    expect((log.settings[ONBOARDING_STATE_SETTING] as OnboardingState).done).toContain('model')
  })

  it('modelBecameReady lontano dal passo model (o senza modello) non fa nulla', async () => {
    const onboarding = createOnboarding(deps)
    await onboarding.start()
    expect(onboarding.modelBecameReady()).toBe(false) // ancora a welcome
    await onboarding.advance('welcome', 'done')
    expect(onboarding.modelBecameReady()).toBe(false) // a model ma senza modello
  })

  it('startOnboarding con il modello GIÀ configurato salta model da solo (beta che aveva già il provider)', async () => {
    log.providers.push({ id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://x', apiKey: '', enabled: true })
    log.settings['models.main'] = { providerId: 'ollama', model: 'kimi' }
    const onboarding = createOnboarding(deps)
    await onboarding.start()
    await onboarding.advance('welcome', 'done')
    // il passo model si è chiuso da solo: si è già oltre
    expect((log.settings[ONBOARDING_STATE_SETTING] as OnboardingState).step).toBe('approvals')
  })
})

// ---- OA1: il bot lo crea SOLO il daemon (startOnboarding) ----
describe('OA1 startOnboarding: il bot principale lo crea solo il daemon', () => {
  it('dati vuoti → un solo bot principale con mainAgentId, evento agents e onboarding needed', async () => {
    await startOnboarding(deps)
    expect(log.agents).toHaveLength(1)
    expect(log.agents[0]!.name).toBe(MAIN_BOT_NAME)
    expect(log.settings['mainAgentId']).toBe(log.agents[0]!.id)
    expect(log.events.filter((e) => e.type === 'agents')).toHaveLength(1)
    expect(log.events.some((e) => e.type === 'onboarding' && e.needed === true)).toBe(true)
  })

  it('c\'è già un messaggio dell\'utente → NESSUN bot nuovo, onboarding.done scritto, evento not-needed', async () => {
    log.agentEntries['a_1'] = [{ id: 1, agentId: 'a_1', kind: 'message', role: 'user', content: 'ciao', meta: null, createdAt: 1 }]
    log.agents.push({ id: 'a_1', name: 'Bot', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 })
    await startOnboarding(deps)
    expect(log.agents).toHaveLength(1)
    expect(log.sends).toHaveLength(0)
    expect(log.settings[DONE_SETTING]).toBe(true)
    expect(log.events.some((e) => e.type === 'onboarding' && e.needed === false)).toBe(true)
  })

  it('onboarding.done → non fa nulla (nemmeno il widget)', async () => {
    log.settings[DONE_SETTING] = true
    await startOnboarding(deps)
    expect(log.agents).toHaveLength(0)
    expect(log.sends).toHaveLength(0)
    expect(log.events.some((e) => e.type === 'onboarding' && e.needed === false)).toBe(true)
  })

  it('il «Bot» vuoto della beta 4 viene ADOZZATO: mainAgentId = suo id, un solo agente in tutto', async () => {
    log.agents.push({ id: 'agent_beta', name: 'Bot', description: 'della beta', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 })
    await startOnboarding(deps)
    expect(log.agents).toHaveLength(1)
    expect(log.settings['mainAgentId']).toBe('agent_beta')
    expect(log.events.some((e) => e.type === 'onboarding' && e.needed === true)).toBe(true)
  })
})

// ---- OA2: lo stato persistito della guida (startOnboarding + facciata) ----
describe('OA2 startOnboarding: onboarding.state nasce qui e NON si tocca più', () => {
  it("primo avvio → onboarding.state iniziale (welcome) e l\'evento porta stato e sequenza", async () => {
    await startOnboarding(deps)
    const st = log.settings[ONBOARDING_STATE_SETTING] as OnboardingState | undefined
    expect(st).toEqual({ step: 'welcome', done: [], skipped: [], startedAt: 1_000_000_000_000 })
    expect(log.events).toContainEqual({
      type: 'onboarding', needed: true, modelReady: false, guideOpen: true,
      state: { step: 'welcome', done: [], skipped: [], startedAt: 1_000_000_000_000 },
      sequence: ['welcome', 'model', 'approvals', 'chat']
    })
  })

  it("il riavvio a metà guida RIporta allo STESSO passo (lo stato resta byte per byte)", async () => {
    await startOnboarding(deps)
    const guiata = { step: 'model', done: ['welcome'], skipped: [], startedAt: 42 } as OnboardingState
    log.settings[ONBOARDING_STATE_SETTING] = guiata
    log.agentEntries = {}
    log.sends.length = 0
    await startOnboarding(deps)
    expect(log.settings[ONBOARDING_STATE_SETTING]).toEqual(guiata)
  })
})

describe('OA2 facciata: advance e reopen persistono e dicono alla UI', () => {
  it("advance(welcome, done) → stato persistito, passo model, evento con il nuovo stato", async () => {
    const onboarding = createOnboarding(deps)
    await onboarding.start()
    const r = await onboarding.advance('welcome', 'done')
    expect(r !== false && r.state?.step).toBe('model')
    expect(log.events.at(-1)).toMatchObject({ type: 'onboarding', needed: true, state: { step: 'model' } })
  })

  it("advance su un passo che NON è il corrente → rifiutato (false), stato immutato", async () => {
    const onboarding = createOnboarding(deps)
    await onboarding.start()
    expect(await onboarding.advance('approvals', 'done')).toBe(false)
    expect((log.settings[ONBOARDING_STATE_SETTING] as OnboardingState | undefined)?.step).toBe('welcome')
  })

  it("l\'ultimo passo chiude la guida: onboarding.done scritto e evento needed resta true con step chat", async () => {
    const onboarding = createOnboarding(deps)
    await onboarding.start()
    await onboarding.advance('welcome', 'done')
    await onboarding.advance('model', 'skipped')
    const r = await onboarding.advance('approvals', 'done')
    expect(r !== false && r.state?.step).toBe('chat')
    expect(log.settings[DONE_SETTING]).toBe(true)
  })

  it("reopen(model) su un passo saltato → la guida riapre LÌ; reopen restart → da capo senza toccare bot né dati", async () => {
    const onboarding = createOnboarding(deps)
    await onboarding.start()
    await onboarding.advance('welcome', 'done')
    await onboarding.advance('model', 'skipped')
    log.settings[DONE_SETTING] = true
    const agentsBefore = log.agents.length
    const r = await onboarding.reopen('model')
    expect(r !== false && r.state?.step).toBe('model')
    expect(r !== false && r.state?.skipped).toEqual([])
    expect(log.settings[DONE_SETTING]).toBe(false)
    expect(log.agents).toHaveLength(agentsBefore) // nessun bot toccato
    const r2 = await onboarding.reopen('restart')
    expect(r2 !== false && r2.state).toMatchObject({ step: 'welcome', done: [], skipped: [], startedAt: 1_000_000_000_000 })
  })

  it("reopen su un passo non saltato → false, niente cambia", async () => {
    const onboarding = createOnboarding(deps)
    await onboarding.start()
    expect(await onboarding.reopen('model')).toBe(false)
  })
})

// ---- fase locale (L4): il widget «nessun provider» con TRE strade ----
describe('L4: providerPathsOf — la visibilità delle tre strade (pura)', () => {
  it('ordine fisso: cloud, Ollama SOLO se trovato, Integrato SOLO se non unsupported', () => {
    expect(providerPathsOf({ ollamaFound: false, eligibility: { status: 'ok' } })).toEqual(['cloud', 'local'])
    expect(providerPathsOf({ ollamaFound: true, eligibility: { status: 'ok' } })).toEqual(['cloud', 'ollama', 'local'])
    // discouraged (RAM < 16) resta visibile: si può, con l'avviso forte
    expect(providerPathsOf({ ollamaFound: false, eligibility: { status: 'discouraged' } })).toEqual(['cloud', 'local'])
    // Intel: la strada Integrato NON si offre
    expect(providerPathsOf({ ollamaFound: true, eligibility: { status: 'unsupported' } })).toEqual(['cloud', 'ollama'])
    // no-space: la strada resta (il cloud è consigliato), la scheda dirà i GB
    expect(providerPathsOf({ ollamaFound: false, eligibility: { status: 'no-space' } })).toEqual(['cloud', 'local'])
  })
})

// ---- OAC1 (fase guida, G1): la guida si vede quando è APERTA, non quando «serve» ----
// guideOpen è un campo ESPLICITO dello status, calcolato dallo stato: la
// finestra non lo ricava più da needed (che con un messaggio dell'utente è
// false anche se la guida è aperta a metà o riaperta da Impostazioni).
describe('OAC1 guideOpen: lo stato dice se la guida è aperta, qualunque sia la storia', () => {
  /** semi: stato a metà + un messaggio dell'utente nel bot principale */
  const seedMidGuideWithMessages = (): void => {
    log.settings[ONBOARDING_STATE_SETTING] = { step: 'model', done: ['welcome'], skipped: [], startedAt: 1_000_000_000_000 }
    log.settings.mainAgentId = 'a_1'
    log.agents = [{ id: 'a_1', name: 'Bot', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }]
    log.agentEntries['a_1'] = [{ id: 1, agentId: 'a_1', kind: 'message', role: 'user', content: 'ciao', meta: null, createdAt: 1 }]
  }

  it('status con guida a metà dice guideOpen: true, ANCHE con messaggi dell\'utente (needed resta false)', async () => {
    seedMidGuideWithMessages()
    const onboarding = createOnboarding(deps)
    const status = onboarding.status()
    expect(status.guideOpen).toBe(true)
    expect(status.needed).toBe(false) // needed non c'entra più con il MOSTRARE la guida
  })

  it('status senza stato (mai partita) o a chat: guideOpen false', async () => {
    const onboarding = createOnboarding(deps)
    expect(onboarding.status().guideOpen).toBe(false) // stato mai nato
    log.settings[ONBOARDING_STATE_SETTING] = { step: 'chat', done: ['welcome', 'model', 'approvals'], skipped: [], startedAt: 1 }
    expect(onboarding.status().guideOpen).toBe(false) // chiusa
  })

  it('reopen(\'restart\') con un messaggio dell\'utente → guideOpen: true, passo welcome', async () => {
    seedMidGuideWithMessages()
    log.settings[DONE_SETTING] = true // aveva finito
    const onboarding = createOnboarding(deps)
    const r = await onboarding.reopen('restart')
    expect(r !== false && r.guideOpen).toBe(true)
    expect(r !== false && r.state?.step).toBe('welcome')
  })

  it('reopen(\'model\') su un passo SALTATO con messaggi → guideOpen: true sul passo model', async () => {
    seedMidGuideWithMessages()
    log.settings[ONBOARDING_STATE_SETTING] = { step: 'approvals', done: ['welcome'], skipped: ['model'], startedAt: 1_000_000_000_000 }
    const onboarding = createOnboarding(deps)
    const r = await onboarding.reopen('model')
    expect(r !== false && r.guideOpen).toBe(true)
    expect(r !== false && r.state?.step).toBe('model')
  })

  it('boot con stato a metà e messaggi: la guida resta aperta allo STESSO passo (markDone non tocca lo stato)', async () => {
    seedMidGuideWithMessages()
    const onboarding = createOnboarding(deps)
    await onboarding.start()
    const status = onboarding.status()
    expect(status.guideOpen).toBe(true)
    expect(status.state).toEqual({ step: 'model', done: ['welcome'], skipped: [], startedAt: 1_000_000_000_000 })
    // onboarding.done si scrive (chi usa già non deve rifarla), ma lo stato NO
    expect(log.settings[DONE_SETTING]).toBe(true)
  })

  it('needed: true con stato NULL: guideOpen false (la finestra resta in caricamento, non shell vuota)', async () => {
    // dati vuoti ma stato non ancora scritto: il campo dice «non aperta», la
    // finestra capisce dal needed+state null di attendere lo splash
    const onboarding = createOnboarding(deps)
    const status = onboarding.status()
    expect(status.needed).toBe(true)
    expect(status.state).toBeNull()
    expect(status.guideOpen).toBe(false)
  })
})
