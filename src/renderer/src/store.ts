// State renderer: agenti, transcript dell'agente attivo, eventi dal main.
import { create } from 'zustand'
import type { Agent, TranscriptEntry, SandbotEvent, ProviderConfig, PermissionsConfig, ConnectorInfo } from '../../shared/types'

const api = (window as unknown as { sandbot: import('../../shared/types').SandbotApi }).sandbot

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
  init(): Promise<void>
  select(agentId: string): Promise<void>
  send(text: string, images?: string[]): Promise<void>
  interrupt(): void
  // fase 3: risposta a un widget e azioni sulle bozze
  widgetRespond(entryId: number, value: string | string[]): void
  draftSend(entryId: number, body?: string): void
  draftDiscard(entryId: number): void
  draftUpdate(entryId: number, body: string): void
  resolveApproval(approvalId: string, decision: 'allow' | 'deny', always: boolean): void
  createAgent(name: string): Promise<void>
  /** fase 7: "Rendi principale" nelle impostazioni dell'agente */
  setMainAgent(id: string): Promise<void>
  refreshProviders(): Promise<void>
  refreshPermissions(): Promise<void>
  refreshConnectors(): Promise<void>
  setSettingsOpen(v: boolean): void
  setSettingsTab(v: string | null): void
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

  async init() {
    const agents = await api.listAgents()
    const providers = await api.listProviders()
    const permissions = await api.getPermissions()
    const activeId = agents[0]?.id ?? null
    // fase 7: il bot principale per il badge (null → il primo agente)
    const mainAgentId = await api.settingsGet<string | null>('mainAgentId', null).catch(() => null)
    set({ agents, providers, permissions, activeId, mainAgentId })
    if (activeId) {
      set({ entries: await api.getEntries(activeId) })
    }
    // fase 5: catalogo connettori (per la vista Impostazioni e le card in chat)
    api.connectorsList().then((connectors) => set({ connectors })).catch(() => undefined)
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
      }
    })
  },

  async select(agentId) {
    set({ activeId: agentId, entries: [] })
    set({ entries: await api.getEntries(agentId) })
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

  resolveApproval(approvalId, decision, always) {
    const id = get().activeId
    if (!id) return
    const s = get()
    set({
      entries: s.entries.map((en) =>
        en.meta?.approvalId === approvalId ? { ...en, meta: { ...en.meta!, status: decision === 'allow' ? 'allowed' : 'denied' } } : en
      )
    })
    void api.resolveApproval(id, approvalId, decision, always)
  },

  async createAgent(name) {
    await api.createAgent(name)
    const agents = await api.listAgents()
    set({ agents })
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

  setSettingsOpen(v) {
    set({ settingsOpen: v })
  },

  setSettingsTab(v) {
    set({ settingsTab: v })
  }
}))

export { api }
