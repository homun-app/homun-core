// Onboarding del primo avvio (fase onboarding-a).
//
// OA1: UNA sola strada per il primo avvio — il main NON crea più «Bot»: lo
// crea (o adotta quello vuoto delle beta 1–4) SOLO il daemon, qui, con
// ensureMainBot single-flight e mainAgentId in transazione. onboardingNeeded
// (pura) decide chi lo fa: chi ha già scritto in un bot NON la rifà.
// OA2: la guida a passi «Prepariamo Homun», persistita nel setting
// onboarding.state — chiudere l'app a metà e riaprirla riporta allo stesso
// passo; la sequenza e il passo successivo sono puri, i passi non
// disponibili su questa macchina non ci sono (in fase A computer e memory
// arrivano con le fasi B e C).
// OA3: i passi — benvenuto (lingua), modello (si chiude da solo quando il
// modello arriva), autorizzazioni; «chat» chiude e si entra nella chat del
// bot principale.
// OA4: all'ingresso in chat la card del FOCUS (deterministica, zero token)
// — vedi onboarding-focus.ts. Il vecchio onboarding (widget del ruolo, i due
// bot da template col kickstart, il benvenuto fisso, il widget del provider
// e la sua ripresa) è STATO RIMOSSO con i suoi test.
// Tutto a dipendenze iniettabili: nei test niente LLM, niente rete.
import type { Agent, OnboardingState, OnboardingStatus, OnboardingStepId, ProviderConfig, SendMessagePayload, SandbotEvent, TranscriptEntry } from '../shared/types'
// fase locale (L4): l'idoneità della macchina per la strada «Integrato»
import { localEligibility } from '../main/agent/local-catalog'
import { currentUserLanguage } from '../main/agent/user-language'
import { formatUi, ui } from '../shared/ui-text'
import { UI } from '../shared/ui-messages'
import {
  insertFocusCardIfDue, answerOnboardingFocus, dismissOnboardingFocus,
  isFocusCode, type FocusFlowDeps
} from './onboarding-focus'

/** Il nome del bot principale creato dall'onboarding. */
export const MAIN_BOT_NAME = 'Bot'
/** La descrizione del bot principale nella lingua dell'utente (C4). */
export function mainBotDescription(lang: import('../shared/language').Lang): string {
  return formatUi(ui(UI.onboardingMainBotDescription), lang)
}

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
  /** il bot da ADOTTARE come principale (il «Bot» vuoto delle beta 1–4), se c'è */
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
  /** OA4: la riga del focus va in descrizione del bot (il nome non si tocca) */
  updateAgent(id: string, patch: { providerId?: string | null; model?: string | null; description?: string }): void
  listProviders(): ProviderConfig[]
  /** Entry visibile creata dal sistema (non dal modello), come il look-around. */
  appendSystemSend(agentId: string, message: SendMessagePayload, meta?: Record<string, unknown>): void
  /** Segna il widget risposto (respondedValue) e lo rimanda alla UI. */
  markWidgetResponded(agentId: string, entryId: number, value: string | string[]): void
  /** OA4: segna la card del focus CHIUSA senza scelta (widgetDismissed). */
  markWidgetDismissed(agentId: string, entryId: number): void
  /** OA4: le app già collegate, per offrire solo quelle nuove */
  connectedAppIds(): Promise<ReadonlySet<string>>
  emit(e: SandbotEvent): void
  /**
   * Fase locale (L4): la scoperta dei servizi locali, per la strada Ollama
   * del passo modello (solo se lo trova). Facoltativa: senza, la strada non
   * si offre.
   */
  discoverLocalProviders?: () => Promise<Array<{ kind: string }>>
  /** Fase locale (L4): i fatti della macchina per la strada Integrato (default: Mac idoneo). */
  localEligibilityFacts?: () => { arch: string; ramGb: number; freeDiskBytes: number | null }
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

