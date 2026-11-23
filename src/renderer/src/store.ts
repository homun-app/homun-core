// State renderer: agenti, transcript dell'agente attivo, eventi dal main.
import { useMemo } from 'react'
import { create } from 'zustand'
import type { Agent, TranscriptEntry, SandbotEvent, OnboardingStatus, OnboardingStepId, ProviderConfig, ProviderPublic, PermissionsConfig, ConnectorInfo, TaskInfo, GroupInfo, GroupMessageInfo, SubagentInfo, AgentAvatar, TurnEnd, ScreenStatus, BoxRuntime, MainModel, ComposioStatusInfo, ComposioGatewayStatusInfo, ReadingPageRef, BoxSetupState, GroupAutonomy, SquadPendingApprovalInfo, ApprovalsCenterRow } from '../../shared/types'
// A2 (fase centro-autorizzazioni): l'ora dei «Rimanda» del centro
import { APPROVALS_SNOOZE_MS } from './lib/approvals-center'
import type { BoxSetupRowId } from '../../shared/box-setup-plan'
import type { UpdateChannel } from '../../shared/update-channel'
// fase 16c correzioni (R4): la regola del modello risolto, condivisa col daemon
import { resolveAgentModel, type ResolvedAgentModel } from '../../shared/agent-model'

/** Fase 19b (T1): le schede del pannello «Computer» del bot. */
export type ComputerTab = 'screen' | 'terminal' | 'files' | 'activity'

/**
 * PL1 (fase plugin): il PUNTO della pagina Plugin che un rimando chiede —
 * i vecchi ingressi delle finestre App/Skill/Server MCP diventano
 * punti della casa unica (la card «Apri Server MCP» → i server MCP, il
 * suggerimento «Collega <App>» → l'app, la riga Skill del pannello → le
 * skill del bot). Si consuma dentro la pagina all'apertura.
 */
/** Le schede interne della scheda di un plugin (PL2). */
export type PluginCardTab = 'overview' | 'permissions' | 'accounts'

export type PluginPoint =
  | { kind: 'segment'; seg: 'all' | 'connectors' | 'skills' | 'connected'; agentId?: string }
  | { kind: 'mcp' }
  | { kind: 'skill-new' }
  | { kind: 'developers'; scrollTo?: 'gateway' | 'marketplace' }
  | { kind: 'app'; appId: string }
  /** PP2 (fase plugin-pulita): `tab` è la scheda interna su cui aprire (la Cassaforte chiede «Account e bot») */
  | { kind: 'server'; serverId: string; tab?: PluginCardTab }

import type { UiTheme } from './theme'
import { applyTheme, watchSystemTheme } from './theme'
import { previewOf, type SidebarPreview } from './sidebar-utils'
import { collectDelegationJobs } from './lib/delegation-status'
import { activateUiLanguage } from './lib/i18n'
import { resolveUiLanguage, type UiLanguageSetting, type UiLanguage } from '../../shared/ui-language'
// fase 16b correzioni 2 (Q1): lo store tiene ciò che layoutFor legge
import { SIDEBAR_MIN, SIDEBAR_MAX, type PanelTabId } from './layout'

const api = (window as unknown as { sandbot: import('../../shared/types').SandbotApi }).sandbot

/**
 * Fase 16b correzioni 2 (Q1): le preferenze della barra (larghezza e rotaia)
 * restano nel localStorage come prima, ma vivono nello store — così App,
 * Sidebar e RightPanel leggono lo STESSO layoutFor, ciascuno la sua no.
 */
const SIDEBAR_WIDTH_KEY = 'sandbot:sidebar.width'
const SIDEBAR_COLLAPSED_KEY = 'sandbot:sidebar.collapsed'
const readLS = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const writeLS = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage non disponibile: la scelta dura finché la finestra vive
  }
}

/**
 * Fase 16 (U3): il "happy" dura 1,5 s e poi torna idle. UN solo timer qui
 * nello store (rimborsato a ogni nuovo messaggio), niente setTimeout sparsi
 * nei componenti: quando scade, nowTick cambia e la mascotte si ricalcola.
 */
let happyTimer: ReturnType<typeof setTimeout> | null = null
function armHappyTimer(set: (partial: Partial<Store>) => void): void {
  if (happyTimer) clearTimeout(happyTimer)
  happyTimer = setTimeout(() => {
    happyTimer = null
    set({ nowTick: Date.now() })
  }, 1550)
}

/**
 * C3 (fase squadra-correzioni): il refresh coalescente della squadra con
 * trailing a 200 ms SENZA affidarsi ai timer. Una finestra coperta viene
 * strozzata da Chromium — rAF in pausa, setTimeout anche a un colpo al
 * minuto — mentre i task degli eventi IPC (che portano la richiesta) girano
 * sempre: la passata matura si giudica con l'orologio a muro DENTRO quei
 * task (la via maestra).
 * A5 (fase centro-autorizzazioni): l'«acceleratore» col MessageChannel che si
 * rimandava un messaggio da solo finché non passavano 200 ms è VIA — era un
 * giro continuo di task che tiene occupata la CPU a ogni raffica (batteria).
 * Restano: la via maestra + UN solo setTimeout per il trailing a finestra
 * visibile; una finestra coperta può restare indietro (i timer sono
 * strozzati), ma appena l'utente la guarda il listener qui sotto rifà la
 * passata SUBITO (visibilitychange → visible e focus).
 */
let squadFirstPendingAt = 0
let squadPending = false
let squadForceBadges = false
let squadTimer: ReturnType<typeof setTimeout> | null = null
let squadPass: ((forceBadges: boolean) => void) | null = null

/** La passata scatta SOLO se pendente e matura (200 ms dalla PRIMA richiesta). */
const squadTryRun = (): void => {
  if (!squadPending) return
  if (Date.now() - squadFirstPendingAt < 200) return
  squadPending = false
  if (squadTimer) { clearTimeout(squadTimer); squadTimer = null }
  const force = squadForceBadges
  squadForceBadges = false
  squadPass?.(force)
}

/**
 * A5: la pagina è tornata visibile (o la finestra a fuoco) — la passata
 * parte ADESSO, una sola, anche se la finestra di debouncing non era matura:
 * una finestra coperta può essere rimasta indietro, ma chi la guarda deve
 * vedere i dati di adesso.
 */
export function squadWindowBecameVisible(): void {
  squadPending = false
  squadForceBadges = false
  if (squadTimer) { clearTimeout(squadTimer); squadTimer = null }
  squadPass?.(false)
}

// il listener vive una volta per finestra (nel renderer; nei test di node non
// c'è document e non si registra nulla)
if (typeof document !== 'undefined') {
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') squadWindowBecameVisible()
  }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)
}

/** L'ultimo fine turno di un transcript, col momento dell'ultimo send-message visibile. */
function lastTurnEndOf(entries: TranscriptEntry[]): { value: TurnEnd; sendAt: number | null } | null {
  let sendAt: number | null = null
  let turn: { value: TurnEnd; at: number } | null = null
  for (const e of entries) {
    if (e.kind === 'send-message' && !(e.meta as { held?: boolean } | null)?.held) sendAt = e.createdAt
    const te = (e.meta as { turnEnd?: TurnEnd } | null)?.turnEnd
    if (te) turn = { value: te, at: e.createdAt }
  }
  return turn ? { value: turn.value, sendAt } : null
}

