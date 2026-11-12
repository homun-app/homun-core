// Onboarding al primo avvio. OA1 (fase onboarding-a): UNA sola strada per il
// primo avvio — il main NON crea più «Bot» (index.ts), lo crea SOLO il daemon
// qui dentro, con ensureMainBot single-flight e la transazione di
// mainAgentId; onboardingNeeded (pura) decide chi lo fa, ADOZIONE del «Bot»
// vuoto delle beta 1–4 compresa. Il flusso vecchio (fase 7: widget del ruolo,
// due bot da template col kickstart, benvenuto fisso, widget del provider e
// ripresa) resta finché la guida a passi di OA2+ non lo sostituisce.
// Tutto a dipendenze iniettabili: nei test niente LLM, niente rete.
import type { Agent, OnboardingState, OnboardingStatus, OnboardingStepId, ProviderConfig, SendMessagePayload, SandbotEvent, TranscriptEntry, WidgetOption } from '../shared/types'
import type { BotTemplate } from '../shared/types'
import { templateById } from '../main/templates'
// fase 17c (C4): i testi dell'onboarding sono messaggi del BOT all'utente —
// si scrivono con formatUi(…, currentUserLanguage()) e si salvano come testo
// (contenuto dell'utente, niente meta.ui)
import { currentUserLanguage } from '../main/agent/user-language'
import { formatUi, ui } from '../shared/ui-text'
import { UI } from '../shared/ui-messages'
import { pickLang } from '../shared/localized'
// fase locale (L4): l'idoneità della macchina per la strada «Integrato»
import { localEligibility } from '../main/agent/local-catalog'
import type { Lang } from '../shared/language'

/** Il nome del bot principale creato dall'onboarding. */
export const MAIN_BOT_NAME = 'Bot'
/** La descrizione del bot principale nella lingua dell'utente (C4). */
export function mainBotDescription(lang: Lang): string {
  return formatUi(ui(UI.onboardingMainBotDescription), lang)
}

export const ROLE_SETTING = 'onboarding.role'
export const PENDING_PROVIDER_SETTING = 'onboarding.pendingProvider'
export const DONE_SETTING = 'onboarding.done'

// ---- OA2 (fase onboarding-a): la guida a passi che si riprende ----

/** Il setting dove vive lo stato della guida (persistito, come i fatti). */
export const ONBOARDING_STATE_SETTING = 'onboarding.state'

/**
 * La sequenza dei passi della guida (PURA): i passi non disponibili su
 * questa macchina non ci sono — in fase A computer e memory non esistono
 * ancora (arrivano con le fasi B e C), e la guida li salta senza segnarli
 * né fatti né saltati. «chat» è la coda: la guida è chiusa e si entra nella
 * chat del bot principale.
 */
export function onboardingStepSequence(available: { computer: boolean; memory: boolean }): OnboardingStepId[] {
  return [
    'welcome',
    'model',
    ...(available.computer ? (['computer'] as OnboardingStepId[]) : []),
    ...(available.memory ? (['memory'] as OnboardingStepId[]) : []),
    'approvals',
    'chat'
  ]
}

/** Lo stato iniziale della guida: dal primo passo della sequenza. */
export function initialOnboardingState(now: number, available: { computer: boolean; memory: boolean }): OnboardingState {
  return { step: onboardingStepSequence(available)[0]!, done: [], skipped: [], startedAt: now }
}

/**
 * L'esito di un passo (PURA): SOLO il passo corrente avanza; l'esito finisce
 * in done o skipped (e esce dall'altro elenco), il passo diventa il prossimo
 * della sequenza. Un passo che non è il corrente, o che non è in sequenza,
 * non cambia nulla: la guida non si salta da sola.
 */
export function advanceOnboardingStep(
  state: OnboardingState,
  step: OnboardingStepId,
  outcome: 'done' | 'skipped',
  sequence: readonly OnboardingStepId[]
): OnboardingState {
  if (state.step !== step) return state
  const idx = sequence.indexOf(step)
  if (idx === -1) return state
  const done = state.done.filter((s) => s !== step)
  const skipped = state.skipped.filter((s) => s !== step)
  return {
    step: sequence[idx + 1] ?? 'chat',
    done: outcome === 'done' ? [...done, step] : done,
    skipped: outcome === 'skipped' ? [...skipped, step] : skipped,
    startedAt: state.startedAt
  }
}