/**
 * OAC1 (fase guida, PURA): la guida è APERTA adesso? Lo dice lo stato —
 * esiste e il passo non è «chat» — NON la storia della chat: chi ha già
 * scritto può aver riaperto la guida da Impostazioni (reopen), e uno stato
 * rimasto a metà si riprende al boot. «needed» resta la domanda del PRIMO
 * avvio (chi fa partire la guida e adotta il «Bot»), non del mostrarla.
 */
export function guideOpenOf(state: OnboardingState | null): boolean {
  return state !== null && state.step !== 'chat'
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
    modelReady: modelReadyOf(deps),
    // OAC1: la finestra la mostra da QUI, non da needed
    guideOpen: guideOpenOf(stateOf(deps))
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
 * Fase locale (L4), pura: le strade del passo «nessun provider», in ordine —
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
 * OA1: il primo avvio ha UNA sola strada. Il main NON crea più «Bot»: lo crea
 * (o adotta) SOLO il daemon, qui — con l'ensure single-flight, così la race
 * col main e i doppi start non fanno nascere due bot. Chi ha già scritto in
 * chat non rifà l'onboarding (e onboarding.done si scrive qui, una volta per
 * tutte). OA2: lo stato della guida nasce qui e non si tocca più. Se la
 * guida è GIÀ chiusa (chat), l'ingresso in chat riceve la card del focus.
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
  // OA4: la guida era già chiusa (riavvio dopo la fine, senza messaggi in
  // chat): la card del focus entra se è dovuta (idempotente)
  if (auto.step === 'chat' && !decision.markDone) {
    insertFocusCardIfDue(focusDepsOf(deps))
  }
  void main
}

/** I deps del flusso del focus ricavati dagli stessi deps dell'onboarding. */
function focusDepsOf(deps: OnboardingDeps): FocusFlowDeps {
  return {
    now: deps.now,
    getSetting: deps.getSetting,
    setSetting: deps.setSetting,
    getAgent: deps.getAgent,
    updateAgent: deps.updateAgent,
    getEntries: deps.getEntries,
    appendSystemSend: deps.appendSystemSend,
    markWidgetResponded: deps.markWidgetResponded,
    markWidgetDismissed: deps.markWidgetDismissed,
    tx: deps.tx,
    connectedAppIds: deps.connectedAppIds
  }
}

export function createOnboarding(deps: OnboardingDeps) {
  const focus = focusDepsOf(deps)
  /** La guida arriva a «chat»: done scritto e la card del focus entra (idempotente). */
  const reachChatIfChat = (next: OnboardingState): void => {
    if (next.step === 'chat') {
      deps.setSetting(DONE_SETTING, true)
      insertFocusCardIfDue(focus)
    }
  }
  return {
    start: () => startOnboarding(deps),
    /** OA1/OA2: lo stato per la finestra — finché non lo dice il daemon, la UI carica. */
    status: (): OnboardingStatus => statusOf(deps),
    /** OA3: le strade del passo modello per questa macchina (RPC onboarding:state). */
    providerPaths: () => guideProviderPaths(deps),
    /**
     * OA2: chiude il passo CORRENTE con l'esito dato e passa al prossimo
     * disponibile. Quando la guida arriva a «chat» si scrive onboarding.done
     * e la chat del bot principale riceve la card del focus.
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
      reachChatIfChat(next)
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
      reachChatIfChat(next)
      deps.emit({ type: 'onboarding', ...statusOf(deps) })
      return true
    },
    /**
     * OA4: la risposta alla card del focus (deterministica, zero token).
     * OAC3: idempotente nel daemon — la card già risolta o chiusa risponde
     * false (controllo e marcatura in transazione in answerOnboardingFocus).
     */
    answerFocus: async (entryId: number, value: string): Promise<boolean> => {
      if (!isFocusCode(value)) return false
      return answerOnboardingFocus(focus, entryId, value)
    },
    /** OA4: chiudere la card del focus senza scegliere. */
    dismissFocus: (entryId: number) => {
      dismissOnboardingFocus(focus, entryId)
    }
  }
}

export type Onboarding = ReturnType<typeof createOnboarding>
