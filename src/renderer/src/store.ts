// State renderer: agenti, transcript dell'agente attivo, eventi dal main.
import { create } from 'zustand'
import type { Agent, TranscriptEntry, SandbotEvent, ProviderConfig, PermissionsConfig, ConnectorInfo, TaskInfo, GroupInfo, GroupMessageInfo, SubagentInfo, AgentAvatar, TurnEnd, ScreenStatus } from '../../shared/types'

/** Fase 19b (T1): le schede del pannello «Computer» del bot. */
export type ComputerTab = 'screen' | 'terminal' | 'files' | 'activity'
import type { UiTheme } from './theme'
import { applyTheme, watchSystemTheme } from './theme'
import { previewOf, type SidebarPreview } from './sidebar-utils'
import { activateUiLanguage } from './lib/i18n'
import { resolveUiLanguage, type UiLanguageSetting, type UiLanguage } from '../../shared/ui-language'

const api = (window as unknown as { sandbot: import('../../shared/types').SandbotApi }).sandbot

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
  activeId: string | null
  entries: TranscriptEntry[]
  reasoning: Record<number, string>
  providers: ProviderConfig[]
  permissions: PermissionsConfig | null
  /** fase 5: catalogo "Connetti app" con lo stato di ogni connettore */
  connectors: ConnectorInfo[]
  /** fase 7: setting mainAgentId (null → il primo agente è quello principale) */
  mainAgentId: string | null
  settingsOpen: boolean
  /** fase 7: tab da aprire alla prossima apertura delle Impostazioni (onboarding provider) */
  settingsTab: string | null
  /** fase 8: testo con cui precompilare l'editor delle regole di auto-review */
  autoreviewPrefill: string | null
  /** fase 8 (§3bis L7): task di tutti gli agenti (card in chat + sidebar) */
  tasks: TaskInfo[]
  /** fase 8 (§3bis L7): task aperto nella vista del sotto-transcript */
  openTaskId: number | null
  /** fase 8 (§3bis L7): stato live "sta facendo X…" per agente */
  activity: Record<string, { tool: string; target: string } | null>
  /** fase 10: gruppi (sidebar) */
  groups: GroupInfo[]
  /** fase 10: gruppo aperto nella vista gruppo */
  openGroupId: number | null
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
   * Fase 19b (T1): il pannello «Computer» del bot — quattro schede (Schermo,
   * Terminale, File, Attività) e, per lo Schermo, il modo (vista/controllo).
   */
  computerPanel: { open: boolean; tab: ComputerTab; mode: 'view' | 'control' }
  /** fase 19b (T1): l'ultima scheda usata PER BOT (si riparte da lì) */
  computerTabByAgent: Record<string, ComputerTab>
  /** fase 19a (V3.4): ultimo stato dello schermo per bot (evento screen) */
  screenStatus: Record<string, ScreenStatus>
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
  skillsOpen: boolean
  /** fase 16b (S3.2): «rispondi citando» — la citazione da inserire nel composer */
  quote: string | null
  setQuote(text: string | null): void
  /**
   * Fase 16b (S3.3): «Mostra i passaggi in chat» (Impostazioni › Generali,
   * default spenta) — rimette le righe tool-call/tool-result di oggi.
   */
  debugSteps: boolean
  setDebugSteps(v: boolean): void
  /** fase 16b (S4): il pannello del bot si apre (o cambia) su una scheda data */
  botPanelTabRequest: 'profile' | 'computer' | 'routines' | 'advanced' | null
  openBotAdvanced(): void
  clearBotPanelTabRequest(): void
  /** fase 16b (S1.3): crea/modifica/cancella squadre dalla UI */
  groupCreate(name: string, memberIds: string[], coordinatorId: string, description?: string): Promise<void>
  groupUpdate(groupId: number, patch: {
    name?: string
    description?: string
    addMemberIds?: string[]
    removeMemberIds?: string[]
    coordinatorId?: string
  }): Promise<void>
  groupDelete(groupId: number): Promise<void>
  init(): Promise<void>
  select(agentId: string): Promise<void>
  send(text: string, images?: string[]): Promise<void>
  interrupt(): void
  // fase 3: risposta a un widget e azioni sulle bozze
  widgetRespond(entryId: number, value: string | string[]): void
  draftSend(entryId: number, body?: string): void
  draftDiscard(entryId: number): void
  draftUpdate(entryId: number, body: string): void
  /** fase 8: mode 'once' | 'always' | 'turn' (fino a fine turno) */
  resolveApproval(approvalId: string, decision: 'allow' | 'deny', mode: 'once' | 'always' | 'turn'): void
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
  /** fase 8 (§3bis L7): apre/chiude la vista del sotto-transcript di un task */
  openTask(id: number | null): void
  /** fase 8 (§3bis L7): interrompe un task dal bottone sulla card */
  cancelTask(taskId: number): void
  /** fase 10: apre la vista di un gruppo (o torna alla chat) */
  openGroup(id: number | null): void
  /** fase 10: l'utente scrive nel gruppo (@menzioni comprese) */
  sendGroupMessage(text: string): void
  /** fase 12: apre/chiude la vista del transcript di un sottoagente */
  openSubagent(id: string | null): void
  /** fase 14: apre la Libreria (null = chiusa, '' = lista, id = voce) */
  openLibrary(id: string | null): void
  /** fase 14: la libreria aperta (null = chiusa, '' = lista, id = voce) */
  openLibraryId: string | null
  /** fase 12: bottone Ferma sulla card del sottoagente */
  stopSubagent(id: string): void
  setSettingsOpen(v: boolean): void
  setSettingsTab(v: string | null): void
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
  setSkillsOpen(v: boolean): void
}