/**
 * Riaprire la guida (PURA): «Riprendi» solo su un passo SALTATO (diventa il
 * corrente ed esce dai saltati; i fatti restano fatti); «Rifai da capo»
 * (target 'restart') rimette SOLO lo stato — niente bot né dati toccati —
 * con startedAt nuovo.
 */
export function reopenOnboarding(
  state: OnboardingState,
  target: OnboardingStepId | 'restart',
  sequence: readonly OnboardingStepId[],
  now: number
): OnboardingState | null {
  if (target === 'restart') {
    return { step: sequence[0]!, done: [], skipped: [], startedAt: now }
  }
  if (!state.skipped.includes(target) || !sequence.includes(target)) return null
  return { ...state, step: target, skipped: state.skipped.filter((s) => s !== target) }
}

/**
 * OA3: le strade del passo modello per QUESTA macchina (cloud consigliato,
 * Ollama solo se la scoperta lo trova, Integrato solo se la macchina è
 * idonea). Asincrona per la scoperta: la chiama la RPC onboarding:state.
 */
export async function guideProviderPaths(deps: OnboardingDeps): Promise<Array<'cloud' | 'ollama' | 'local'>> {
  let ollamaFound = false
  try {
    ollamaFound = (await deps.discoverLocalProviders?.() ?? []).some((p) => p.kind === 'ollama')
  } catch {
    ollamaFound = false
  }
  const facts = deps.localEligibilityFacts?.() ?? { arch: 'arm64', ramGb: 16, freeDiskBytes: null }
  return providerPathsOf({ ollamaFound, eligibility: localEligibility(facts) })
}

/**
 * OA3 (PURA): il passo del modello si chiude DA SOLO quando il modello c'è
 * già (un provider attivo col modello principale): il passo è FATTO, non
 * saltato. Vale SOLO per il passo corrente: gli altri passi non si toccano.
 */
export function autoAdvanceOnboarding(
  state: OnboardingState,
  facts: { modelReady: boolean },
  sequence: readonly OnboardingStepId[]
): OnboardingState {
  if (state.step !== 'model' || !facts.modelReady) return state
  return advanceOnboardingStep(state, 'model', 'done', sequence)
}

// ---- OA1 (fase onboarding-a): chi fa l'onboarding, e UN solo bot ----

/** I fatti che decidono se l'onboarding serve (tutti leggibili, nessun effetto). */
export interface OnboardingFacts {
  done: boolean
  /** true se esiste almeno un messaggio dell'utente in un qualunque bot */
  hasUserMessages: boolean
  agents: Array<{ id: string; name: string }>
  mainAgentId: string | null
}

/** La decisione di onboardingNeeded (pura). */
export interface OnboardingDecision {
  needed: boolean
  /** il bot da ADOZZARE come principale (il «Bot» vuoto delle beta 1–4), se c'è */
  adoptAgentId: string | null
  /** scrivere onboarding.done: chi usa già Homun non deve rifare l'onboarding */
  markDone: boolean
}

/**
 * OA1 (pura): decide se questo primo avvio fa l'onboarding. La risposta è
 * «sì» solo se l'utente non ha MAI usato Homun (nessun suo messaggio in
 * nessun bot) e l'onboarding non è già fatto — anche se esiste già un «Bot»
 * vuoto creato dal main nelle beta 1–4: quel bot si ADOTTA come principale
 * invece di crearne un secondo. mainAgentId che punta ancora a un bot
 * esistente non ha bisogno di adozione (è già il principale).
 */
export function onboardingNeeded(facts: OnboardingFacts): OnboardingDecision {
  if (facts.done) return { needed: false, adoptAgentId: null, markDone: false }
  if (facts.hasUserMessages) return { needed: false, adoptAgentId: null, markDone: true }
  const mainOk = facts.mainAgentId !== null && facts.agents.some((a) => a.id === facts.mainAgentId)
  if (mainOk) return { needed: true, adoptAgentId: null, markDone: false }
  const betaBot = facts.agents.find((a) => a.name === MAIN_BOT_NAME) ?? null
  return { needed: true, adoptAgentId: betaBot?.id ?? null, markDone: false }
}