interface Store {
  agents: Agent[]
  /**
   * OA1 (fase onboarding-a): lo stato del primo avvio. null = il daemon non
   * ha ancora risposto → la finestra mostra il caricamento (niente chat vuota
   * e niente «Bot» che compare da sola prima della decisione del daemon).
   * OA2: porta anche lo stato della GUIDA (onboarding.state) e la sequenza.
   */
  onboarding: OnboardingStatus | null
  /**
   * OB1/OB2 (fase onboarding-b): lo stato della preparazione del computer
   * del bot, dal daemon (RPC box:setup-state + evento box-setup). Lo store
   * lo tiene AGGIORNATO senza ricaricare — la lezione di GC6.1. null = il
   * daemon non ha ancora risposto (la UI lo chiede quando serve).
   */
  boxSetup: BoxSetupState | null
  /**
   * OBD2 (fase onboarding-b-dettagli): il PIANO della preparazione — i
   * passi che succederanno (RPC box:setup-plan, stessa funzione pura della
   * partenza). Il consenso del passo Computer elenca solo questi.
   * null = il daemon non ha ancora risposto.
   */
  boxSetupPlan: BoxSetupRowId[] | null
  activeId: string | null
  entries: TranscriptEntry[]
  /** D2 (fase deleghe): lo stato dei job delle deleghe accodate — jobId →
   * queued/delivered/gone — per la riga di stato in chat (una chiamata per
   * passata del refresh coalescente, solo se ci sono deleghe in vista) */
  delegationStatuses: Record<string, 'queued' | 'delivered' | 'gone'>
  reasoning: Record<number, string>
  /**
   * Fase risposta (R6): la risposta in diretta per agente — il testo
   * accumulato della chiamata in corso nei turni in chat privata, per la
   * bolla provvisoria. Assente/text '' = nessuna diretta.
   */
  liveReply: Record<string, { entryId: number; text: string }>
  /** fase 16c (C1): MAI la chiave — la vista pubblica del provider */
  providers: ProviderPublic[]
  /** fase 16c (C3.3): il modello principale («il cervello dei bot», models.main) */
  mainModel: MainModel | null
  permissions: PermissionsConfig | null
  /** fase 5: catalogo "Connetti app" con lo stato di ogni connettore */
  connectors: ConnectorInfo[]
  /** fase app: lo stato di Composio (chiave, collegamenti in corso, app collegate) */
  composio: ComposioStatusInfo | null
  /** fase Composio OAuth (C5): le app dentro il server Composio collegato col login */
  composioGateway: ComposioGatewayStatusInfo | null
  /** fase 7: setting mainAgentId (null → il primo agente è quello principale) */
  mainAgentId: string | null
  settingsOpen: boolean
  /**
   * RV1 (fase beta.2): lo stato dell'aggiornamento (riga «Versione e
   * aggiornamenti») — needsMove dice che l'app va spostata in Applicazioni e
   * gli aggiornamenti sono spenti per la sessione.
   */
  updaterStatus: { current: string; canUpdate: boolean; needsMove: boolean; channel: UpdateChannel }
  /** fase 7: tab da aprire alla prossima apertura delle Impostazioni (onboarding provider) */
  settingsTab: string | null
  /** fase 8: testo con cui precompilare l'editor delle regole di auto-review */
  autoreviewPrefill: string | null
  /** fase 8 (§3bis L7): task di tutti gli agenti (card in chat + sidebar) */
  tasks: TaskInfo[]
  /** fase 8 (§3bis L7): task aperto nella vista del sotto-transcript */
  openTaskId: number | null
  /** fase 8 (§3bis L7): stato live "sta facendo X…" per agente */
  activity: Record<string, { tool: string; target: string; app?: string; args?: string } | null>
  /** fase 10: gruppi (sidebar) */
  groups: GroupInfo[]
  /** fase 10: gruppo aperto nella vista gruppo */
  openGroupId: number | null
  /** C3 (fase squadra-correzioni): l'ultimo giro dei badge delle ALTRE squadre */
  _badgeRefreshAt: number
  /** C3: la passata del refresh coalescente (interna — la fa scattare il canale) */
  _squadRefreshPass(forceBadges: boolean): void
  /** Q2 (fase squadra): le card pendenti della squadra aperta (coda «Da approvare») */
  groupPending: SquadPendingApprovalInfo[]
  /** Q4 (fase squadra): le card di approvazione della timeline (pending e decise) */
  groupCards: Array<{ id: number; agentId: string; agentName: string; approvalId: string; tool: string; phrase: string; status: string; pending: boolean; fixed: boolean; when: number }>
  /** Q5 (fase squadra): la vista del team del pannello destro */
  groupOverview: {
    members: Array<{ agentId: string; name: string; state: 'lavora' | 'aspetta-te' | 'fermo' | 'finito' | 'coordina'; role: string; coordinator: boolean; pagesRead: number; filesWritten: number; subagents: number }>
    produced: Array<{ kind: 'document' | 'file'; id?: string; title: string; path?: string; authorName: string; when: number }>
  }
  /** Q2 (fase squadra): il numero di card pendenti per OGNI squadra (badge barra) */
  groupPendingCount: Record<number, number>
  /** Q2: «Fatto da soli, senza chiederti» della squadra aperta */
  groupActivity: Array<{ id: 'files' | 'commands' | 'pages' | 'bot-messages'; count: number; who: string[] }>
  /** Q2: «Lasciato passare dal revisore» della squadra aperta */
  groupReviewerPassed: Array<{ agentId: string; agentName: string; tool: string; reason: string | null; when: number; grantId: number | null }>
  /** Q2 (fase squadra): la coda «Da approvare» copre l'area centrale */
  approvalsQueueOpen: boolean
  /** A1/A2 (fase centro-autorizzazioni): TUTTE le richieste pendenti — una sola chiamata approvals:pending-all per passata alimenta centro, barra e riquadro */
  approvalsAll: ApprovalsCenterRow[]
  /** A2: il centro «Da approvare» copre l'area centrale */
  approvalsOpen: boolean
  /** A2/A3/A4: la richiesta su cui aprire il centro (dal riquadro o dalla notifica) */
  approvalsFocusId: string | null
  /** A2: i «Rimanda» di un'ora — SOLO vista: la richiesta resta in attesa nel bot e nei conteggi */
  approvalsSnoozed: Record<string, number>
  /** A2: il numero di richieste per OGNI bot singolo (badge della barra, quelle senza squadra) */
  approvalsBotCount: Record<string, number>
  /** A3: il riquadro in cima alle chat ridotto a una riga (per la sessione) */
  approvalsBannerCollapsed: boolean
  /** fase 10: messaggi del gruppo aperto */
  groupMessages: GroupMessageInfo[]
  /** fase 12: sottoagenti dell'agente attivo (card in chat + stato live) */
  subagents: SubagentInfo[]
  /** fase 12: figlio aperto nella vista del suo transcript */
  openSubagentId: string | null
  /** fase 12: entry del figlio aperto (aggiornate dagli eventi entries) */
  subEntries: TranscriptEntry[]
  // ---- fase 16: la nuova interfaccia ----
  /** fase 16: tema dell'app (setting ui.theme); 'dark' su <html> quando serve */
  theme: UiTheme
  /** fase 17a: lingua dell'interfaccia (setting ui.language, predefinito 'system') */
  uiLanguage: UiLanguageSetting
  /** fase 17a: la lingua ATTIVA dopo il setting + le lingue di sistema */
  activeLanguage: UiLanguage
  /** pannello destro aperto (setting ui.rightPanel) */
  rightPanel: boolean
  /**
   * G2 (fase 0.3.1001 grafica): contatore delle richieste di riportare il
   * focus al bottone PanelRight dopo la chiusura del pannello (✕, Esc, velo)
   * — Chat e TeamChat lo guardano e mettono a fuoco il bottone ricomparso.
   */
  panelFocusRestore: number
  requestPanelFocusRestore(): void
  /**
   * Fase 19b (T1): il pannello «Computer» del bot — quattro schede (Schermo,
   * Terminale, File, Attività) e, per lo Schermo, il modo (vista/controllo).
   */
  computerPanel: { open: boolean; tab: ComputerTab; mode: 'view' | 'control' }
  /** fase 19b (T1): l'ultima scheda usata PER BOT (si riparte da lì) */
  computerTabByAgent: Record<string, ComputerTab>
  /** fase 19a (V3.4): ultimo stato dello schermo per bot (evento screen) */
  screenStatus: Record<string, ScreenStatus>
  /**
   * SV4 (fase schermo-vivo): il bot la cui finestra PiP è aperta (una sola per
   * volta), null se nessuna. L'evento `pip` lo aggiorna; l'anteprima (SV2) si
   * scollega quando è il suo bot.
   */
  pipAgentId: string | null
  /** CC2 (fase computer-card): lo stato del BOX, il computer del bot (evento box; null = non ancora letto) */
  boxRuntime: BoxRuntime | null
  /**
   * CCK1 (fase computer-card-correzioni): la card «Computer» usa il computer
   * del bot (sandbox.mode box/docker)? Dallo store, non dal componente: la
   * risposta della RPC e la modalità si LEGGONO all'apertura della card.
   * CCK3: parte da null (NON ancora letto) — la card segue lo stato del box,
   * MAI un lampo di «Non in uso» finché la lettura non arriva.
   */
  boxInUse: boolean | null
  /** fase 16 (U3): l'utente sta scrivendo nel composer di QUESTO bot */
  typingAgentId: string | null
  /** fase 16 (U3): ultimo delta per agente (testo in streaming → speaking) */
  lastDeltaAt: Record<string, number>
  /** fase 16 (U3): ultimo send-message visibile per agente (happy per 1,5 s) */
  lastSendAt: Record<string, number>
  /** fase 16 (U3): ultimo fine turno per agente (waiting / happy) */
  turnEnds: Record<string, { value: TurnEnd; sendAt: number | null }>
  /** fase 16 (U3): orologio che si muove quando il happy scade */
  nowTick: number
  /** fase 16 (U4): anteprima dell'ultimo messaggio visibile per agente */
  previews: Record<string, SidebarPreview>
  /** fase 16 (U5): pannelli Memoria e Skill della vista dell'agente (anche dal pannello destro) */
  memoryOpen: boolean
  /** fase chat-limiti (CL7): la nota su cui aprire il pannello Memoria (riga di sistema della quarantena) */
  memoryFocusId: string | null
  /** fase memoria-engramma (M6): l'avanzamento dei lavori della memoria */
  memoryProgress: { phase: 'story-backfill' | 'model-pull'; done: number; total: number; finished?: boolean; error?: string } | null
  /** fase skill: il filtro bot della finestra «Skill» (null = tutti i bot) */
  skillsFilterAgent: string | null
  setSkillsFilterAgent(v: string | null): void
  /**
   * Fase 16b (S3.3): «Mostra i passaggi in chat» (Impostazioni › Generali,
   * default spenta) — rimette le righe tool-call/tool-result di oggi.
   */
  debugSteps: boolean
  setDebugSteps(v: boolean): void
  /** fase 16b (S4): il pannello del bot si apre (o cambia) su una scheda data */
  botPanelTabRequest: 'computer' | 'routines' | null
  openBotTab(tab: 'computer' | 'routines'): void
  clearBotPanelTabRequest(): void
  /**
   * Fase pagine (G3): il foglio «Impostazioni del bot» (Profilo · Routine ·
   * Avanzate) che si apre cliccando il nome o la mascotte; focus = sezione o
   * campo da mettere a fuoco (description = le Istruzioni di Avanzate, G4).
   */
  botSheetOpen: boolean
  botSheetFocus: 'routines' | 'description' | null
  openBotSheet(focus?: 'routines' | 'description'): void
  closeBotSheet(): void
  /**
   * RV4 (fase beta.2): il foglio piccolo del modello del bot (lo STESSO
   * ModelSelect del foglio «Impostazioni del bot»), aperto dalla riga del
   * modello nel pannello destro e dal bottone «Scegli un modello» delle
   * notice in chat. rightPanel si accende: la riga vive lì.
   */
  botModelOpen: boolean
  openBotModel(): void
  closeBotModel(): void
  /**
   * Fase pagine (G2): la pagina della libreria aperta al posto della chat —
   * from dice dove torna la ✕ (alla chat o alla lista della Libreria);
   * title/version li riempie la vista quando carica (servono al compositore).
   */
  openPageInfo: { id: string; from: 'chat' | 'library'; title: string; version: number } | null
  openPage(id: string, from: 'chat' | 'library'): void
  closePage(): void
  setPageMeta(meta: { title: string; version: number }): void
  /** fase pagine (G4): il testo con cui precompilare il compositore della chat */
  composerPrefill: string | null
  setComposerPrefill(text: string | null): void
  /** fase 16b (S1.3): crea/modifica/cancella squadre dalla UI */
  groupCreate(name: string, memberIds: string[], coordinatorId: string, description?: string): Promise<void>
  groupUpdate(groupId: number, patch: {
    name?: string
    description?: string
    addMemberIds?: string[]
    removeMemberIds?: string[]
    coordinatorId?: string
    autonomy?: GroupAutonomy
  }): Promise<void>
  groupDelete(groupId: number): Promise<void>
  /**
   * K2 (fase team-bot): archivia/ripristina bot e team, elimina con l'avviso
   * «Eliminato · Annulla» (10 s) e il recupero in «Archiviati › Eliminati».
   */
  archiveAgent(id: string): Promise<void>
  unarchiveAgent(id: string): Promise<void>
  restoreAgent(id: string): Promise<void>
  deleteAgentWithUndo(id: string): Promise<void>
  groupArchive(groupId: number): Promise<void>
  groupUnarchive(groupId: number): Promise<void>
  groupRestore(groupId: number): Promise<void>
  groupDeleteWithUndo(groupId: number, alsoDeleteMembers?: boolean): Promise<void>
  undoRemoved(): Promise<void>
  setSidebarArchivedOpen(v: boolean): void
  /** K2: dopo archivia/elimina, se il bot attivo non è più vivo si seleziona il primo vivo */
  selectFallbackAlive(): void
  init(): Promise<void>
  select(agentId: string): Promise<void>
  /**
   * fase pagine (G2/G6): readingPage = la pagina aperta mentre l'utente
   * scrive. Ritocchi (P1): solo l'identità (id, version) — il titolo lo
   * risolve il daemon dalla libreria
   */
  send(text: string, images?: string[], readingPage?: ReadingPageRef): Promise<void>
  interrupt(): void
  // fase 3: risposta a un widget e azioni sulle bozze
  widgetRespond(entryId: number, value: string | string[]): void
  draftSend(entryId: number, body?: string): void
  draftDiscard(entryId: number): void
  draftUpdate(entryId: number, body: string): void
  /**
   * fase 8: mode 'once' | 'always' | 'turn' (fino a fine turno); fase use-app: anche 'minutes10'.
   * AH1 (fase aiutanti): la RPC va all'agente a cui appartiene la CARD
   * (entry.agentId — il figlio quando la card sta nel suo pannello o nella
   * chat del padre), MAI all'agente attivo.
   */
  resolveApproval(agentId: string, approvalId: string, decision: 'allow' | 'deny', mode: 'once' | 'always' | 'turn' | 'minutes10' | 'mission' | 'site' | 'server-reads', via?: 'chat' | 'center' | 'notification'): void
  /** fase 8: decisione sulla regola di auto-review proposta dal bot */
  autoreviewRuleDecision(entryId: number, action: 'add' | 'dismiss'): void
  /** fase 8: "Crea regola da questa azione" — apre l'editor precompilato */
  proposeRule(text: string): void
  createAgent(name: string, avatar?: AgentAvatar): Promise<void>
  /** fase 7: "Rendi principale" nelle impostazioni dell'agente */
  setMainAgent(id: string): Promise<void>
  refreshProviders(): Promise<void>
  refreshPermissions(): Promise<void>
  refreshConnectors(): Promise<void>
  /** fase app: ricarica lo stato Composio (collegamenti, attesa del login) */
  refreshComposio(): Promise<void>
  /** fase Composio OAuth (C5): ricarica lo stato del gateway (app dentro il server Composio) */
  refreshComposioGateway(): Promise<void>
  /** fase 8 (§3bis L7): apre/chiude la vista del sotto-transcript di un task */
  openTask(id: number | null): void
  /** fase 8 (§3bis L7): interrompe un task dal bottone sulla card */
  cancelTask(taskId: number): void
  /** fase 10: apre la vista di un gruppo (o torna alla chat) */
  openGroup(id: number | null): void
  /**
   * C3 (fase squadra-correzioni): l'UNICO refresh della squadra, coalescente
   * (debounce ~200 ms trailing): lista, messaggi, card, overview, pendenti e
   * agenti in UNA passata — niente RPC per ogni singolo evento groups/agents/
   * approval. `forceBadges` scavalca il limite dei 2 s dei badge delle altre
   * squadre (azioni dell'utente: apertura, decisione dalla coda).
   */
  refreshSquadData(opts?: { forceBadges?: boolean }): void
  setApprovalsQueueOpen(open: boolean): void
  /** D2 (fase deleghe): l'Annulla della riga «In coda per <bot>» */
  cancelDelegation(jobId: number): Promise<void>
  /** A2: apre il centro «Da approvare» (eventualmente su UNA richiesta) */
  setApprovalsOpen(open: boolean, focusId?: string | null): void
  /** A2 (fase approvazioni-chiare): la vista del centro — le richieste o il Registro */
  approvalsView: 'richieste' | 'registro'
  setApprovalsView(view: 'richieste' | 'registro'): void
  /** R1 (fase ritocchi-beta18): la richiesta mostrata dal riquadro sopra il
   *  campo quando il bot aperto ne ha PIÙ di una in attesa («1 di N») */
  composerApprovalIndex: number
  setComposerApprovalIndex(index: number): void
  /** A2: la richiesta su cui ha portato il clic della NOTIFICA (deciderla qui
   *  si registra come via 'notification' — la decisione si prende in app) */
  approvalsNotificationFocus: string | null
  clearApprovalsNotificationFocus(): void
  /** A2: «Rimanda» — nasconde la richiesta dal centro e dal riquadro per un'ora (setting) */
  approvalsSnooze(approvalId: string): void
  /** A3: il riquadro delle chat ridotto/riaperto (sessione) */
  setApprovalsBannerCollapsed(v: boolean): void
  /** Q2: decide dalla coda della squadra con la resolveApproval di oggi */
  resolveGroupApproval(agentId: string, approvalId: string, decision: 'allow' | 'deny', mode: 'once' | 'mission'): void
  /** fase 10: l'utente scrive nel gruppo (@menzioni comprese) */
  sendGroupMessage(text: string): void
  /** fase 12: apre/chiude la vista del transcript di un sottoagente */
  openSubagent(id: string | null): void
  /** fase 14: apre la Libreria (null = chiusa, '' = lista, id = voce) */
  openLibrary(id: string | null): void
  /** fase 14: la libreria aperta (null = chiusa, '' = lista, id = voce) */
  openLibraryId: string | null
  /**
   * PL1 (fase plugin): la pagina «Plugin» — la casa unica di connettori,
   * server MCP e skill. Copre l'area centrale come Libreria e Attività
   * (regola B1: un punto solo che decide, il render condizionale di App).
   * `openPlugin(at)` apre la pagina e chiude le altre viste centrali; `at`
   * è il punto di arrivo dei rimandi e si consuma dentro la pagina.
   */
  pluginOpen: boolean
  pluginAt: PluginPoint | null
  openPlugin(at?: PluginPoint): void
  setPluginOpen(v: boolean): void
  /** fase 16c (C5): la vista centrale «Attività» (false = chat) */
  activityOpen: boolean
  setActivityOpen(v: boolean): void
  /** fase 16c (C3.2): cambia il modello principale e ricarica i bot che lo seguono */
  setMainModel(m: MainModel | null): Promise<void>
  /** fase 12: bottone Ferma sulla card del sottoagente */
  stopSubagent(id: string): void
  setSettingsOpen(v: boolean): void
  setSettingsTab(v: string | null): void
  /** OA2 (fase onboarding-a): chiude il passo corrente della guida (done|skipped) */
  onboardingAdvance(step: OnboardingStepId, outcome: 'done' | 'skipped'): Promise<void>
  /** OA2: riapre la guida su un passo saltato, o la rifà da capo ('restart') */
  onboardingReopen(target: OnboardingStepId | 'restart'): Promise<void>
  /** OB1 (fase onboarding-b): la preparazione del computer del bot */
  boxSetupStart(): Promise<void>
  /**
   * MB3 (fase modalita-box): la SCELTA dell'utente dalle Impostazioni — dove
   * girano i comandi del bot. UNA RPC che scrive sandbox.mode E
   * sandbox.modeSet insieme; la card «Computer» segue il cambio rileggendo
   * la modalità (CCK3); «Sul computer del bot» con la preparazione mai fatta
   * (o in errore) avvia la STESSA preparazione della guida (boxSetupStart).
   */
  sandboxModeSet(mode: 'box' | 'host'): Promise<void>
  boxSetupCancel(): Promise<void>
  boxSetupRetry(): Promise<void>
  boxSetupOpenInstaller(): Promise<void>
  /**
   * CCK1 (fase computer-card-correzioni): lo stato del box ENTRA nello store
   * da qui — la STESSA azione per l'evento `box` e per la risposta della RPC
   * box:runtime. L'evento parte SOLO al cambio di stato: la finestra che si
   * apre (o si ricarica) col box GIÀ acceso non lo riceverà mai, e senza la
   * risposta della RPC la card resterebbe «Spento» (il bug di partenza).
   * Vince il `since` più recente: una risposta più VECCHIA di un evento già
   * arrivato non lo sovrascrive.
   */
  setBoxRuntime(runtime: BoxRuntime): void
  /** CCK1: la LETTURA della RPC box:runtime (la risposta entra nello store). */
  readBoxRuntime(): Promise<void>
  /** CCK1: la lettura della modalità sandbox della card «Computer». */
  readBoxInUse(): Promise<void>
  /** fase 16: tema (classe dark su <html>) e pannello destro */
  setTheme(t: UiTheme): void
  /** fase 17a: lingua dell'interfaccia — si applica subito e resta nel setting */
  setUiLanguage(l: UiLanguageSetting): void
  setRightPanel(v: boolean): void
  /**
   * Fase 19b (T1): apre/chiude il pannello «Computer». Senza tab esplicita
   * vale l'ULTIMA usata per il bot attivo (la prima volta: Attività, che
   * funziona in ogni modalità); la tab scelta si ricorda per bot.
   */
  setComputerPanel(open: boolean, tab?: ComputerTab, mode?: 'view' | 'control'): void
  /** fase 16 (U3): il composer di questo bot ha del testo (o no) */
  setTyping(agentId: string | null): void
  /** fase 16 (U5): apre/chiude i pannelli Memoria e Skill */
  setMemoryOpen(v: boolean): void
  /** fase chat-limiti (CL7): apre la sezione Memoria su UNA nota (quella in quarantena) */
  openMemoryNote(id: string): void
  /**
   * Fase 16b correzioni 2 (Q1): la larghezza della finestra (listener resize
   * con debounce leggero in App) e le preferenze della barra — larghezza
   * scelta trascinando (220–420) e rotaia chiesta con ⌘\ o trascinamento.
   * La rotaia AUTOMATICA sotto AUTO_RAIL_BELOW non tocca sidebarCollapsed.
   */
  windowWidth: number
  /** G6 (fase guida): startedAt della guida quando ha raggiunto il passo Pronto (solo UI) */
  guideReadyAt: number | null
  /** G6: segna il passo Pronto raggiunto per la guida corrente (startedAt) */
  setGuideReadyAt: (startedAt: number | null) => void
  sidebarCollapsed: boolean
  /**
   * K2 (fase team-bot): la sezione «Archiviati» della barra aperta o chiusa
   * (chiusa di default; la scelta vive finché la finestra vive).
   */
  sidebarArchivedOpen: boolean
  /**
   * K2 (fase team-bot): l'avviso «Eliminato · Annulla» — l'elemento appena
   * eliminato, recuperabile col bottone entro `expiresAt` (10 secondi).
   */
  removedUndo: { kind: 'bot' | 'team'; id: string; name: string; expiresAt: number } | null
  sidebarWidth: number
  /** la scheda aperta nel pannello del bot (decide la larghezza wide di Computer) */
  panelTab: PanelTabId
  setWindowWidth(w: number): void
  setSidebarWidth(w: number): void
  setSidebarCollapsed(v: boolean): void
  setPanelTab(t: PanelTabId): void
}

