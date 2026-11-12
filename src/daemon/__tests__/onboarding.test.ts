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
  createOnboarding, startOnboarding, answerOnboardingRole, resumeOnboarding,
  onboardingNeeded, createMainBotEnsurer,
  roleTemplates, welcomeMessage, onboardingPrompt, onboardingRoleOptions,
  providerPathsOf,
  MAIN_BOT_NAME, ROLE_SETTING, PENDING_PROVIDER_SETTING, DONE_SETTING,
  type OnboardingDeps
} from '../onboarding'
import type { Agent, ProviderConfig, SendMessagePayload, SandbotEvent, TranscriptEntry } from '../../shared/types'
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
  kickstarts: Array<{ agentId: string; template: BotTemplate }>
  updates: Array<{ id: string; patch: Record<string, unknown> }>
  events: SandbotEvent[]
  /** le entry per agente, come getEntries del daemon (vuote = chat vuota) */
  agentEntries: Record<string, TranscriptEntry[]>
  nextEntryId: number
}

function mkDeps(
  log: Log,
  /** fase 9 (punto 1): l'assegnazione provider+defaultModel è iniettata */
  assignment: { providerId: string; model: string | null; warning?: string } | null = { providerId: 'ollama', model: 'kimi-k3:cloud' }
): OnboardingDeps {
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
    assignDefaultModel: async () => assignment,
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
    enqueueKickstart: (agentId, template) => { log.kickstarts.push({ agentId, template }) },
    emit: (e: SandbotEvent) => { log.events.push(e) }
  }
}

let log: Log
let deps: OnboardingDeps