/** Il messaggio è dell'utente (la stessa chiave della storia: kind message, role user). */
function isUserEntry(e: { kind: string; role: string }): boolean {
  return e.kind === 'message' && e.role === 'user'
}

/** Le dipendenze di ensureMainBot (iniettabili, niente DB diretto). */
export interface EnsureMainBotDeps {
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  getAgent(id: string): Agent | null
  createAgent(name: string, description: string): Agent
  /**
   * Transazione attorno a creazione + mainAgentId: un riavvio a metà non
   * lascia mai un bot senza mainAgentId (che ne farebbe nascere un secondo).
   */
  tx<T>(fn: () => T): T
}

export interface MainBotEnsurer {
  /** Il bot principale, creato UNA volta sola anche con chiamate concorrenti. */
  ensureMainBot(adopt?: string | null): Promise<Agent>
}

/**
 * OA1 (come first-bot.tsx di Rakazo): il primo bot è IDEMPOTENTE —
 * single-flight (una promessa condivisa: i doppi mount non creano doppioni),
 * riusa il bot in mainAgentId se esiste ancora, adotta quello indicato se il
 * main l'aveva già creato (beta 1–4), altrimenti lo crea e salva mainAgentId
 * nella STESSA transazione. Due chiamate concorrenti, o un riavvio a metà,
 * producono un solo bot.
 */
export function createMainBotEnsurer(deps: EnsureMainBotDeps, adopt: string | null = null): MainBotEnsurer {
  let inflight: Promise<Agent> | null = null
  return {
    ensureMainBot(overrideAdopt?: string | null): Promise<Agent> {
      if (inflight) return inflight
      const adoptId = overrideAdopt !== undefined ? overrideAdopt : adopt
      inflight = (async () => {
        const saved = deps.getSetting<string | null>('mainAgentId', null)
        const existing = saved ? deps.getAgent(saved) : null
        if (existing) return existing
        const toAdopt = adoptId ? deps.getAgent(adoptId) : null
        if (toAdopt) {
          deps.setSetting('mainAgentId', toAdopt.id)
          return toAdopt
        }
        const lang = currentUserLanguage()
        return deps.tx(() => {
          const a = deps.createAgent(MAIN_BOT_NAME, mainBotDescription(lang))
          deps.setSetting('mainAgentId', a.id)
          return a
        })
      })().finally(() => { inflight = null })
      return inflight
    }
  }
}

/** La domanda del widget di sistema (§3ter T3): 4 opzioni + testo libero (nella lingua dell'utente). */
export function onboardingPrompt(lang: Lang): string {
  return formatUi(ui(UI.onboardingPrompt), lang)
}
export function onboardingRoleOptions(lang: Lang): WidgetOption[] {
  // i value restano CODICI (li legge roleTemplates), le label si traducono
  return [
    { label: formatUi(ui(UI.onboardingRoleWork), lang), value: 'lavoro-codice' },
    { label: formatUi(ui(UI.onboardingRoleOrg), lang), value: 'organizzazione-calendario' },
    { label: formatUi(ui(UI.onboardingRoleEmail), lang), value: 'email' },
    { label: formatUi(ui(UI.onboardingRoleSearch), lang), value: 'ricerca-aggiornamenti' }
  ]
}

/**
 * La mappa ruolo → 2 template (pura): decide quali bot nascono dall'onboarding.
 * Risposte libere o non riconosciute cadono sulla coppia predefinita.
 */
export function roleTemplates(role: string): [string, string] {
  switch (role) {
    case 'lavoro-codice':
    case 'ricerca-aggiornamenti':
      return ['mention-monitor', 'daily-briefing']
    case 'organizzazione-calendario':
      return ['meeting-prep', 'executive-assistant']
    case 'email':
      return ['inbox-manager', 'chief-of-staff']
    default: // "altro" o testo libero
      return ['inbox-manager', 'daily-briefing']
  }
}