export const useStore = create<Store>((set, get) => ({
  agents: [],
  onboarding: null,
  boxSetup: null,
  boxSetupPlan: null,
  activeId: null,
  entries: [],
  delegationStatuses: {},
  reasoning: {},
  liveReply: {},
  providers: [],
  mainModel: null,
  permissions: null,
  connectors: [],
  composio: null,
  composioGateway: null,
  mainAgentId: null,
  settingsOpen: false,
  // RV1 (fase beta.2): finché App non legge lo stato reale, i valori neutri
  updaterStatus: { current: '', canUpdate: true, needsMove: false, channel: 'stable' },
  settingsTab: null,
  autoreviewPrefill: null,
  tasks: [],
  openTaskId: null,
  activity: {},
  groups: [],
  openGroupId: null,
  _badgeRefreshAt: 0,
  groupPending: [],
  groupCards: [],
  /** Q5 (fase squadra): la vista del team del pannello destro */
  groupOverview: { members: [], produced: [] } as {
    members: Array<{ agentId: string; name: string; state: 'lavora' | 'aspetta-te' | 'fermo' | 'finito' | 'coordina'; role: string; coordinator: boolean; pagesRead: number; filesWritten: number; subagents: number }>
    produced: Array<{ kind: 'document' | 'file'; id?: string; title: string; path?: string; authorName: string; when: number }>
  },
  groupPendingCount: {},
  groupActivity: [],
  groupReviewerPassed: [],
  approvalsQueueOpen: false,
  approvalsAll: [],
  approvalsView: 'richieste' as const,
  composerApprovalIndex: 0,
  approvalsNotificationFocus: null,
  approvalsOpen: false,
  approvalsFocusId: null,
  approvalsSnoozed: {},
  approvalsBotCount: {},
  approvalsBannerCollapsed: false,
  groupMessages: [],
  subagents: [],
  openSubagentId: null,
  subEntries: [],
  openLibraryId: null,
  // PL1 (fase plugin): la pagina Plugin (chiusa), col punto dei rimandi
  pluginOpen: false,
  pluginAt: null,
  activityOpen: false,
  // fase 16
  theme: 'system',
  // fase 17a (L2)
  uiLanguage: 'system',
  activeLanguage: 'it',
  rightPanel: true,
  // G2 (fase 0.3.1001 grafica)
  panelFocusRestore: 0,
  computerPanel: { open: false, tab: 'activity', mode: 'view' },
  computerTabByAgent: {},
  screenStatus: {},
  pipAgentId: null,
  boxRuntime: null,
  // CCK1/CCK3 (fase computer-card-correzioni): la modalità della card, letta
  // all'apertura — null finché la lettura non arriva (mai «Non in uso» per un attimo)
  boxInUse: null,
  typingAgentId: null,
  lastDeltaAt: {},
  lastSendAt: {},
  turnEnds: {},
  nowTick: 0,
  previews: {},
  memoryOpen: false,
  memoryFocusId: null,
  memoryProgress: null,
  skillsFilterAgent: null,
  botPanelTabRequest: null,
  // fase pagine (G3): il foglio Impostazioni del bot (chiuso, nessun focus)
  botSheetOpen: false,
  botSheetFocus: null,
  // RV4 (fase beta.2): il foglio del modello del bot
  botModelOpen: false,
  // fase pagine (G2/G4): pagina aperta, precompilazione del compositore,
  // dettaglio dell'app su cui aprire la finestra App
  openPageInfo: null,
  composerPrefill: null,
  debugSteps: false,
  // fase 16b correzioni 2 (Q1): le letture dal localStorage sono le stesse
  // chiavi che usava Sidebar.tsx — la preferenza dell'utente sopravvive
  windowWidth: typeof window !== 'undefined' ? window.innerWidth : 1280,
  guideReadyAt: null,
  sidebarCollapsed: readLS(SIDEBAR_COLLAPSED_KEY) === '1',
  // K2 (fase team-bot): «Archiviati» chiusa di default; nessun avviso attivo
  sidebarArchivedOpen: false,
  removedUndo: null,
  sidebarWidth: (() => {
    const v = Number(readLS(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(v) && v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : 264
  })(),
  panelTab: 'activity',

  // ---- fase 16b correzioni 2 (Q1) ----
  setWindowWidth: (w) => set({ windowWidth: w }),
  setGuideReadyAt: (startedAt) => set({ guideReadyAt: startedAt }),
  setSidebarWidth: (w) => {
    const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w))
    writeLS(SIDEBAR_WIDTH_KEY, String(clamped))
    set({ sidebarWidth: clamped })
  },
  setSidebarCollapsed: (v) => {
    writeLS(SIDEBAR_COLLAPSED_KEY, v ? '1' : '0')
    set({ sidebarCollapsed: v })
  },
  setPanelTab: (t) => set({ panelTab: t }),

  async init() {
    // OA1 (fase onboarding-a): lo stato del primo avvio PRIMA di tutto — finché
    // non arriva, la finestra resta in caricamento (niente chat vuota)
    void api.onboardingState()
      .then((onboarding) => set({ onboarding }))
      .catch(() => set({ onboarding: { needed: false, state: null, sequence: ['welcome', 'model', 'approvals', 'chat'], modelReady: false, guideOpen: false } }))
    const agents = await api.listAgents()
    const providers = await api.listProviders()
    const permissions = await api.getPermissions()
    const activeId = agents[0]?.id ?? null
    // fase 7: il bot principale per il badge (null → il primo agente)
    const mainAgentId = await api.settingsGet<string | null>('mainAgentId', null).catch(() => null)
    // fase 16c (C3.3): il modello principale («Come gli altri»)
    const mainModel = await api.settingsGet<MainModel | null>('models.main', null).catch(() => null)
    set({ agents, providers, permissions, activeId, mainAgentId, mainModel })
    // fase 16 (U0): tema e pannello destro; con 'system' si segue il sistema
    const theme = await api.settingsGet<UiTheme>('ui.theme', 'system').catch(() => 'system' as UiTheme)
    const rightPanel = await api.settingsGet<boolean>('ui.rightPanel', true).catch(() => true)
    set({ theme, rightPanel })
    // fase 16b (S3.3): la voce di debug «Mostra i passaggi in chat»
    const debugSteps = await api.settingsGet<boolean>('ui.debugSteps', false).catch(() => false)
    set({ debugSteps })
    // A2 (fase centro-autorizzazioni): i «Rimanda» del centro (solo vista)
    const approvalsSnoozed = await api.settingsGet<Record<string, number>>('approvals.snoozed', {}).catch(() => ({}))
    set({ approvalsSnoozed })
    applyTheme(theme)
    watchSystemTheme(() => applyTheme(get().theme))
    // fase 17a (L2): la lingua del setting (il catalogo l'ha già attivato
    // main.tsx prima del mount; qui si ricordano setting e lingua attiva)
    const uiLanguage = await api.settingsGet<UiLanguageSetting>('ui.language', 'system').catch(() => 'system' as UiLanguageSetting)
    set({ uiLanguage, activeLanguage: resolveUiLanguage(uiLanguage, navigator.languages) })
    if (activeId) {
      set({ entries: await api.getEntries(activeId) })
    }
    // fase 16 (U4): anteprima, turnEnd e happy di ogni bot per la sidebar
    // (una lettura a avvio; poi li aggiornano gli eventi 'entries')
    for (const a of agents) {
      api.getEntries(a.id)
        .then((es) => {
          const s = get()
          const te = lastTurnEndOf(es)
          set({
            previews: { ...s.previews, [a.id]: previewOf(es) },
            turnEnds: te ? { ...s.turnEnds, [a.id]: te } : s.turnEnds,
            lastSendAt: te?.sendAt ? { ...s.lastSendAt, [a.id]: te.sendAt } : s.lastSendAt
          })
        })
        .catch(() => undefined)
    }
    // RV1 (fase beta.2): lo stato dell'aggiornamento per la riga «Versione e
    // aggiornamenti» (GeneralTab lo legge da qui, niente doppia lettura)
    api.updaterStatus().then((updaterStatus) => set({ updaterStatus })).catch(() => undefined)
    // fase 5: catalogo connettori (per la vista Impostazioni e le card in chat)
    api.connectorsList().then((connectors) => set({ connectors })).catch(() => undefined)
    // fase 8: i task (card in chat + stato live nella sidebar)
    api.listTasks().then((tasks) => set({ tasks })).catch(() => undefined)
    // fase 10: i gruppi (sidebar)
    api.listGroups().then((groups) => set({ groups })).catch(() => undefined)
    // fase 12: i sottoagenti dell'agente attivo (card e stato live)
    if (activeId) api.listSubagents(activeId).then((subagents) => set({ subagents })).catch(() => undefined)
    api.onEvent((e: SandbotEvent) => {
      const s = get()
      switch (e.type) {
        case 'connectors': {
          // fase 5: lo stato di un connettore è cambiato (OAuth completato, …)
          api.connectorsList().then((connectors) => set({ connectors })).catch(() => undefined)
          // fase app: anche lo stato Composio (collegamento, ricollegamento, …)
          api.composioStatus().then((composio) => set({ composio })).catch(() => undefined)
          // fase Composio OAuth: anche le app dentro il server Composio
          api.composioGatewayStatus().then((composioGateway) => set({ composioGateway })).catch(() => undefined)
          break
        }
        case 'reconnected': {
          // residuo fase 4 (0b): il daemon potrebbe aver aggiunto entry
          // (routine, approvazioni, risposte) mentre eravamo sconnessi —
          // si ricaricano agenti e transcript dell'agente selezionato
          void api.listAgents().then(async (agents2) => {
            set({ agents: agents2 })
            if (s.activeId) set({ entries: await api.getEntries(s.activeId) })
          })
          break
        }
        case 'agents':
          // Q5 (fase squadra) · C3: gli stati del team cambiano con gli eventi,
          // ma il refresh è COALESCENTE (una passata sola, non una per evento)
          s.refreshSquadData()
          break
        case 'models': {
          // GC6.1 (fase guida-correzioni): il daemon dice che models.main o i
          // provider sono cambiati (guida, Impostazioni, modello integrato
          // pronto) — lo store si ricarica SUBITO: prima li leggeva solo
          // all'avvio e la finestra restava su «Nessun modello»
          api.listProviders().then((providers) => set({ providers })).catch(() => undefined)
          api.settingsGet<MainModel | null>('models.main', null)
            .then((mainModel) => set({ mainModel }))
            .catch(() => undefined)
          break
        }
        case 'onboarding': {
          // OA1: il daemon ha detto lo stato del primo avvio. OA2: con lo
          // stato della guida (il passo corrente) e la sequenza.
          // OAC1 (fase guida): guideOpen è esplicito (lo stato dice se la
          // guida è aperta, non la storia della chat)
          set({
            onboarding: {
              needed: e.needed,
              state: e.state ?? null,
              sequence: e.sequence ?? ['welcome', 'model', 'approvals', 'chat'],
              modelReady: e.modelReady ?? false,
              guideOpen: e.guideOpen ?? (e.state !== null && e.state.step !== 'chat'),
              // le strade del passo model solo la RPC le porta: l'evento non
              // le butta via se c'erano già
              providerPaths: s.onboarding?.providerPaths
            }
          })
          // OA3: la guida è arrivata a «chat» → si entra nella chat del bot
          // principale (la finestra torna la shell normale)
          if (e.state?.step === 'chat') {
            const mainId = s.mainAgentId ?? s.agents[0]?.id ?? null
            if (mainId && s.activeId !== mainId) void s.select(mainId)
          }
          break
        }
        case 'box-setup': {
          // OB2: l'avanzamento della preparazione arriva dal daemon — lo
          // store lo tiene SENZA ricaricare la finestra (GC6.1)
          set({ boxSetup: e.setup })
          break
        }
        case 'status': {
          set({ agents: s.agents.map((a) => (a.id === e.agentId ? { ...a, status: e.status } : a)) })
          break
        }
        case 'entries': {
          // fase 16 (U4/U3): anteprima, turnEnd e happy della sidebar valgono
          // per OGNI agente, non solo per quello aperto
          const batch = e.entries
          const hasSend = batch.some((en) => en.kind === 'send-message' && !(en.meta as { held?: boolean } | null)?.held)
          const te = lastTurnEndOf(batch)
          const now = Date.now()
          set({
            previews: { ...s.previews, [e.agentId]: previewOf(batch) || s.previews[e.agentId] || '' },
            turnEnds: te
              ? { ...s.turnEnds, [e.agentId]: { value: te.value, sendAt: te.sendAt ?? s.lastSendAt[e.agentId] ?? null } }
              : s.turnEnds,
            lastSendAt: hasSend ? { ...s.lastSendAt, [e.agentId]: now } : s.lastSendAt
          })
          if (hasSend) armHappyTimer(set)
          // fase 12: le entry del FIGLIO aperto finiscono nel suo pannello
          if (e.agentId === s.openSubagentId) {
            const merged = [...s.subEntries]
            for (const en of e.entries) {
              const i = merged.findIndex((x) => x.id === en.id)
              if (i >= 0) merged[i] = en
              else merged.push(en)
            }
            set({ subEntries: merged.sort((a, b) => a.id - b.id) })
            if (e.agentId !== s.activeId) break
          }
          if (e.agentId !== s.activeId) {
            set({ agents: s.agents.map((a) => (a.id === e.agentId ? { ...a, unread: a.unread + 1 } : a)) })
            break
          }
          const merged = [...s.entries]
          for (const en of e.entries) {
            const i = merged.findIndex((x) => x.id === en.id)
            if (i >= 0) merged[i] = en
            else merged.push(en)
          }
          set({ entries: merged })
          break
        }
        case 'delta': {
          // fase 16 (U3): il delta segna lo streaming di QUESTO bot (speaking)
          set({ lastDeltaAt: { ...s.lastDeltaAt, [e.agentId]: Date.now() } })
          if (e.agentId !== s.activeId) break
          if (e.reasoning) {
            set({ reasoning: { ...s.reasoning, [e.entryId]: (s.reasoning[e.entryId] ?? '') + e.text } })
            break
          }
          set({
            entries: s.entries.map((en) =>
              en.id === e.entryId ? { ...en, content: en.content + e.text } : en
            )
          })
          break
        }
        case 'live-reply': {
          // fase risposta (R6): la risposta in diretta — testo pieno finché
          // arriva, via quando la chiamata finisce (consegnata → la entry
          // promossa la sostituisce; con strumenti → resta la riga di lavoro)
          if (e.agentId !== s.activeId) break
          if (!e.text) {
            if (s.liveReply[e.agentId]) {
              const cleared = { ...s.liveReply }
              delete cleared[e.agentId]
              set({ liveReply: cleared })
            }
            break
          }
          set({ liveReply: { ...s.liveReply, [e.agentId]: { entryId: e.entryId, text: e.text } } })
          break
        }
        case 'approval': {
          // Q4 · C3: le card della timeline seguono le decisioni, la coda si
          // aggiorna appena una card nasce o si chiude — tutto nel refresh
          // coalescente, il merge locale dell'entry resta immediato
          if (e.agentId === s.activeId) {
            const merged = [...s.entries]
            const i = merged.findIndex((x) => x.meta?.approvalId === e.approval.id)
            if (i >= 0) merged[i] = { ...merged[i], meta: { ...merged[i].meta!, status: e.approval.status } }
            set({ entries: merged })
          }
          s.refreshSquadData()
          break
        }
        case 'open-agent': {
          if (e.agentId !== s.activeId) {
            void s.select(e.agentId)
          } else {
            const w = window as unknown as { focus?: () => void }
            w.focus?.()
          }
          break
        }
        // fase 8 (§3bis L7): lo stato di un task è cambiato (card, sidebar)
        case 'tasks': {
          api.listTasks().then((tasks) => set({ tasks })).catch(() => undefined)
          break
        }
        // fase 8 (§3bis L7): stato live — quale tool sta girando nel turno
        case 'activity': {
          set({ activity: { ...s.activity, [e.agentId]: e.activity } })
          break
        }
        // fase 19a (V3.4): lo stato dello schermo di un bot è cambiato
        case 'screen': {
          set({ screenStatus: { ...s.screenStatus, [e.agentId]: e.status } })
          break
        }
        // SV4 (fase schermo-vivo): la finestra PiP è cambiata (id del bot o
        // null) — l'anteprima della card (SV2) si scollega quando è il suo bot
        case 'pip': {
          set({ pipAgentId: e.agentId })
          break
        }
        // SV4/U3: «Riporta in Homun» dalla PiP — primo piano sulla scheda Computer
        case 'open-computer': {
          if (e.agentId !== s.activeId) void s.select(e.agentId)
          s.openBotTab('computer')
          break
        }
        // CC2 (fase computer-card): lo stato del BOX è cambiato (solo al
        // cambio) — CCK1: passa dalla STESSA azione della risposta della RPC
        case 'box': {
          s.setBoxRuntime(e.runtime)
          break
        }
        // fase memoria-engramma (M6): download del modello e indicizzazione
        // della storia — la sezione Memoria mostra l'avanzamento
        case 'memory': {
          set({ memoryProgress: { phase: e.phase, done: e.done, total: e.total, ...(e.finished !== undefined ? { finished: e.finished } : {}), ...(e.error !== undefined ? { error: e.error } : {}) } })
          break
        }
        // fase 10: un gruppo o i suoi messaggi sono cambiati (sidebar + vista)
        // C3: UN refresh coalescente — con 3–4 bot al lavoro gli eventi sono
        // decine al secondo e una ricarica per evento sostituiva gli array a
        // ogni giro, ri-renderizzando tutta la timeline
        case 'groups': {
          s.refreshSquadData()
          break
        }
        // fase 16b (S1.2): apri la squadra (notifica del riepilogo del coordinatore)
        case 'open-group': {
          s.openGroup(e.groupId)
          const w = window as unknown as { focus?: () => void }
          w.focus?.()
          break
        }
        // A4 (fase centro-autorizzazioni): apri il centro «Da approvare»,
        // sulla richiesta della notifica quando c'è
        case 'open-approvals': {
          s.setApprovalsOpen(true, e.approvalId)
          // A2 (fase approvazioni-chiare): deciderla da qui, nel registro, è
          // via 'notification' (la notifica NON decide: porta qui)
          set({ approvalsNotificationFocus: e.approvalId ?? null })
          const w = window as unknown as { focus?: () => void }
          w.focus?.()
          break
        }
        // fase 12: lo stato di un sottoagente è cambiato (card + pannello)
        case 'subagents': {
          if (e.parentId === s.activeId) {
            api.listSubagents(e.parentId).then((subagents) => set({ subagents })).catch(() => undefined)
          }
          break
        }
      }
    })
  },

  async select(agentId) {
    // fase 16: cambiando bot cambia anche il composer (il typing non resta appeso).
    // fase 16b (S5): la squadra aperta lascia il posto alla chat del bot
    // verifica impostazioni (navigazione): scegliere un bot riporta alla sua
    // chat — Attività e Libreria si chiudono (prima restavano sopra la chat)
    set({ activeId: agentId, entries: [], openSubagentId: null, subEntries: [], typingAgentId: null, openGroupId: null, groupMessages: [], activityOpen: false, openLibraryId: null, openPageInfo: null, approvalsOpen: false, approvalsFocusId: null, pluginOpen: false })
    set({ entries: await api.getEntries(agentId) })
    // fase 12: i sottoagenti dell'agente scelto
    api.listSubagents(agentId).then((subagents) => set({ subagents })).catch(() => undefined)
    await api.updateAgent(agentId, {})
    // fase 6: l'utente sta guardando questa chat → notifiche soppresse per
    // questo agente e la sua outbox si consegna subito (finestra bypassata)
    void api.presenceViewing(agentId).catch(() => undefined)
    void api.outboxOpened(agentId)
      .then(() => api.getEntries(agentId))
      .then((entries) => set({ entries }))
      .catch(() => undefined)
  },

  async send(text, images, readingPage) {
    const id = get().activeId
    if (!id || !text.trim()) return
    await api.sendMessage(id, text.trim(), images, readingPage)
  },

  interrupt() {
    const id = get().activeId
    if (id) api.interrupt(id)
  },

  // fase 3: ottimistico sull'entry locale; il daemon rimanda l'entry aggiornata
  widgetRespond(entryId, value) {
    const id = get().activeId
    if (!id) return
    const s = get()
    set({
      entries: s.entries.map((en) =>
        en.id === entryId ? { ...en, meta: { ...en.meta!, respondedValue: value } } : en
      )
    })
    void api.widgetRespond(id, entryId, value)
  },

  draftSend(entryId, body) {
    const id = get().activeId
    if (!id) return
    void api.draftSend(id, entryId, body).catch((err: unknown) =>
      console.error('draftSend:', err instanceof Error ? err.message : err)
    )
  },

  draftDiscard(entryId) {
    const id = get().activeId
    if (!id) return
    const s = get()
    set({
      entries: s.entries.map((en) =>
        en.id === entryId ? { ...en, meta: { ...en.meta!, status: 'discarded' } } : en
      )
    })
    void api.draftDiscard(id, entryId)
  },

  draftUpdate(entryId, body) {
    const id = get().activeId
    if (!id) return
    const s = get()
    set({
      entries: s.entries.map((en) =>
        en.id === entryId && en.meta?.message
          ? { ...en, meta: { ...en.meta, message: { ...(en.meta.message as Record<string, unknown>), body } } }
          : en
      )
    })
    void api.draftUpdate(id, entryId, body)
  },

  resolveApproval(agentId, approvalId, decision, mode, via) {
    const s = get()
    // AH1 (fase aiutanti): l'ottimistico tocca la lista dove sta la card —
    // entries per l'agente aperto in chat, subEntries per il figlio aperto
    // nel pannello (il clic nel pannello del figlio va al FIGLIO)
    const decided = (en: TranscriptEntry): TranscriptEntry =>
      en.meta?.approvalId === approvalId
        ? { ...en, meta: { ...en.meta!, status: decision === 'allow' ? 'allowed' : 'denied', resolutionMode: mode } }
        : en
    if (agentId === s.activeId) set({ entries: s.entries.map(decided) })
    if (agentId === s.openSubagentId) set({ subEntries: s.subEntries.map(decided) })
    // A2: il «da dove» finisce nel registro — chi non lo dice decide in chat
    void api.resolveApproval(agentId, approvalId, decision, mode, via ?? 'chat')
  },

  // fase 8: la regola proposta si aggiunge SOLO al click (la RPC scrive nei
  // settings); l'entry si aggiorna via evento entries dal daemon
  autoreviewRuleDecision(entryId, action) {
    const id = get().activeId
    if (!id) return
    void api.autoreviewRuleDecision(id, entryId, action).catch((err: unknown) =>
      console.error('autoreviewRuleDecision:', err instanceof Error ? err.message : err)
    )
  },

  // fase 8: apre Impostazioni → Approvazioni con il testo pronto
  // fase 16c (C2): la scheda si chiama Approvazioni
  proposeRule(text) {
    set({ autoreviewPrefill: text, settingsTab: 'approvazioni', settingsOpen: true })
  },

  // fase 16 (U5): creazione dal dialogo "Crea nuovo bot" — aspetto compreso,
  // poi il bot nuovo si seleziona
  async createAgent(name, avatar) {
    const a = await api.createAgent(name)
    if (avatar) await api.updateAgent(a.id, { avatar })
    const agents = await api.listAgents()
    set({ agents })
    await get().select(a.id)
  },

  async setMainAgent(id) {
    await api.setMainAgent(id)
    set({ mainAgentId: id })
  },

  async refreshProviders() {
    set({ providers: await api.listProviders() })
  },

  async refreshPermissions() {
    set({ permissions: await api.getPermissions() })
  },

  async refreshConnectors() {
    set({ connectors: await api.connectorsList() })
    // fase app: lo stato Composio insieme ai connettori (la vista App li usa insieme)
    await api.composioStatus().then((composio) => set({ composio })).catch(() => undefined)
    await api.composioGatewayStatus().then((composioGateway) => set({ composioGateway })).catch(() => undefined)
  },

  // fase Composio OAuth (C5): lo stato del gateway da solo (il foglio di attesa lo chiama in loop)
  async refreshComposioGateway() {
    await api.composioGatewayStatus().then((composioGateway) => set({ composioGateway })).catch(() => undefined)
  },

  // fase app: lo stato Composio da solo (il foglio di attivazione lo chiama
  // in loop mentre aspetta il login nel browser)
  async refreshComposio() {
    await api.composioStatus().then((composio) => set({ composio })).catch(() => undefined)
  },

  // fase 8 (§3bis L7): vista del sotto-transcript di un task
  openTask(id) {
    set({ openTaskId: id })
  },

  // fase 8 (§3bis L7): interruzione dal bottone sulla card del task
  cancelTask(taskId) {
    void api.cancelTask(taskId).catch((err: unknown) =>
      console.error('cancelTask:', err instanceof Error ? err.message : err)
    )
  },

  // fase 10: vista gruppo — i messaggi del gruppo, l'utente scrive con le
  // @menzioni (le legge il daemon quando pianifica i turni)
  openGroup(id) {
    // verifica impostazioni (navigazione): aprire una squadra riporta alla
    // chat; chiuderla (null) non tocca Attività né Libreria
    set(id !== null ? { openGroupId: id, groupMessages: [], activityOpen: false, openLibraryId: null, approvalsQueueOpen: false, approvalsOpen: false, approvalsFocusId: null, pluginOpen: false } : { openGroupId: id, groupMessages: [], approvalsQueueOpen: false })
    if (id !== null) {
      void api.groupMessages(id).then((groupMessages) => set({ groupMessages })).catch(() => undefined)
      void api.groupApprovalCards(id).then((groupCards) => set({ groupCards })).catch(() => undefined)
      void api.groupOverview(id).then((groupOverview) => set({ groupOverview })).catch(() => undefined)
      // Q2 (fase squadra) · C3: la coda della squadra parte col numero giusto
      // (i badge SUBITO: è un'azione dell'utente)
      get().refreshSquadData({ forceBadges: true })
    }
  },

  // fase 10: l'utente scrive nel gruppo aperto
  sendGroupMessage(text) {
    const id = get().openGroupId
    if (id === null || !text.trim()) return
    void api.groupSendUser(id, text.trim()).catch((err: unknown) =>
      console.error('groupSendUser:', err instanceof Error ? err.message : err)
    )
  },

  // fase 12: vista del transcript di un sottoagente (come la vista del task)
  openSubagent(id) {
    set({ openSubagentId: id, subEntries: [] })
    if (id !== null) {
      void api.getEntries(id).then((subEntries) => set({ subEntries })).catch(() => undefined)
    }
  },

  openLibrary(id) {
    // A2: aprire la Libreria chiude il centro «Da approvare» (come Attività);
    // PL1 (fase plugin): chiude anche la pagina Plugin — una vista centrale
    set(id !== null ? { openLibraryId: id, approvalsOpen: false, approvalsFocusId: null, pluginOpen: false } : { openLibraryId: id })
  },

  // PL1 (fase plugin): la pagina Plugin — apre CHIUDENDO le altre viste
  // centrali (regola B1: una sola alla volta, deciso qui) e ricorda il
  // PUNTO chiesto dal rimando (la pagina lo consuma)
  openPlugin(at) {
    set({
      pluginOpen: true,
      pluginAt: at ?? null,
      activityOpen: false,
      openLibraryId: null,
      approvalsOpen: false,
      approvalsFocusId: null,
      approvalsQueueOpen: false
    })
  },

  setPluginOpen(v) {
    set({ pluginOpen: v })
  },

  // fase 16c (C5): la vista centrale «Attività» — A2: aprire lei chiude il
  // centro «Da approvare» e la Libreria (una vista centrale alla volta);
  // PL1 (fase plugin): chiude anche la pagina Plugin
  setActivityOpen(v) {
    set(v ? { activityOpen: true, approvalsOpen: false, approvalsFocusId: null, openLibraryId: null, pluginOpen: false } : { activityOpen: false })
  },

  // fase 16c (C3.2): il modello principale cambia → lo ricordano i bot che lo
  // seguono (il modello eseguito si risolve a ogni turno, nient'altro da fare)
  async setMainModel(m) {
    set({ mainModel: m })
    await api.settingsSet('models.main', m).catch(() => undefined)
  },

  // fase 16c: il pannello del bot su una scheda data (dalle Impostazioni › Routine)
  // fase pagine (G3): computer → la scheda di oggi (560 px); routines → il
  // foglio Impostazioni del bot sulla sezione Routine (dalle Impostazioni)
  openBotTab(tab) {
    set(tab === 'computer'
      ? { botPanelTabRequest: 'computer', rightPanel: true }
      : { botSheetOpen: true, botSheetFocus: 'routines', rightPanel: true })
  },

  // fase 12: il bottone Ferma della card (RPC subagents:stop)
  stopSubagent(id) {
    void api.stopSubagent(id).catch((err: unknown) =>
      console.error('stopSubagent:', err instanceof Error ? err.message : err)
    )
  },

  async onboardingAdvance(step, outcome) {
    const r = await api.onboardingAdvance(step, outcome)
    if (r) set({ onboarding: r })
  },
  async onboardingReopen(target) {
    const r = await api.onboardingReopen(target)
    if (r) set({ onboarding: r })
  },
  async boxSetupStart() {
    const r = await api.boxSetupStart().catch(() => null)
    if (r) set({ boxSetup: r })
  },
  // MB3 (fase modalita-box): la scelta dell'utente — UNA RPC scrive
  // sandbox.mode E sandbox.modeSet insieme (una scelta esplicita non si
  // ribelta MAI); la card «Computer» segue il cambio rileggendo la modalità
  // (il meccanismo di CCK3); «Sul computer del bot» con la preparazione mai
  // fatta (o in errore, o annullata) avvia la preparazione con lo STESSO
  // flusso della guida — boxSetupStart, l'azione del bottone «Prepara il
  // computer», nessun percorso nuovo (il consenso è il clic esplicito sulla
  // scelta, come «Installa» di OB3 nella stessa scheda)
  async sandboxModeSet(mode) {
    const r = await api.boxModeSet(mode).catch(() => null)
    if (!r) return
    await get().readBoxInUse()
    if (mode === 'box') {
      const phase = get().boxSetup?.phase ?? 'idle'
      if (phase === 'idle' || phase === 'error' || phase === 'cancelled') {
        void get().boxSetupStart()
      }
    }
  },
  // CCK1 (fase computer-card-correzioni): la risposta della RPC box:runtime
  // NON si butta via — entra nello store con la STESSA azione dell'evento
  // `box`, e vince il `since` più recente (una risposta più vecchia di un
  // evento già arrivato non lo sovrascrive)
  setBoxRuntime(runtime: BoxRuntime) {
    const cur = get().boxRuntime
    if (cur !== null && runtime.since < cur.since) return
    set({ boxRuntime: runtime })
  },
  async readBoxRuntime() {
    const r = await api.boxRuntime().catch(() => null)
    if (r !== null) get().setBoxRuntime(r)
  },
  async readBoxInUse() {
    const mode = await api.settingsGet<string>('sandbox.mode', 'host').catch(() => null)
    if (mode !== null) set({ boxInUse: mode === 'box' || mode === 'docker' })
  },
  async boxSetupCancel() {
    const r = await api.boxSetupCancel().catch(() => null)
    if (r) set({ boxSetup: r })
  },
  async boxSetupRetry() {
    const r = await api.boxSetupRetry().catch(() => null)
    if (r) set({ boxSetup: r })
  },
  async boxSetupOpenInstaller() {
    const r = await api.boxSetupOpenInstaller().catch(() => null)
    if (r) set({ boxSetup: r })
  },
  setSettingsOpen(v) {
    set({ settingsOpen: v })
  },

  setSettingsTab(v) {
    set({ settingsTab: v })
  },

  // fase 16 (U0): tema e pannello destro — si applicano subito e restano nel setting
  setTheme(t) {
    set({ theme: t })
    applyTheme(t)
    void api.settingsSet('ui.theme', t).catch(() => undefined)
  },

  // fase 17a (L2): la lingua cambia a caldo (activateUiLanguage ricarica il
  // catalogo senza toccare la finestra) e il main ricostruisce il tray
  setUiLanguage(l) {
    const lang = resolveUiLanguage(l, navigator.languages)
    set({ uiLanguage: l, activeLanguage: lang })
    void activateUiLanguage(lang)
    void api.settingsSet('ui.language', l).catch(() => undefined)
    void api.uiLanguageChanged(lang).catch(() => undefined)
  },

  setRightPanel(v) {
    set({ rightPanel: v })
    void api.settingsSet('ui.rightPanel', v).catch(() => undefined)
  },

  // G2 (fase 0.3.1001 grafica): il pannello è stato chiuso → il focus torna
  // al bottone PanelRight che ricompare nella fascia alta
  requestPanelFocusRestore() {
    set({ panelFocusRestore: get().panelFocusRestore + 1 })
  },

  // fase 19b (T1): il pannello «Computer» — la tab si ricorda per bot
  setComputerPanel(open, tab, mode) {
    const s = get()
    const agentId = s.activeId ?? ''
    let next = tab
    if (open && !next && agentId) next = s.computerTabByAgent[agentId] ?? 'activity'
    set({
      computerPanel: {
        open,
        tab: next ?? s.computerPanel.tab,
        mode: mode ?? s.computerPanel.mode
      },
      ...(open && next && agentId ? { computerTabByAgent: { ...s.computerTabByAgent, [agentId]: next } } : {})
    })
  },

  // fase 16 (U3): solo i cambiamenti di stato passano (niente set per tasto)
  setTyping(agentId) {
    if (get().typingAgentId !== agentId) set({ typingAgentId: agentId })
  },

  clearBotPanelTabRequest() {
    set({ botPanelTabRequest: null })
  },

  // fase pagine (G3): il foglio «Impostazioni del bot»
  openBotSheet(focus) {
    set({ botSheetOpen: true, botSheetFocus: focus ?? null, rightPanel: true })
  },

  closeBotSheet() {
    set({ botSheetOpen: false, botSheetFocus: null })
  },

  // RV4 (fase beta.2): il foglio del modello del bot (il pannello serve: la
  // riga del modello vive lì, e chi arriva dalla notice la trova aperta)
  openBotModel() {
    set({ botModelOpen: true, rightPanel: true })
  },

  closeBotModel() {
    set({ botModelOpen: false })
  },

  // fase pagine (G2): la pagina aperta al posto della chat; title/version li
  // riempie la vista (il compositore li mette nella riga per il modello)
  openPage(id, from) {
    set({ openPageInfo: { id, from, title: '', version: 0 } })
  },

  closePage() {
    set({ openPageInfo: null })
  },

  setPageMeta(meta) {
    const p = get().openPageInfo
    if (p) set({ openPageInfo: { ...p, ...meta } })
  },

  // fase pagine (G4): la richiesta della routine finisce nel compositore
  setComposerPrefill(text) {
    set({ composerPrefill: text })
  },

  // fase pagine (G4): la finestra App sul dettaglio di quell'app
  setMemoryOpen(v) {
    set({ memoryOpen: v })
    // fase chat-limiti (CL7): il pannello si apre senza focus se si chiude
    if (!v) set({ memoryFocusId: null })
  },

  // fase chat-limiti (CL7): apre la sezione Memoria su UNA voce (quella in
  // quarantena della riga di sistema sotto il turno)
  openMemoryNote(id) {
    set({ memoryOpen: true, memoryFocusId: id })
  },

  // fase skill: il filtro bot della finestra «Skill»
  setSkillsFilterAgent(v) {
    set({ skillsFilterAgent: v })
  },

  // fase 16b (S3.3): la voce di debug — si applica e resta nel setting
  setDebugSteps(v) {
    set({ debugSteps: v })
    void api.settingsSet('ui.debugSteps', v).catch(() => undefined)
  },

  // fase 16b (S1.3): squadre dalla UI — dopo ogni azione la lista si ricarica
  // (l'evento groups del daemon arriva comunque)
  async groupCreate(name, memberIds, coordinatorId, description) {
    await api.groupCreate(name, memberIds, coordinatorId, description)
    const groups = await api.listGroups().catch(() => get().groups)
    set({ groups })
  },

  // C3 (fase squadra-correzioni): l'UNICO refresh della squadra — coalescente.
  // Ogni evento groups/agents/approval CHIEDE il refresh; la passata parte
  // 200 ms dopo l'ULTIMO (trailing) e legge tutto insieme: lista dei gruppi,
  // agenti, messaggi/card/overview/pendenti della squadra APERTA. Ogni lettura
  // scrive DA SÉ il suo pezzo, SOLO se è cambiato (confronto leggero per
  // valore): una lettura lenta o persa non blocca le altre — niente set
  // accoppiati ad ariafamiglia — e React non ri-renderizza la timeline a vuoto
  // quando il dato è identico. I badge delle ALTRE squadre (il numero della
  // barra laterale) al massimo ogni 2 s; quello della squadra aperta deriva
  // dalle sue pendenti.
  refreshSquadData(opts: { forceBadges?: boolean } = {}) {
    // la PRIMA richiesta della raffica apre la finestra, le altre aspettano:
    // UNA passata per raffica, matura 200 ms dopo la sua prima richiesta
    if (!squadPending) {
      squadPending = true
      squadFirstPendingAt = Date.now()
    }
    if (opts.forceBadges) squadForceBadges = true
    if (!squadPass) squadPass = (f) => { get()._squadRefreshPass(f) }
    // l'azione dell'utente (aprire la squadra, decidere dalla coda) non aspetta
    if (opts.forceBadges) {
      squadPending = false
      if (squadTimer) { clearTimeout(squadTimer); squadTimer = null }
      const force = squadForceBadges
      squadForceBadges = false
      squadPass?.(force)
      return
    }
    // A5: UN solo setTimeout per il trailing a finestra visibile (niente più
    // canale che si rimanda messaggi in un giro continuo di task)
    if (!squadTimer) squadTimer = setTimeout(squadTryRun, 250)
    // la via maestra: se la passata è GIÀ matura, parte ADESSO nel task
    // dell'evento — i task IPC non vengono strozzati dalla finestra coperta
    squadTryRun()
  },

  // C3: la passata del refresh coalescente (il canale la fa scattare 200 ms
  // dopo l'ultima richiesta; il corpo vive qui per leggere get()/set())
  _squadRefreshPass(forceBadges: boolean) {
    {
      const apply = (k: string, v: unknown): void => {
        const cur = get() as unknown as Record<string, unknown>
        if (JSON.stringify(cur[k]) === JSON.stringify(v)) return
        set({ [k]: v } as unknown as Partial<Store>)
      }
      const countsOf = (): Record<number, number> => {
        const c = (get() as unknown as Record<string, unknown>).groupPendingCount
        return c && typeof c === 'object' ? { ...(c as Record<number, number>) } : {}
      }
      const gid = get().openGroupId
      void api.listGroups().then((groups) => apply('groups', groups)).catch(() => undefined)
      void api.listAgents().then((agents2) => apply('agents', agents2)).catch(() => undefined)
      // D2 (fase deleghe): lo stato dei job delle deleghe accodate (la riga
      // «In coda per <bot> · parte alle HH:MM» in chat) — UNA chiamata per
      // passata, solo se la chat aperta ha deleghe in attesa
      const delegationJobs = collectDelegationJobs(get().entries)
      if (delegationJobs.length) {
        void api.delegationsStatus(delegationJobs.map((d) => d.jobId))
          .then((statuses) => apply('delegationStatuses', statuses))
          .catch(() => undefined)
      }
      // A1/A2/A5 (fase centro-autorizzazioni): UNA chiamata per passata per
      // TUTTE le richieste pendenti — alimenta il centro, il riquadro delle
      // chat e i numeri della barra laterale (squadre e bot singoli)
      void api.approvalsPendingAll()
        .then((approvalsAll) => {
          apply('approvalsAll', approvalsAll)
          // A3 (fase approvazioni-chiare): il numero delle richieste in attesa
          // sull'icona del Dock — 0 lo toglie (una chiamata per passata)
          void api.setDockBadge(approvalsAll.length).catch(() => undefined)
          const squadCounts: Record<number, number> = {}
          const botCounts: Record<string, number> = {}
          for (const r of approvalsAll) {
            if (r.squad) squadCounts[r.squad.id] = (squadCounts[r.squad.id] ?? 0) + 1
            else botCounts[r.botId] = (botCounts[r.botId] ?? 0) + 1
          }
          apply('groupPendingCount', squadCounts)
          apply('approvalsBotCount', botCounts)
        })
        .catch(() => undefined)
      if (gid !== null) {
        void api.groupMessages(gid).then((groupMessages) => apply('groupMessages', groupMessages)).catch(() => undefined)
        void api.groupApprovalCards(gid).then((groupCards) => apply('groupCards', groupCards)).catch(() => undefined)
        void api.groupOverview(gid).then((groupOverview) => apply('groupOverview', groupOverview)).catch(() => undefined)
        void api.groupPendingApprovals(gid)
          .then((r) => {
            apply('groupPending', r.pending)
            apply('groupActivity', r.activity)
            apply('groupReviewerPassed', r.reviewerPassed)
            // il badge della squadra aperta deriva dalle SUE pendenti
            apply('groupPendingCount', { ...countsOf(), [gid]: r.pending.length })
          })
          .catch(() => undefined)
      }
      // (i badge delle altre squadre derivano da approvals:pending-all —
      // una sola chiamata per passata, niente giro per squadra)
      void forceBadges
    }
  },

  setApprovalsQueueOpen(open) {
    set({ approvalsQueueOpen: open })
  },

  // D2 (fase deleghe): l'Annulla della riga «In coda per <bot>» — il job
  // esce dalla coda (il messaggio non parte) e il refresh porta la riga via
  async cancelDelegation(jobId: number) {
    await api.delegationsCancel(jobId).catch(() => undefined)
    get().refreshSquadData()
  },

  // A2 (fase centro-autorizzazioni): il centro «Da approvare» — apre su una
  // richiesta precisa (dal riquadro in cima alle chat o dalla notifica) o
  // sull'insieme; copre l'area centrale come Attività e Libreria
  // A2: «Registro di oggi» e le schede del centro — la vista del registro
  setApprovalsView(view) {
    set({ approvalsView: view })
  },
  // R1 (fase ritocchi-beta18): il riquadro sopra il campo mostra UNA richiesta
  // per volta quando il bot ne ha diverse in attesa — questa è la scelta
  setComposerApprovalIndex(index) {
    set({ composerApprovalIndex: index })
  },

  clearApprovalsNotificationFocus() {
    set({ approvalsNotificationFocus: null })
  },

  setApprovalsOpen(open, focusId = null) {
    set(open ? { approvalsOpen: true, approvalsFocusId: focusId, approvalsView: 'richieste', activityOpen: false, openLibraryId: null, approvalsQueueOpen: false, pluginOpen: false } : { approvalsOpen: false, approvalsFocusId: null, approvalsView: 'richieste' })
    if (open) get().refreshSquadData({ forceBadges: true })
  },

  // A2: «Rimanda» — solo nella VISTA: la richiesta resta in attesa nel bot e
  // il conteggio della barra laterale la conta ancora. Stato in un setting.
  approvalsSnooze(approvalId) {
    const now = Date.now()
    const snoozed: Record<string, number> = {}
    for (const [id, until] of Object.entries(get().approvalsSnoozed)) {
      if (until > now) snoozed[id] = until
    }
    snoozed[approvalId] = now + APPROVALS_SNOOZE_MS
    set({ approvalsSnoozed: snoozed })
    void api.settingsSet('approvals.snoozed', snoozed).catch(() => undefined)
    // all'ora esatta la richiesta torna visibile da sola
    const ms = APPROVALS_SNOOZE_MS + 5
    const t = setTimeout(() => {
      const cur = get().approvalsSnoozed
      if (cur[approvalId] !== undefined && Date.now() >= cur[approvalId]!) {
        const next = { ...cur }
        delete next[approvalId]
        set({ approvalsSnoozed: next })
      }
    }, ms)
  },

  setApprovalsBannerCollapsed(v) {
    set({ approvalsBannerCollapsed: v })
  },

  resolveGroupApproval(agentId, approvalId, decision, mode) {
    // l'ottimistico della chat del bot lo fa la resolveApproval di oggi
    get().resolveApproval(agentId, approvalId, decision, mode)
    // la riga esce dalla coda subito
    const s = get()
    set({ groupPending: s.groupPending.filter((r) => !(r.agentId === agentId && r.approvalId === approvalId)) })
    // l'azione dell'utente forza anche i badge (la coda si è svuotata)
    s.refreshSquadData({ forceBadges: true })
  },

  async groupUpdate(groupId, patch) {
    await api.groupUpdate(groupId, patch)
    const groups = await api.listGroups().catch(() => get().groups)
    set({ groups })
    if (get().openGroupId === groupId) {
      api.groupMessages(groupId).then((groupMessages) => set({ groupMessages })).catch(() => undefined)
    }
  },

  async groupDelete(groupId) {
    await api.groupDelete(groupId)
    const groups = await api.listGroups().catch(() => get().groups)
    // la squadra aperta, se è lei, si chiude
    set({ groups, ...(get().openGroupId === groupId ? { openGroupId: null, groupMessages: [] } : {}) })
  },

  // ---- K2 (fase team-bot): archiviare, eliminare, ripristinare ----

  setSidebarArchivedOpen(v) {
    set({ sidebarArchivedOpen: v })
  },

  /** dopo archivia/elimina: se il bot attivo non è più vivo, si seleziona il primo che lo è */
  selectFallbackAlive() {
    const s = get()
    const live = s.agents.filter((a) => !a.parentId && !a.archivedAt && !a.deletedAt)
    if (live.some((a) => a.id === s.activeId)) return
    const fallback = live.find((a) => a.id === s.mainAgentId) ?? live[0]
    if (fallback) void get().select(fallback.id)
  },

  async archiveAgent(id) {
    await api.archiveAgent(id).catch((e) => console.error('archiveAgent:', e instanceof Error ? e.message : e))
    const agents = (await api.listAgents().catch(() => null)) ?? get().agents
    set({ agents })
    get().selectFallbackAlive()
  },

  async unarchiveAgent(id) {
    await api.unarchiveAgent(id).catch((e) => console.error('unarchiveAgent:', e instanceof Error ? e.message : e))
    const agents = (await api.listAgents().catch(() => null)) ?? get().agents
    set({ agents })
  },

  async restoreAgent(id) {
    await api.restoreAgent(id).catch((e) => console.error('restoreAgent:', e instanceof Error ? e.message : e))
    const agents = (await api.listAgents().catch(() => null)) ?? get().agents
    set({ agents })
  },

  async deleteAgentWithUndo(id) {
    const name = get().agents.find((a) => a.id === id)?.name ?? ''
    await api.deleteAgent(id).catch((e) => console.error('deleteAgent:', e instanceof Error ? e.message : e))
    const agents = (await api.listAgents().catch(() => null)) ?? get().agents
    set({ agents })
    // l'avviso «Eliminato · Annulla» vive 10 secondi, poi si spegne da sé
    armRemovedUndo({ kind: 'bot', id, name, expiresAt: Date.now() + 10_000 })
    get().selectFallbackAlive()
  },

  async groupArchive(groupId) {
    await api.groupArchive(groupId).catch((e) => console.error('groupArchive:', e instanceof Error ? e.message : e))
    const groups = (await api.listGroups().catch(() => null)) ?? get().groups
    set({ groups, ...(get().openGroupId === groupId ? { openGroupId: null, groupMessages: [] } : {}) })
  },

  async groupUnarchive(groupId) {
    await api.groupUnarchive(groupId).catch((e) => console.error('groupUnarchive:', e instanceof Error ? e.message : e))
    const groups = (await api.listGroups().catch(() => null)) ?? get().groups
    set({ groups })
  },

  async groupRestore(groupId) {
    await api.groupRestore(groupId).catch((e) => console.error('groupRestore:', e instanceof Error ? e.message : e))
    const groups = (await api.listGroups().catch(() => null)) ?? get().groups
    set({ groups })
  },

  async groupDeleteWithUndo(groupId, alsoDeleteMembers = false) {
    const name = get().groups.find((g) => g.id === groupId)?.name ?? ''
    await api.groupDelete(groupId, alsoDeleteMembers).catch((e) => console.error('groupDelete:', e instanceof Error ? e.message : e))
    const [groups, agents] = await Promise.all([
      api.listGroups().catch(() => null),
      api.listAgents().catch(() => null)
    ])
    set({ groups: groups ?? get().groups, agents: agents ?? get().agents, ...(get().openGroupId === groupId ? { openGroupId: null, groupMessages: [] } : {}) })
    armRemovedUndo({ kind: 'team', id: String(groupId), name, expiresAt: Date.now() + 10_000 })
    get().selectFallbackAlive()
  },

  async undoRemoved() {
    const u = get().removedUndo
    if (!u) return
    clearRemovedUndoTimer()
    set({ removedUndo: null })
    if (u.kind === 'bot') await get().restoreAgent(u.id)
    else await get().groupRestore(Number(u.id))
  }
}))

