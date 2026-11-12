// OA4 (fase onboarding-a): il focus in chat — deterministico e ZERO token,
// sul modello di promptFocus/chooseFocus di Rakazo (apps/api/src/onboarding.ts)
// ma con le NOSTRE app del catalogo e la nostra ConnectorCard. All'ingresso
// in chat (guida chiusa) il primo messaggio del bot principale è DI SISTEMA:
// un saluto breve e la card «Su cosa vuoi che ti aiuti per primo?» con 4
// opzioni + «Scrivi tu…». Il controllo e l'inserimento sono atomici (tx):
// la card compare SOLO se la chat non ha messaggi dell'utente né una domanda
// già aperta. Alla scelta: frase fissa, le card connector delle app del
// focus ANCORA NON COLLEGATE (2–3, la strada la sa già ConnectorCard), frase
// di chiusura; la descrizione del bot riceve la riga fissa «Focus iniziale:
// …» (utile al modello nei turni dopo), il nome NON cambia. Il focus NON
// crea bot, NON spende token, NON passa dal modello.
import type { Agent, SendMessagePayload, TranscriptEntry, WidgetOption } from '../shared/types'
import { formatUi, ui } from '../shared/ui-text'
import { UI } from '../shared/ui-messages'
import type { Lang } from '../shared/language'
import { currentUserLanguage } from '../main/agent/user-language'

/** I codici delle 4 opzioni (i value del widget, come i ruoli di una volta). */
export type FocusCode = 'lavoro' | 'posta' | 'ricerca' | 'tutto'

/**
 * Le mappe opzione → app (costanti PURE, come FOCUS_OPTIONS di Rakazo), con
 * le app dell'elenco unico del catalogo nostro: l'id è quello della RIGA
 * (curata diretta o slug Composio), così ConnectorCard sceglie da sola la
 * strada (composioRouteFor / composio-app:).
 */
export const FOCUS_OPTIONS: ReadonlyArray<{ value: FocusCode; apps: readonly string[] }> = [
  { value: 'lavoro', apps: ['slack', 'notion', 'trello'] },
  { value: 'posta', apps: ['gmail', 'gcalendar'] },
  { value: 'ricerca', apps: ['googledocs', 'notion'] },
  { value: 'tutto', apps: ['gmail', 'slack', 'notion'] }
]

export function isFocusCode(v: unknown): v is FocusCode {
  return typeof v === 'string' && FOCUS_OPTIONS.some((o) => o.value === v)
}

/** La domanda della card (nella lingua dell'utente). */
export function focusPrompt(lang: Lang): string {
  return formatUi(ui(UI.onboardingFocusPrompt), lang)
}

/** Le 4 opzioni della card: i value restano CODICI, le label si traducono. */
export function focusOptionLabels(lang: Lang): WidgetOption[] {
  return [
    { label: formatUi(ui(UI.onboardingFocusWork), lang), value: 'lavoro' },
    { label: formatUi(ui(UI.onboardingFocusMail), lang), value: 'posta' },
    { label: formatUi(ui(UI.onboardingFocusResearch), lang), value: 'ricerca' },
    { label: formatUi(ui(UI.onboardingFocusEverything), lang), value: 'tutto' }
  ]
}

/** L'etichetta di un codice, per le frasi fisse e la riga della descrizione. */
export function focusLabelOf(code: FocusCode, lang: Lang): string {
  const labelId = code === 'lavoro' ? UI.onboardingFocusWork
    : code === 'posta' ? UI.onboardingFocusMail
      : code === 'ricerca' ? UI.onboardingFocusResearch
        : UI.onboardingFocusEverything
  return formatUi(ui(labelId), lang)
}

/**
 * (PURA) Le card app del focus: SOLO app disponibili nell'elenco e ANCORA
 * NON collegate, al massimo 3. Se sono tutte collegate, o nessuna è
 * disponibile: «Da cosa vuoi partire?» (kind 'ask'), mai il fallimento.
 */
export function focusAppCards(
  code: string,
  facts: { connected: ReadonlySet<string>; available: ReadonlySet<string> }
): { kind: 'cards'; apps: string[] } | { kind: 'ask' } {
  const def = FOCUS_OPTIONS.find((o) => o.value === code)
  if (!def) return { kind: 'ask' }
  const apps = def.apps.filter((a) => facts.available.has(a) && !facts.connected.has(a)).slice(0, 3)
  return apps.length ? { kind: 'cards', apps } : { kind: 'ask' }
}

/** La entry è la card del focus (qualunque stato). */
export function focusCardIn(entries: readonly TranscriptEntry[]): TranscriptEntry | null {
  return entries.find((e) => e.kind === 'send-message' && e.meta?.onboardingFocus === true) ?? null
}

/**
 * (PURA, come answerableAskUser di BC3) La card del focus ancora APERTA:
 * l'ultima send del bot dev'essere la card senza risposta e senza chiusura —
 * così un messaggio scritto nella casella diventa la sua risposta libera.
 */