/** Il messaggio FISSO di benvenuto: presenta i nuovi bot in una riga ciascuno (nella lingua dell'utente, nomi/descrizioni dei template compresi). */
export function welcomeMessage(templates: BotTemplate[], lang: Lang): string {
  const lines = templates.map((t) => formatUi(ui(UI.onboardingWelcomeLine, { name: pickLang(t.name, lang), description: pickLang(t.description, lang) }), lang))
  return [formatUi(ui(UI.onboardingWelcomeHead), lang), ...lines].join('\n')
}

export interface OnboardingDeps {
  now(): number
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  listAgents(): Agent[]
  createAgent(name: string, description: string): Agent
  /** OA1: il singolo agente, per riusare/adottare il bot principale. */
  getAgent(id: string): Agent | null
  /** OA1: le entry di un agente, per vedere se l'utente ha già scritto. */
  getEntries(agentId: string): TranscriptEntry[]
  /** OA1: la transazione di ensureMainBot (creazione + mainAgentId). */
  tx<T>(fn: () => T): T
  /** OA1: l'ensure single-flight del bot principale (se il wiring ne ha già uno). */
  ensureMainBot?: (adopt: string | null) => Promise<Agent>
  /**
   * OA2: quali passi extra esistono su questa macchina. In fase A computer e
   * memory non ci sono ancora: default { computer: false, memory: false }.
   */
  stepAvailability?: () => { computer: boolean; memory: boolean }
  updateAgent(id: string, patch: { providerId?: string | null; model?: string | null }): void
  listProviders(): ProviderConfig[]
  /** Fase 9 (punto 1): provider attivo + defaultModel (con capability "tools"). */
  assignDefaultModel(): Promise<{ providerId: string; model: string | null; warning?: string } | null>
  /** Entry visibile creata dal sistema (non dal modello), come il look-around. */
  appendSystemSend(agentId: string, message: SendMessagePayload, meta?: Record<string, unknown>): void
  /** Segna il widget risposto (respondedValue) e lo rimanda alla UI. */
  markWidgetResponded(agentId: string, entryId: number, value: string | string[]): void
  /** Accoda il job del kickstart di un bot da template (initiator TEMPLATE_IMPORT). */
  enqueueKickstart(agentId: string, template: BotTemplate): void
  emit(e: SandbotEvent): void
  /**
   * Fase locale (L4): la scoperta dei servizi locali, per la strada Ollama del
   * widget del provider (solo se lo trova). Facoltativa: senza, la strada non
   * si offre.
   */
  discoverLocalProviders?: () => Promise<Array<{ kind: string }>>
  /** Fase locale (L4): i fatti della macchina per la strada Integrato (default: Mac idoneo). */
  localEligibilityFacts?: () => { arch: string; ramGb: number; freeDiskBytes: number | null }
}

/** C'è almeno un provider attivo? (senza provider i bot non possono pensare) */
function providerConfigured(deps: OnboardingDeps): boolean {
  return deps.listProviders().some((p) => p.enabled)
}

/** I passi disponibili su questa macchina (fase A: computer e memory mai). */
function availabilityOf(deps: OnboardingDeps): { computer: boolean; memory: boolean } {
  return deps.stepAvailability?.() ?? { computer: false, memory: false }
}

/** Lo stato persistito della guida, se è mai partita. */
function stateOf(deps: OnboardingDeps): OnboardingState | null {
  const raw = deps.getSetting<OnboardingState | null>(ONBOARDING_STATE_SETTING, null)
  if (!raw || typeof raw !== 'object' || typeof raw.step !== 'string') return null
  return raw
}

/** OA3: c'è già un modello utilizzabile? (provider ATTIVO + models.main) */
function modelReadyOf(deps: OnboardingDeps): boolean {
  const main = deps.getSetting<import('../shared/types').MainModel | null>('models.main', null)
  if (!main) return false
  return deps.listProviders().some((p) => p.id === main.providerId && p.enabled)
}