/** K2: il timer dell'avviso «Eliminato · Annulla» (10 secondi). */
let removedUndoTimer: ReturnType<typeof setTimeout> | null = null
function clearRemovedUndoTimer(): void {
  if (removedUndoTimer) {
    clearTimeout(removedUndoTimer)
    removedUndoTimer = null
  }
}
function armRemovedUndo(u: { kind: 'bot' | 'team'; id: string; name: string; expiresAt: number }): void {
  clearRemovedUndoTimer()
  useStore.setState({ removedUndo: u })
  removedUndoTimer = setTimeout(() => {
    removedUndoTimer = null
    useStore.setState({ removedUndo: null })
  }, 10_000)
}

export { api }

// ---- fase 16c correzioni (R4): il modello risolto, UN solo punto anche nel renderer ----

/**
 * Il selettore del modello risolto di un bot: la STESSA resolveAgentModel del
 * daemon (src/shared/agent-model.ts) con i dati dello store — il modello
 * proprio se il suo provider è attivo, il principale se segue («Come gli
 * altri») o se il suo provider è sparito (ownModelMissing), null altrimenti.
 * Chat, RightPanel e Sidebar passano tutti da qui: nessuna copia a mano
 * della regola «null/null → models.main».
 */
export function resolvedModelOf(agentId: string | null | undefined): ResolvedAgentModel | null {
  const s = useStore.getState()
  const agent = s.agents.find((a) => a.id === agentId)
  if (!agent) return null
  return resolveAgentModel(agent, s.mainModel, s.providers.map((p) => ({ id: p.id, enabled: p.enabled })))
}

/** Il selettore come hook: si ricalcola quando cambiano il bot, il principale o i provider. */
export function useResolvedModel(agentId: string | null | undefined): ResolvedAgentModel | null {
  const agent = useStore((s) => (agentId ? s.agents.find((a) => a.id === agentId) ?? null : null))
  const mainModel = useStore((s) => s.mainModel)
  const providers = useStore((s) => s.providers)
  return useMemo(
    () => (agent ? resolveAgentModel(agent, mainModel, providers.map((p) => ({ id: p.id, enabled: p.enabled }))) : null),
    [agent, mainModel, providers]
  )
}