beforeEach(() => {
  log = {
    settings: {}, agents: [], providers: [], sends: [], marked: [], kickstarts: [],
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

  it('l\'adozione: il «Bot» vuoto della beta diventa principale SENZA crearne un altro', async () => {
    const beta: Agent = { id: 'agent_beta', name: 'Bot', description: 'della beta', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }
    log.agents.push(beta)
    const bot = await createMainBotEnsurer(mkEnsurerDeps(log), 'agent_beta').ensureMainBot()
    expect(log.agents).toHaveLength(1)
    expect(bot.id).toBe('agent_beta')
    expect(log.settings['mainAgentId']).toBe('agent_beta')
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
    expect(log.events).toContainEqual({ type: 'onboarding', needed: true })
  })

  it('c\'è già un messaggio dell\'utente → NESSUN bot nuovo, onboarding.done scritto, evento not-needed', async () => {
    log.agentEntries['a_1'] = [{ id: 1, agentId: 'a_1', kind: 'message', role: 'user', content: 'ciao', meta: null, createdAt: 1 }]
    log.agents.push({ id: 'a_1', name: 'Bot', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 })
    await startOnboarding(deps)
    expect(log.agents).toHaveLength(1)
    expect(log.sends).toHaveLength(0)
    expect(log.settings[DONE_SETTING]).toBe(true)
    expect(log.events).toContainEqual({ type: 'onboarding', needed: false })
  })

  it('onboarding.done → non fa nulla (nemmeno il widget)', async () => {
    log.settings[DONE_SETTING] = true
    await startOnboarding(deps)
    expect(log.agents).toHaveLength(0)
    expect(log.sends).toHaveLength(0)
    expect(log.events).toContainEqual({ type: 'onboarding', needed: false })
  })

  it('il «Bot» vuoto della beta 4 viene ADOZZATO: mainAgentId = suo id, un solo agente in tutto', async () => {
    log.agents.push({ id: 'agent_beta', name: 'Bot', description: 'della beta', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 })
    await startOnboarding(deps)
    expect(log.agents).toHaveLength(1)
    expect(log.settings['mainAgentId']).toBe('agent_beta')
    expect(log.events).toContainEqual({ type: 'onboarding', needed: true })
  })
})

describe('roleTemplates: mappa ruolo → 2 template (pura)', () => {
  it('ogni ruolo dell\'onboarding mappa su due template del catalogo, distinti per coppia', () => {
    expect(roleTemplates('lavoro-codice')).toEqual(['mention-monitor', 'daily-briefing'])
    expect(roleTemplates('organizzazione-calendario')).toEqual(['meeting-prep', 'executive-assistant'])
    expect(roleTemplates('email')).toEqual(['inbox-manager', 'chief-of-staff'])
    expect(roleTemplates('ricerca-aggiornamenti')).toEqual(['mention-monitor', 'daily-briefing'])
    expect(roleTemplates('altro')).toEqual(roleTemplates('testo libero qualsiasi'))
  })

  it('i template citati esistono davvero nel catalogo', async () => {
    const { loadTemplates } = await import('../../main/templates')
    const ids = new Set(loadTemplates().map((t) => t.id))
    for (const role of ['lavoro-codice', 'organizzazione-calendario', 'email', 'ricerca-aggiornamenti', 'altro']) {
      for (const id of roleTemplates(role)) expect(ids.has(id)).toBe(true)
    }
  })
})

describe('startOnboarding: il widget del ruolo del vecchio flusso (finché la guida non lo sostituisce)', () => {
  it('nessun agente → crea il bot principale "Bot" con mainAgentId e il widget di sistema sul ruolo', async () => {
    await startOnboarding(deps)
    expect(log.agents).toHaveLength(1)
    expect(log.agents[0]).toMatchObject({ name: MAIN_BOT_NAME })
    expect(log.settings['mainAgentId']).toBe(log.agents[0]!.id)
    expect(log.sends).toHaveLength(1)
    const w = log.sends[0]!
    expect(w.agentId).toBe(log.agents[0]!.id)
    expect(w.message).toMatchObject({ type: 'widget', prompt: onboardingPrompt('it'), allowCustom: true })
    expect((w.message as { options: ReturnType<typeof onboardingRoleOptions> }).options).toEqual(onboardingRoleOptions('it'))
    expect(w.meta).toMatchObject({ onboardingRole: true })
    expect(log.events.filter((e) => e.type === 'agents')).toHaveLength(1)
  })

  it('il riavvio del daemon NON raddoppia né bot né widget (mainAgentId persistito)', async () => {
    await startOnboarding(deps)
    await startOnboarding(deps)
    expect(log.agents).toHaveLength(1)
    expect(log.sends).toHaveLength(1)
  })
})

describe('answerOnboardingRole CON provider configurato', () => {
  beforeEach(async () => {
    log.providers.push({ id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://x', apiKey: '', enabled: true })
    await startOnboarding(deps)
  })

  it('fase 17c (C4): la lingua dell’onboarding segue l’utente (userLanguage, ripiego su ui.activeLanguage)', async () => {
    const restart = async (): Promise<void> => {
      log.agents.length = 0
      log.sends.length = 0
      log.agentEntries = {}
      log.settings['onboarding.done'] = false
      await startOnboarding(deps)
    }
    // senza userLanguage e con ui.activeLanguage=en → onboarding inglese
    deleteSetting('agent.userLanguage')
    setSetting('ui.activeLanguage', 'en')
    await restart()
    let w = log.sends.find((s) => (s.message as { type?: string }).type === 'widget')
    expect((w!.message as { prompt: string }).prompt).toBe('What do you want to use me for the most?')
    // con userLanguage=en vince la lingua dell'utente anche se l'app è italiana
    setSetting('ui.activeLanguage', 'it')
    setSetting('agent.userLanguage', 'en')
    await restart()
    w = log.sends.find((s) => (s.message as { type?: string }).type === 'widget')
    expect((w!.message as { prompt: string }).prompt).toBe('What do you want to use me for the most?')
    deleteSetting('agent.userLanguage')
    setSetting('ui.activeLanguage', 'it')
    // e l'italiano resta per i test successivi (comportamento pre-17c)
    await restart()
    const wIt = log.sends.find((s) => (s.message as { type?: string }).type === 'widget')
    expect((wIt!.message as { prompt: string }).prompt).toBe('Per cosa vuoi usarmi di più?')
    // il done resta spento per la describe SENZA provider
    log.settings['onboarding.done'] = false
  })

  it('risposta "Email" → due bot da template, provider/modello assegnati, kickstart in coda, benvenuto FISSO, done', async () => {
    await new Promise<void>((r) => {
      answerOnboardingRole(deps, roleWidgetEntryId, 'email')
      // completeOnboarding è async internamente: si svuota la microtask queue
      setTimeout(r, 0)
    })
    // il widget è stato marcato risposto
    expect(log.marked).toEqual([{ agentId: log.settings['mainAgentId'], entryId: roleWidgetEntryId, value: 'email' }])
    // i due bot della mappa email, col provider e il modello PREDEFINITO assegnato
    expect(log.agents.map((a) => a.name)).toEqual([MAIN_BOT_NAME, 'Gestore della posta in arrivo', 'Capo dello staff'])
    const assigned = log.updates.filter((u) => u.patch.providerId === 'ollama')
    expect(assigned).toHaveLength(3) // principale + due nuovi
    // fase 9 (punto 1): il defaultModel, non più il primo modello dell'elenco
    expect(assigned.every((u) => u.patch.model === 'kimi-k3:cloud')).toBe(true)
    // kickstart in coda per i DUE bot da template (non per il principale)
    expect(log.kickstarts.map((k) => k.template.id)).toEqual(['inbox-manager', 'chief-of-staff'])
    // benvenuto fisso: una riga per bot
    const welcome = log.sends.find((s) => s.message.type === 'text')
    expect(welcome).toBeTruthy()
    const text = (welcome!.message as { text: string }).text
    expect(text).toContain('Gestore della posta in arrivo')
    expect(text).toContain('Capo dello staff')
    // fase 17c (C5): i campi sono Localized; la lingua dell'utente qui è italiana
    expect(welcomeMessage([{ name: 'A', description: 'dA' } as unknown as BotTemplate, { name: 'B', description: 'dB' } as unknown as BotTemplate], 'it').split('\n')).toHaveLength(3)
    expect(log.settings[DONE_SETTING]).toBe(true)
  })

  it('fase 9 (punto 1): defaultModel senza capability "tools" → nessun modello assegnato e avviso visibile', async () => {
    deps = mkDeps(log, { providerId: 'ollama', model: null, warning: 'il modello "emb-only" non supporta i tool' })
    await new Promise<void>((r) => {
      answerOnboardingRole(deps, roleWidgetEntryId, 'email')
      setTimeout(r, 0)
    })
    const assigned = log.updates.filter((u) => u.patch.providerId === 'ollama')
    expect(assigned).toHaveLength(3)
    expect(assigned.every((u) => u.patch.model === null)).toBe(true)
    // l'avviso arriva nella chat del bot principale, leggibile
    const warn = log.sends.find((s) => (s.message as { text?: string }).text?.includes('non supporta i tool'))
    expect(warn?.agentId).toBe(log.settings['mainAgentId'])
  })

  it('fase 9 (punto 1): provider senza defaultModel → provider sì, modello null (niente primo dell\'elenco)', async () => {
    deps = mkDeps(log, { providerId: 'ollama', model: null })
    await new Promise<void>((r) => {
      answerOnboardingRole(deps, roleWidgetEntryId, 'email')
      setTimeout(r, 0)
    })
    const assigned = log.updates.filter((u) => u.patch.providerId === 'ollama')
    expect(assigned.every((u) => u.patch.model === null)).toBe(true)
    expect(log.sends.some((s) => (s.message as { text?: string }).text?.includes('Attenzione'))).toBe(false)
  })
})

describe('answerOnboardingRole SENZA provider', () => {
  beforeEach(async () => {
    await startOnboarding(deps)
  })

  it('la risposta parcheggia il ruolo e mostra il widget che porta alle impostazioni del provider', async () => {
    await answerOnboardingRole(deps, roleWidgetEntryId, 'lavoro e codice (custom)')
    expect(log.settings[ROLE_SETTING]).toBe('lavoro e codice (custom)')
    expect(log.settings[PENDING_PROVIDER_SETTING]).toBe(true)
    expect(log.settings[DONE_SETTING]).toBeUndefined()
    // NESSUN bot creato, nessun kickstart
    expect(log.agents).toHaveLength(1)
    expect(log.kickstarts).toHaveLength(0)
    // il widget del provider: system, meta onboardingProvider
    const providerWidget = log.sends.find((s) => s.meta?.onboardingProvider)
    expect(providerWidget).toBeTruthy()
    expect((providerWidget!.message as { options: Array<{ value: string }> }).options[0]!.value).toBe('open-provider-settings')
  })

  it('resumeOnboarding: senza provider non fa nulla; col provider completa e consuma il pending', async () => {
    await answerOnboardingRole(deps, roleWidgetEntryId, 'email')
    expect(await resumeOnboarding(deps)).toBe(false) // ancora nessun provider
    expect(log.agents).toHaveLength(1)
    // arriva il provider (salvataggio dalle impostazioni)
    log.providers.push({ id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://x', apiKey: '', enabled: true })
    expect(await resumeOnboarding(deps)).toBe(true)
    expect(log.agents.map((a) => a.name)).toContain('Capo dello staff')
    expect(log.kickstarts).toHaveLength(2)
    expect(log.settings[DONE_SETTING]).toBe(true)
    expect(log.settings[PENDING_PROVIDER_SETTING]).toBe(false)
    // già completato: il resume successivo non rifà nulla
    log.kickstarts.length = 0
    expect(await resumeOnboarding(deps)).toBe(false)
    expect(log.kickstarts).toHaveLength(0)
  })

  it('provider NON attivo (enabled false) non conta come configurato', async () => {
    answerOnboardingRole(deps, roleWidgetEntryId, 'email')
    log.providers.push({ id: 'p', name: 'spento', kind: 'custom', baseUrl: 'http://x', apiKey: '', enabled: false })
    expect(await resumeOnboarding(deps)).toBe(false)
    expect(log.kickstarts).toHaveLength(0)
  })
})

describe('createOnboarding (facciata cablata nel daemon)', () => {
  it('espone start/answerRole/resume/status sugli stessi deps', async () => {
    const onboarding = createOnboarding(deps)
    await onboarding.start()
    expect(log.agents).toHaveLength(1)
    log.providers.push({ id: 'p', name: 'P', kind: 'custom', baseUrl: 'http://x', apiKey: '', enabled: true })
    onboarding.answerRole(1, 'email')
    expect(log.settings[ROLE_SETTING]).toBe('email')
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

describe('L4: il widget del provider senza configurazione offre le tre strade', () => {
  const withLocalDeps = (
    ollamaFound: boolean,
    arch = 'arm64'
  ): OnboardingDeps => ({
    ...deps,
    discoverLocalProviders: async () => (ollamaFound ? [{ kind: 'ollama' }] : []),
    localEligibilityFacts: () => ({ arch, ramGb: arch === 'arm64' ? 36 : 16, freeDiskBytes: null })
  })

  const widgetOf = (send: { message: SendMessagePayload; meta?: Record<string, unknown> }) =>
    send.message as { prompt: string; helpText?: string; options: Array<{ label: string; value: string; style?: string }> }

  it('cloud PRIMO (consigliato), poi Ollama trovato, poi Integrato — e l’avviso onesto', async () => {
    const d = withLocalDeps(true)
    await answerOnboardingRole(d, roleWidgetEntryId, 'email')
    const w = log.sends.find((s) => (s.message as { type?: string }).type === 'widget' && s.meta?.onboardingProvider)
    expect(w).toBeTruthy()
    const opts = widgetOf(w!).options
    expect(opts.map((o) => o.value)).toEqual(['open-provider-settings', 'open-ollama', 'open-local-model'])
    expect(opts[0]!.style).toBe('primary')
    // l'avviso onesto dell'Integrato (idea esatta della spec, IT)
    expect(widgetOf(w!).helpText).toContain('i dati restano qui')
    expect(widgetOf(w!).helpText).toContain('più lento')
    expect(widgetOf(w!).helpText).toContain('modello cloud')
    // resta parcheggiato: pendingProvider acceso, ripresa come oggi
    expect(log.settings[PENDING_PROVIDER_SETTING]).toBe(true)
  })

  it('Ollama NON trovato → la strada NON si offre; Intel → niente Integrato', async () => {
    await answerOnboardingRole(withLocalDeps(false), roleWidgetEntryId, 'email')
    let w = log.sends.find((s) => (s.message as { type?: string }).type === 'widget' && s.meta?.onboardingProvider)
    expect(widgetOf(w!).options.map((o) => o.value)).toEqual(['open-provider-settings', 'open-local-model'])

    log.sends.length = 0
    log.marked.length = 0
    await answerOnboardingRole(withLocalDeps(true, 'x64'), roleWidgetEntryId, 'email')
    w = log.sends.find((s) => (s.message as { type?: string }).type === 'widget' && s.meta?.onboardingProvider)
    expect(widgetOf(w!).options.map((o) => o.value)).toEqual(['open-provider-settings', 'open-ollama'])
    // e senza l'Integrato l'avviso onesto non serve
    expect(widgetOf(w!).helpText).not.toContain('i dati restano qui')
  })
})