/** Lo status completo per RPC ed eventi (nessun effetto). */
function statusOf(deps: OnboardingDeps): OnboardingStatus {
  const decision = onboardingNeeded(onboardingFactsOf(deps))
  return {
    needed: decision.needed,
    state: stateOf(deps),
    sequence: onboardingStepSequence(availabilityOf(deps)),
    modelReady: modelReadyOf(deps)
  }
}

/** I fatti del primo avvio, dai deps (nessun effetto: si può chiamare per uno status). */
export function onboardingFactsOf(deps: OnboardingDeps): OnboardingFacts {
  return {
    done: deps.getSetting<boolean>(DONE_SETTING, false),
    hasUserMessages: deps.listAgents().some((a) => deps.getEntries(a.id).some(isUserEntry)),
    agents: deps.listAgents().map((a) => ({ id: a.id, name: a.name })),
    mainAgentId: deps.getSetting<string | null>('mainAgentId', null)
  }
}

/**
 * OA1: il primo avvio ha UNA sola strada. Il main NON crea più «Bot»: lo crea
 * (o adotta) SOLO il daemon, qui — con l'ensure single-flight, così la race
 * col main e i doppi start non fanno nascere due bot. Chi ha già scritto in
 * chat non rifà l'onboarding (e onboarding.done si scrive qui, una volta per
 * tutte). Il widget del ruolo del vecchio flusso resta finché la guida a
 * passi non lo sostituisce: solo se la chat del bot è ancora vuota.
 */
export async function startOnboarding(deps: OnboardingDeps): Promise<void> {
  const decision = onboardingNeeded(onboardingFactsOf(deps))
  if (!decision.needed) {
    if (decision.markDone) deps.setSetting(DONE_SETTING, true)
    deps.emit({ type: 'onboarding', ...statusOf(deps) })
    return
  }
  const ensurer = deps.ensureMainBot
    ? { ensureMainBot: (adopt: string | null) => deps.ensureMainBot!(adopt) }
    : createMainBotEnsurer(deps)
  const main = await ensurer.ensureMainBot(decision.adoptAgentId)
  // OA2: lo stato della guida nasce qui e NON si tocca più — chiudere l'app
  // a metà e riaprirla riporta allo stesso passo.
  // OA3: se il modello c'è GIÀ (per esempio una beta col provider), il passo
  // model si chiude da solo prima di mostrarsi
  const sequence = onboardingStepSequence(availabilityOf(deps))
  const state = stateOf(deps) ?? initialOnboardingState(deps.now(), availabilityOf(deps))
  const auto = autoAdvanceOnboarding(state, { modelReady: modelReadyOf(deps) }, sequence)
  deps.setSetting(ONBOARDING_STATE_SETTING, auto)
  deps.emit({ type: 'agents' })
  deps.emit({ type: 'onboarding', ...statusOf(deps) })
  // il widget del ruolo del vecchio flusso: solo se la chat è ancora vuota
  // (nessuna send di sistema: niente widget doppio ai riavvii)
  if (!deps.getEntries(main.id).some((e) => e.kind === 'send-message')) {
    const lang = currentUserLanguage()
    deps.appendSystemSend(main.id, {
      type: 'widget',
      prompt: onboardingPrompt(lang),
      options: onboardingRoleOptions(lang),
      allowCustom: true,
      helpText: formatUi(ui(UI.onboardingHelp), lang)
    }, { onboardingRole: true })
  }
}

/**
 * Fase locale (L4), pura: le strade del widget «nessun provider», in ordine —
 * cloud con chiave (consigliato), Ollama SOLO se la scoperta lo trova,
 * Integrato sul Mac SOLO se l'idoneità non è unsupported (con RAM < 16 si può
 * installare: la scheda mostra l'avviso forte).
 */
export function providerPathsOf(f: {
  ollamaFound: boolean
  eligibility: { status: 'ok' | 'discouraged' | 'unsupported' | 'no-space' }
}): Array<'cloud' | 'ollama' | 'local'> {
  const out: Array<'cloud' | 'ollama' | 'local'> = ['cloud']
  if (f.ollamaFound) out.push('ollama')
  if (f.eligibility.status !== 'unsupported') out.push('local')
  return out
}

