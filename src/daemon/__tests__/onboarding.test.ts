// Test dell'onboarding al primo avvio (fase 7): nessun agente → bot principale
// "Bot" + widget DI SISTEMA sul ruolo; la risposta crea i due bot da template
// (kickstart in coda) col benvenuto FISSO; senza provider l'onboarding si
// ferma sul widget delle impostazioni e riprende quando un provider è attivo.
// Dipendenze registrate (niente LLM, niente rete): l'"LLM finto" non serve,
// il kickstart vero partirà come job della coda sui bot creati.
import { describe, expect, it, beforeEach } from 'vitest'
import {
  createOnboarding, maybeStartOnboarding, answerOnboardingRole, resumeOnboarding,
  roleTemplates, welcomeMessage, onboardingPrompt, onboardingRoleOptions,
  providerPathsOf,
  MAIN_BOT_NAME, ROLE_SETTING, PENDING_PROVIDER_SETTING, DONE_SETTING,
  type OnboardingDeps
} from '../onboarding'
import type { Agent, ProviderConfig, SendMessagePayload, SandbotEvent } from '../../shared/types'
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
  events: string[]
  entries: Array<{ id: number; agentId: string; meta: Record<string, unknown> | null }>
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
    appendSystemSend: (agentId, message, meta) => { log.sends.push({ agentId, message, meta }) },
    markWidgetResponded: (agentId, entryId, value) => { log.marked.push({ agentId, entryId, value }) },
    enqueueKickstart: (agentId, template) => { log.kickstarts.push({ agentId, template }) },
    emit: (e: SandbotEvent) => { log.events.push(e.type) }
  }
}

let log: Log
let deps: OnboardingDeps

beforeEach(() => {
  log = {
    settings: {}, agents: [], providers: [], sends: [], marked: [], kickstarts: [],
    updates: [], events: [], entries: [], nextEntryId: 1
  }
  deps = mkDeps(log)
})

// il widget del ruolo viene da una entry send-message di sistema: id noto per i test
const roleWidgetEntryId = 7

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

describe('maybeStartOnboarding: primo avvio', () => {
  it('nessun agente → crea il bot principale "Bot" con mainAgentId e il widget di sistema sul ruolo', () => {
    maybeStartOnboarding(deps)
    expect(log.agents).toHaveLength(1)
    expect(log.agents[0]).toMatchObject({ name: MAIN_BOT_NAME })
    expect(log.settings['mainAgentId']).toBe(log.agents[0]!.id)
    expect(log.sends).toHaveLength(1)
    const w = log.sends[0]!
    expect(w.agentId).toBe(log.agents[0]!.id)
    expect(w.message).toMatchObject({ type: 'widget', prompt: onboardingPrompt('it'), allowCustom: true })
    expect((w.message as { options: ReturnType<typeof onboardingRoleOptions> }).options).toEqual(onboardingRoleOptions('it'))
    expect(w.meta).toMatchObject({ onboardingRole: true })
    expect(log.events).toContain('agents')
  })

  it('con agenti esistenti o onboarding già fatto non fa nulla (idempotente)', () => {
    log.agents.push({ id: 'a_x', name: 'Esistente', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 })
    maybeStartOnboarding(deps)
    expect(log.agents).toHaveLength(1)
    expect(log.sends).toHaveLength(0)
    // done → mai più, nemmeno a dati vuoti di nuovo
    log.agents.length = 0
    log.settings[DONE_SETTING] = true
    maybeStartOnboarding(deps)
    expect(log.agents).toHaveLength(0)
  })
})

describe('answerOnboardingRole CON provider configurato', () => {
  beforeEach(() => {
    log.providers.push({ id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://x', apiKey: '', enabled: true })
    maybeStartOnboarding(deps)
  })

  it('fase 17c (C4): la lingua dell’onboarding segue l’utente (userLanguage, ripiego su ui.activeLanguage)', () => {
    const restart = (): void => {
      log.agents.length = 0
      log.sends.length = 0
      log.settings['onboarding.done'] = false
      maybeStartOnboarding(deps)
    }
    // senza userLanguage e con ui.activeLanguage=en → onboarding inglese
    deleteSetting('agent.userLanguage')
    setSetting('ui.activeLanguage', 'en')
    restart()
    let w = log.sends.find((s) => (s.message as { type?: string }).type === 'widget')
    expect((w!.message as { prompt: string }).prompt).toBe('What do you want to use me for the most?')
    // con userLanguage=en vince la lingua dell'utente anche se l'app è italiana
    setSetting('ui.activeLanguage', 'it')
    setSetting('agent.userLanguage', 'en')
    restart()
    w = log.sends.find((s) => (s.message as { type?: string }).type === 'widget')
    expect((w!.message as { prompt: string }).prompt).toBe('What do you want to use me for the most?')
    deleteSetting('agent.userLanguage')
    setSetting('ui.activeLanguage', 'it')
    // e l'italiano resta per i test successivi (comportamento pre-17c)
    restart()
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
  beforeEach(() => {
    maybeStartOnboarding(deps)
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
  it('espone maybeStart/answerRole/resume sugli stessi deps', () => {
    const onboarding = createOnboarding(deps)
    onboarding.maybeStart()
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