export function answerableOnboardingFocus(entries: readonly TranscriptEntry[]): TranscriptEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind !== 'send-message' || e.role !== 'assistant') continue
    if (e.meta?.onboardingFocus !== true) return null
    if (e.meta.respondedValue !== undefined || e.meta.widgetDismissed) return null
    return e
  }
  return null
}

/** Le dipendenze del flusso del focus (tutte iniettabili, niente modello). */
export interface FocusFlowDeps {
  now(): number
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  getAgent(id: string): Agent | null
  /** la riga fissa del focus va in descrizione (il nome non si tocca) */
  updateAgent(id: string, patch: { description?: string }): void
  getEntries(agentId: string): TranscriptEntry[]
  appendSystemSend(agentId: string, message: SendMessagePayload, meta?: Record<string, unknown>): void
  markWidgetResponded(agentId: string, entryId: number, value: string | string[]): void
  markWidgetDismissed(agentId: string, entryId: number): void
  /** il controllo e l'inserimento della card sono atomici */
  tx<T>(fn: () => T): T
  /** le app già collegate (per offrirne SOLO di nuove) */
  connectedAppIds(): Promise<ReadonlySet<string>>
}

/** Il messaggio è dell'utente (la stessa chiave della storia). */
function isUserEntry(e: TranscriptEntry): boolean {
  return e.kind === 'message' && e.role === 'user'
}

/**
 * Il primo messaggio del bot principale all'ingresso in chat: DI SISTEMA,
 * non generato dal modello — un saluto breve e la card del focus. SOLO se
 * nella chat non ci sono già messaggi dell'utente o domande aperte (il
 * controllo e l'inserimento nella STESSA transazione): due chiamate
 * concorrenti, o un riavvio, producono una card sola. Il bot principale NON
 * fa il turno BOT_INTRO: questa card ne fa le veci.
 */
export function insertFocusCardIfDue(deps: FocusFlowDeps): boolean {
  const mainId = deps.getSetting<string | null>('mainAgentId', null)
  if (!mainId || !deps.getAgent(mainId)) return false
  return deps.tx(() => {
    const entries = deps.getEntries(mainId)
    if (entries.some(isUserEntry)) return false
    if (focusCardIn(entries)) return false
    const l = currentUserLanguage()
    deps.appendSystemSend(mainId, { type: 'text', text: formatUi(ui(UI.onboardingFocusGreeting), l) })
    deps.appendSystemSend(mainId, {
      type: 'widget',
      prompt: focusPrompt(l),
      options: focusOptionLabels(l),
      allowCustom: true
    }, { onboardingFocus: true })
    return true
  })
}

/**
 * La scelta del focus (deterministica, ZERO token): la card si segna
 * risposta, una frase fissa, le card connector delle app del focus ancora
 * non collegate (ognuna con la strada che ConnectorCard già sa scegliere),
 * una frase di chiusura. Se sono tutte collegate, o nessuna è disponibile:
 * «Da cosa vuoi partire?». La descrizione del bot riceve la riga fissa
 * «Focus iniziale: …»; il nome NON cambia (il focus non rinomina il bot).
 */
export async function answerOnboardingFocus(deps: FocusFlowDeps, entryId: number, code: FocusCode): Promise<void> {
  const mainId = deps.getSetting<string | null>('mainAgentId', null) ?? ''
  deps.markWidgetResponded(mainId, entryId, code)
  const l = currentUserLanguage()
  const label = focusLabelOf(code, l)
  const bot = deps.getAgent(mainId)
  if (bot) deps.updateAgent(mainId, {
    description: `${bot.description}\n${formatUi(ui(UI.onboardingFocusDescription, { focus: label }), l)}`.trim()
  })
  deps.appendSystemSend(mainId, { type: 'text', text: formatUi(ui(UI.onboardingFocusChosen, { focus: label }), l) })
  const { loadAppCatalog } = await import('../shared/app-catalog')
  const available = new Set(loadAppCatalog({ staticClientsReady: [] }).map((r) => r.id))
  const cards = focusAppCards(code, { connected: await deps.connectedAppIds(), available })
  if (cards.kind === 'cards') {
    const rows = loadAppCatalog({ staticClientsReady: [] })
    for (const appId of cards.apps) {
      const row = rows.find((r) => r.id === appId)
      if (!row) continue
      deps.appendSystemSend(mainId, { type: 'connector', connectorId: row.id, name: row.name }, { onboardingApp: true })
    }
    deps.appendSystemSend(mainId, { type: 'text', text: formatUi(ui(UI.onboardingFocusClosing), l) })
  } else {
    deps.appendSystemSend(mainId, { type: 'text', text: formatUi(ui(UI.onboardingFocusAskAny), l) })
  }
}

/**
 * Chiudere senza scegliere (come dismissFocus di Rakazo): la card si segna
 * «chiusa» e la chat resta normale — niente card app, niente frasi.
 */
export function dismissOnboardingFocus(deps: FocusFlowDeps, entryId: number): void {
  const mainId = deps.getSetting<string | null>('mainAgentId', null) ?? ''
  deps.markWidgetDismissed(mainId, entryId)
}
