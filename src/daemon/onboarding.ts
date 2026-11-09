// Onboarding al primo avvio (fase 7, §3bis L4 + §3ter T3): se non esiste
// nessun agente, il daemon crea il bot principale "Bot" (mainAgentId) e mostra
// nella sua chat un widget DI SISTEMA (non generato dal modello) "Per cosa vuoi
// usarmi di più?". Alla risposta, la mappa ruolo → 2 template (pura, testata)
// crea i due bot da template, che partono col kickstart; il bot principale
// manda un messaggio FISSO di benvenuto che li presenta in una riga ciascuno.
// Se non c'è ancora nessun provider configurato l'onboarding si ferma con un
// widget che porta alle impostazioni del provider e riprende (dopo il salvataggio
// di un provider o al prossimo avvio) da lì. Tutto a dipendenze iniettabili:
// nei test niente LLM, niente rete.
import type { Agent, ProviderConfig, SendMessagePayload, SandbotEvent, WidgetOption } from '../shared/types'
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

/**
 * Primo avvio: se non c'è nessun agente crea il bot principale e mostra il
 * widget di sistema col ruolo. Idempotente (onboarding.done, agenti esistenti).
 */
export function maybeStartOnboarding(deps: OnboardingDeps): void {
  if (deps.listAgents().length > 0) return
  if (deps.getSetting<boolean>(DONE_SETTING, false)) return
  // fase 17c (C4): la lingua dell'utente (prima del primo messaggio umano
  // ricade su ui.activeLanguage, cioè quella dell'app)
  const lang = currentUserLanguage()
  const main = deps.createAgent(MAIN_BOT_NAME, mainBotDescription(lang))
  deps.setSetting('mainAgentId', main.id)
  deps.emit({ type: 'agents' })
  deps.appendSystemSend(main.id, {
    type: 'widget',
    prompt: onboardingPrompt(lang),
    options: onboardingRoleOptions(lang),
    allowCustom: true,
    helpText: formatUi(ui(UI.onboardingHelp), lang)
  }, { onboardingRole: true })
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
    maybeStart: () => maybeStartOnboarding(deps),
    answerRole: (entryId: number, value: string | string[]) => answerOnboardingRole(deps, entryId, value),
    resume: () => resumeOnboarding(deps)
  }
}

export type Onboarding = ReturnType<typeof createOnboarding>