/**
 * La risposta al widget del ruolo: salva il ruolo e completa subito, oppure —
 * senza provider — si ferma col widget delle TRE strade (L4): cloud con chiave
 * (consigliato), Ollama se trovato, Integrato se la macchina è idonea. La
 * ripresa avviene a providers:save, all'installazione dell'Integrato o al
 * prossimo avvio.
 */
export async function answerOnboardingRole(deps: OnboardingDeps, entryId: number, value: string | string[]): Promise<void> {
  const role = (Array.isArray(value) ? value[0] : value) ?? ''
  deps.setSetting(ROLE_SETTING, role)
  deps.markWidgetResponded(deps.getSetting<string | null>('mainAgentId', null) ?? '', entryId, value)
  if (providerConfigured(deps)) {
    await completeOnboarding(deps, role)
  } else {
    deps.setSetting(PENDING_PROVIDER_SETTING, true)
    const main = deps.getSetting<string | null>('mainAgentId', null) ?? ''
    const lang = currentUserLanguage()
    let ollamaFound = false
    try {
      ollamaFound = (await deps.discoverLocalProviders?.() ?? []).some((p) => p.kind === 'ollama')
    } catch {
      ollamaFound = false
    }
    const facts = deps.localEligibilityFacts?.() ?? { arch: 'arm64', ramGb: 16, freeDiskBytes: null }
    const paths = providerPathsOf({ ollamaFound, eligibility: localEligibility(facts) })
    const optionOf = (v: 'open-provider-settings' | 'open-ollama' | 'open-local-model', labelId: typeof UI.onboardingProviderButton, primary = false) => ({
      label: formatUi(ui(labelId), lang),
      value: v,
      ...(primary ? { style: 'primary' as const } : {})
    })
    deps.appendSystemSend(main, {
      type: 'widget',
      prompt: formatUi(ui(UI.onboardingProviderPrompt), lang),
      // l'avviso onesto serve solo quando c'è la strada Integrato
      ...(paths.includes('local')
        ? { helpText: formatUi(ui(UI.onboardingLocalModelHonest), lang) }
        : { helpText: formatUi(ui(UI.onboardingProviderHelp), lang) }),
      options: [
        optionOf('open-provider-settings', UI.onboardingProviderButton, true),
        ...(paths.includes('ollama') ? [optionOf('open-ollama', UI.onboardingProviderOllama)] : []),
        ...(paths.includes('local') ? [optionOf('open-local-model', UI.onboardingProviderLocal)] : [])
      ]
    }, { onboardingProvider: true })
  }
}

/**
 * Riprende l'onboarding parcheggiato sul provider: chiamata a providers:save e
 * all'avvio del daemon. True se ha completato ora.
 */
export async function resumeOnboarding(deps: OnboardingDeps): Promise<boolean> {
  if (!deps.getSetting<boolean>(PENDING_PROVIDER_SETTING, false)) return false
  if (deps.getSetting<boolean>(DONE_SETTING, false)) return false
  if (!providerConfigured(deps)) return false
  const role = deps.getSetting<string>(ROLE_SETTING, '')
  await completeOnboarding(deps, role)
  return true
}

/**
 * Completa l'onboarding: i due bot da template (col kickstart in coda) e il
 * benvenuto FISSO del bot principale. Fase 9 (punto 1): ai bot va il
 * MODELLO PREDEFINITO del provider (capability "tools" verificata), non più
 * il primo modello dell'elenco; senza default configurato il bot resta senza
 * modello e la prima chat dirà di configurarlo.
 */