export const useStore = create<Store>((set, get) => ({
  agents: [],
  activeId: null,
  entries: [],
  reasoning: {},
  providers: [],
  permissions: null,
  connectors: [],
  mainAgentId: null,
  settingsOpen: false,
  settingsTab: null,
  autoreviewPrefill: null,
  tasks: [],
  openTaskId: null,
  activity: {},
  groups: [],
  openGroupId: null,
  groupMessages: [],
  subagents: [],
  openSubagentId: null,
  subEntries: [],
  openLibraryId: null,
  // fase 16
  theme: 'system',
  // fase 17a (L2)
  uiLanguage: 'system',
  activeLanguage: 'it',
  rightPanel: true,
  computerPanel: { open: false, tab: 'activity', mode: 'view' },
  computerTabByAgent: {},
  screenStatus: {},
  typingAgentId: null,
  lastDeltaAt: {},
  lastSendAt: {},
  turnEnds: {},
  nowTick: 0,
  previews: {},
  memoryOpen: false,
  skillsOpen: false,
  quote: null,
  botPanelTabRequest: null,
  debugSteps: false,

  async init() {
    const agents = await api.listAgents()
    const providers = await api.listProviders()
    const permissions = await api.getPermissions()
    const activeId = agents[0]?.id ?? null
    // fase 7: il bot principale per il badge (null → il primo agente)
    const mainAgentId = await api.settingsGet<string | null>('mainAgentId', null).catch(() => null)
    set({ agents, providers, permissions, activeId, mainAgentId })
    // fase 16 (U0): tema e pannello destro; con 'system' si segue il sistema
    const theme = await api.settingsGet<UiTheme>('ui.theme', 'system').catch(() => 'system' as UiTheme)
    const rightPanel = await api.settingsGet<boolean>('ui.rightPanel', true).catch(() => true)
    set({ theme, rightPanel })
    // fase 16b (S3.3): la voce di debug «Mostra i passaggi in chat»
    const debugSteps = await api.settingsGet<boolean>('ui.debugSteps', false).catch(() => false)
    set({ debugSteps })
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
          void api.listAgents().then((agents2) => set({ agents: agents2 }))
          break
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
        case 'approval': {
          if (e.agentId === s.activeId) {
            const merged = [...s.entries]
            const i = merged.findIndex((x) => x.meta?.approvalId === e.approval.id)
            if (i >= 0) merged[i] = { ...merged[i], meta: { ...merged[i].meta!, status: e.approval.status } }
            set({ entries: merged })
          }
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
        // fase 10: un gruppo o i suoi messaggi sono cambiati (sidebar + vista)
        case 'groups': {
          api.listGroups().then((groups) => set({ groups })).catch(() => undefined)
          if (s.openGroupId !== null) {
            api.groupMessages(s.openGroupId).then((groupMessages) => set({ groupMessages })).catch(() => undefined)
          }
          break
        }
        // fase 16b (S1.2): apri la squadra (notifica del riepilogo del coordinatore)
        case 'open-group': {
          s.openGroup(e.groupId)
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
    set({ activeId: agentId, entries: [], openSubagentId: null, subEntries: [], typingAgentId: null, openGroupId: null, groupMessages: [] })
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

  async send(text, images) {
    const id = get().activeId
    if (!id || !text.trim()) return
    await api.sendMessage(id, text.trim(), images)
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

  resolveApproval(approvalId, decision, mode) {
    const id = get().activeId
    if (!id) return
    const s = get()
    set({
      entries: s.entries.map((en) =>
        en.meta?.approvalId === approvalId
          ? { ...en, meta: { ...en.meta!, status: decision === 'allow' ? 'allowed' : 'denied', resolutionMode: mode } }
          : en
      )
    })
    void api.resolveApproval(id, approvalId, decision, mode)
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

  // fase 8: apre Impostazioni → Approvazione automatica con il testo pronto
  proposeRule(text) {
    set({ autoreviewPrefill: text, settingsTab: 'autoreview', settingsOpen: true })
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
  openGroup(id) {    set({ openGroupId: id, groupMessages: [] })
    if (id !== null) {
      void api.groupMessages(id).then((groupMessages) => set({ groupMessages })).catch(() => undefined)
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
    set({ openLibraryId: id })
  },

  // fase 12: il bottone Ferma della card (RPC subagents:stop)
  stopSubagent(id) {
    void api.stopSubagent(id).catch((err: unknown) =>
      console.error('stopSubagent:', err instanceof Error ? err.message : err)
    )
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

  setQuote(text) {
    set({ quote: text })
  },

  // fase 16b (S4): le Impostazioni › Bot rimandano qui
  openBotAdvanced() {
    set({ botPanelTabRequest: 'advanced', rightPanel: true })
  },

  clearBotPanelTabRequest() {
    set({ botPanelTabRequest: null })
  },

  setMemoryOpen(v) {
    set({ memoryOpen: v })
  },

  setSkillsOpen(v) {
    set({ skillsOpen: v })
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
  }
}))

export { api }
