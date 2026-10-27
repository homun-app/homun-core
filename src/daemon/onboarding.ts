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

/** Il nome del bot principale creato dall'onboarding. */
export const MAIN_BOT_NAME = 'Bot'
export const MAIN_BOT_DESCRIPTION = 'Punto di contatto principale: coordina gli altri bot.'

export const ROLE_SETTING = 'onboarding.role'
export const PENDING_PROVIDER_SETTING = 'onboarding.pendingProvider'
export const DONE_SETTING = 'onboarding.done'

/** La domanda del widget di sistema (§3ter T3): 4 opzioni + testo libero. */
export const ONBOARDING_PROMPT = 'Per cosa vuoi usarmi di più?'
export const ONBOARDING_ROLE_OPTIONS: WidgetOption[] = [
  { label: 'Lavoro e codice', value: 'lavoro-codice' },
  { label: 'Organizzazione e calendario', value: 'organizzazione-calendario' },
  { label: 'Email', value: 'email' },
  { label: 'Ricerca e aggiornamenti', value: 'ricerca-aggiornamenti' }
]

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

/** Il messaggio FISSO di benvenuto: presenta i nuovi bot in una riga ciascuno. */
export function welcomeMessage(templates: BotTemplate[]): string {
  const lines = templates.map((t) => `- ${t.name}: ${t.description}`)
  return [`Benvenuto! Ho preparato due bot su misura per te, li trovi nella barra a sinistra:`, ...lines].join('\n')
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
  const main = deps.createAgent(MAIN_BOT_NAME, MAIN_BOT_DESCRIPTION)
  deps.setSetting('mainAgentId', main.id)
  deps.emit({ type: 'agents' })
  deps.appendSystemSend(main.id, {
    type: 'widget',
    prompt: ONBOARDING_PROMPT,
    options: ONBOARDING_ROLE_OPTIONS,
    allowCustom: true,
    helpText: 'Con la risposta preparo due bot dedicati (li potrai cambiare quando vuoi).'
  }, { onboardingRole: true })
}

/**
 * La risposta al widget del ruolo: salva il ruolo e completa subito, oppure —
 * senza provider — si ferma col widget che porta alle impostazioni del
 * provider (la ripresa avviene a providers:save o al prossimo avvio).
 */
export function answerOnboardingRole(deps: OnboardingDeps, entryId: number, value: string | string[]): void {
  const role = (Array.isArray(value) ? value[0] : value) ?? ''
  deps.setSetting(ROLE_SETTING, role)
  deps.markWidgetResponded(deps.getSetting<string | null>('mainAgentId', null) ?? '', entryId, value)
  if (providerConfigured(deps)) {
    void completeOnboarding(deps, role)
  } else {
    deps.setSetting(PENDING_PROVIDER_SETTING, true)
    const main = deps.getSetting<string | null>('mainAgentId', null) ?? ''
    deps.appendSystemSend(main, {
      type: 'widget',
      prompt: 'Prima di preparare i tuoi bot mi serve un provider (il modello che li fa pensare).',
      helpText: 'Apre le impostazioni: scegli o attiva un provider e torno a completare da solo.',
      options: [{ label: 'Apri le impostazioni del provider', value: 'open-provider-settings', style: 'primary' }]
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

  const templates = roleTemplates(role)
    .map((id) => templateById(id))
    .filter((t): t is BotTemplate => !!t)
  for (const t of templates) {
    const a = deps.createAgent(t.name, t.description)
    if (assignment) deps.updateAgent(a.id, { providerId: assignment.providerId, model: assignment.model })
    deps.enqueueKickstart(a.id, t)
  }
  if (mainId) {
    deps.appendSystemSend(mainId, { type: 'text', text: welcomeMessage(templates) })
    // il default non è assegnabile (niente capability "tools"): lo dice qui,
    // così l'utente sa perché i bot non rispondono finché non sistema il modello
    if (assignment?.warning) {
      deps.appendSystemSend(mainId, {
        type: 'text',
        text: `Attenzione: non ho potuto assegnare il modello ai bot (${assignment.warning}). Scegline uno valido dalle impostazioni dell'agente.`
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