export async function completeOnboarding(deps: OnboardingDeps, role: string): Promise<void> {
  const assignment = await deps.assignDefaultModel()
  const mainId = deps.getSetting<string | null>('mainAgentId', null)
  if (mainId && assignment) deps.updateAgent(mainId, { providerId: assignment.providerId, model: assignment.model })

  const lang = currentUserLanguage()
  const templates = roleTemplates(role)
    .map((id) => templateById(id))
    .filter((t): t is BotTemplate => !!t)
  for (const t of templates) {
    // fase 17c (C5): il bot nasce col nome/descrizione nella lingua
    // dell'utente (contenuto dell'utente, modificabile)
    const a = deps.createAgent(pickLang(t.name, lang), pickLang(t.description, lang))
    if (assignment) deps.updateAgent(a.id, { providerId: assignment.providerId, model: assignment.model })
    deps.enqueueKickstart(a.id, t)
  }
  if (mainId) {
    deps.appendSystemSend(mainId, { type: 'text', text: welcomeMessage(templates, lang) })
    // il default non è assegnabile (niente capability "tools"): lo dice qui,
    // così l'utente sa perché i bot non rispondono finché non sistema il modello
    if (assignment?.warning) {
      deps.appendSystemSend(mainId, {
        type: 'text',
        text: formatUi(ui(UI.onboardingModelWarning, { warning: assignment.warning }), lang)
      })
    }
  }
  deps.setSetting(PENDING_PROVIDER_SETTING, false)
  deps.setSetting(DONE_SETTING, true)
  deps.emit({ type: 'agents' })
}

export function createOnboarding(deps: OnboardingDeps) {
  return {
    start: () => startOnboarding(deps),
    /** OA3: le strade del passo modello per questa macchina (RPC onboarding:state). */
    providerPaths: () => guideProviderPaths(deps),
    /** OA1/OA2: lo stato per la finestra — finché non lo dice il daemon, la UI carica. */
    status: (): OnboardingStatus => statusOf(deps),
    /**
     * OA2: chiude il passo CORRENTE con l'esito dato e passa al prossimo
     * disponibile. Quando la guida arriva a «chat» scrive onboarding.done.
     * False se il passo non è il corrente (niente cambiato).
     */
    advance: (step: OnboardingStepId, outcome: 'done' | 'skipped'): OnboardingStatus | false => {
      const state = stateOf(deps)
      if (!state) return false
      const sequence = onboardingStepSequence(availabilityOf(deps))
      // OA3: dopo la mossa dell'utente, il passo model si chiude da solo se
      // il modello è arrivato mentre la guida era ferma prima
      const next = autoAdvanceOnboarding(
        advanceOnboardingStep(state, step, outcome, sequence),
        { modelReady: modelReadyOf(deps) },
        sequence
      )
      if (next === state) return false
      deps.setSetting(ONBOARDING_STATE_SETTING, next)
      if (next.step === 'chat') deps.setSetting(DONE_SETTING, true)
      const status = statusOf(deps)
      deps.emit({ type: 'onboarding', ...status })
      return status
    },
    /**
     * OA2: riapre la guida su un passo SALTATO, o la rifà da capo (target
     * 'restart': rimette SOLO onboarding.state, nessun bot né dato toccato —
     * e onboarding.done si spegne, se era acceso). False se non si può.
     */
    reopen: (target: OnboardingStepId | 'restart'): OnboardingStatus | false => {
      const state = stateOf(deps)
      if (!state) return false
      const sequence = onboardingStepSequence(availabilityOf(deps))
      const next = reopenOnboarding(state, target, sequence, deps.now())
      if (!next) return false
      deps.setSetting(ONBOARDING_STATE_SETTING, next)
      deps.setSetting(DONE_SETTING, false)
      const status = statusOf(deps)
      deps.emit({ type: 'onboarding', ...status })
      return status
    },
    /**
     * OA3: un provider col modello valido è appena stato salvato — se la
     * guida è ferma sul passo model, si chiude da solo (è «fatto», non
     * saltato). True se ha chiuso il passo ora.
     */
    modelBecameReady(): boolean {
      const state = stateOf(deps)
      if (!state) return false
      const sequence = onboardingStepSequence(availabilityOf(deps))
      const next = autoAdvanceOnboarding(state, { modelReady: modelReadyOf(deps) }, sequence)
      if (next === state) return false
      deps.setSetting(ONBOARDING_STATE_SETTING, next)
      if (next.step === 'chat') deps.setSetting(DONE_SETTING, true)
      deps.emit({ type: 'onboarding', ...statusOf(deps) })
      return true
    },
    answerRole: (entryId: number, value: string | string[]) => answerOnboardingRole(deps, entryId, value),
    resume: () => resumeOnboarding(deps)
  }
}

export type Onboarding = ReturnType<typeof createOnboarding>
