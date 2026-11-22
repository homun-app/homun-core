// A3 (fase approvazioni-chiare): il riquadro in cima alle chat — DIFETTO del
// 22/11: «la notifica in alto quasi non la vedo», lontana da dove si guarda.
// ORA in cima resta SOLO l'indicazione ridotta «+N altrove» per le richieste
// di ALTRI bot o squadre; la richiesta del bot aperto sta sopra il campo di
// scrittura (approvals-composer.test.ts). Nella chat di squadra resta la
// barra di Q2 e il riquadro compare solo per richieste ALTROVE.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll } from './render-helper'
import type { ApprovalsCenterRow, TranscriptEntry } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => ({}) as never)
vi.mock('../components/ComputerPanel', () => ({ ComputerPanel: () => null }))
vi.mock('../components/PageView', () => ({ PageView: () => null }))
vi.mock('../components/MemoryPanel', () => ({ MemoryPanel: () => null }))

const { Chat } = await import('../components/Chat')
const { TeamChat } = await import('../components/TeamChat')
const { useStore } = await import('../store')

const row = (over: Partial<ApprovalsCenterRow> = {}): ApprovalsCenterRow => ({
  agentId: 'a-turismo', agentName: 'Turismo', parentId: null, parentName: null, fromSubagent: false,
  botId: 'a-turismo', botName: 'Turismo', squad: { id: 1, name: 'Weekend Torino' },
  approvalId: 'ap-1', entryId: 1, tool: 'fill_credential', phrase: 'Compilare il modulo del Museo Egizio.',
  category: 'dati-tuoi', why: null, when: Date.now() - 120_000, isDraft: false, preview: null,
  ...over
})

const agent = { id: 'bot-chat', name: 'Bot', description: '', providerId: null, model: null, status: 'offline', unread: 0, createdAt: 1 }
const botMessage = (id: number): TranscriptEntry => ({
  id, agentId: 'bot-chat', kind: 'send-message', role: 'assistant', content: `messaggio numero ${id} con un po' di testo`, meta: { message: { type: 'text' } }, createdAt: id
})

function renderBotChat(entries: TranscriptEntry[], approvalsAll: ApprovalsCenterRow[], patch: Record<string, unknown> = {}): ReturnType<typeof parseHtml> {
  setStoreStateForRender(useStore, {
    rightPanel: false, openGroupId: null, activeId: 'bot-chat', agents: [agent],
    providers: [], mainModel: null, entries, tasks: [], botModelOpen: false, settingsOpen: false, settingsTab: null,
    approvalsAll, approvalsSnoozed: {}, approvalsOpen: false, approvalsBannerCollapsed: false,
    approvalsBotCount: {}, groupPendingCount: {},
    ...patch
  })
  return parseHtml(renderHtml(createElement(Chat, {})))
}

const group = {
  id: 7, name: 'Weekend Torino', description: '', createdBy: 'user', coordinatorId: 'a1',
  members: [{ agentId: 'a1', name: 'Capo', coordinator: true }],
  createdAt: 1, lastMessageAt: null, autonomy: 'box' as const
}

function renderSquadChat(approvalsAll: ApprovalsCenterRow[], groupPending: Array<Record<string, unknown>> = []): ReturnType<typeof parseHtml> {
  setStoreStateForRender(useStore, {
    openGroupId: 7, groups: [group], groupMessages: [], groupCards: [], groupPending,
    groupPendingCount: {}, groupActivity: [], groupReviewerPassed: [], approvalsQueueOpen: false,
    agents: [agent], approvalsAll, approvalsSnoozed: {}, approvalsOpen: false, approvalsBannerCollapsed: false
  })
  return parseHtml(renderHtml(createElement(TeamChat)))
}

beforeEach(() => {
  useStore.setState({ approvalsAll: [], approvalsSnoozed: {}, approvalsBannerCollapsed: false })
})

describe('A3: il riquadro in cima resta SOLO per gli ALTRI («+N altrove»)', () => {
  it('nella chat del bot: le richieste di altri bot → «+N altrove», quelle del bot aperto NO', () => {
    const own = row({ agentId: 'bot-chat', agentName: 'Bot', botId: 'bot-chat', botName: 'Bot', squad: null, approvalId: 'ap-mio' })
    const other = row({ approvalId: 'ap-altro', when: 1 })
    const tree = renderBotChat([botMessage(1)], [own, other])
    const banner = findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-banner')[0]
    expect(banner).toBeTruthy()
    const text = textOf(banner!)
    expect(text).toContain('+1 altrove')
    expect(text).not.toContain('Compilare il modulo del Museo Egizio.')
    // la richiesta del bot aperto NON sta nel banner: sta sopra il campo
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'composer-approval').length).toBe(1)
  })

  it('con SOLO la richiesta del bot aperto: nessun banner in cima', () => {
    const own = row({ agentId: 'bot-chat', agentName: 'Bot', botId: 'bot-chat', botName: 'Bot', squad: null })
    const tree = renderBotChat([botMessage(1)], [own])
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-banner').length).toBe(0)
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'composer-approval').length).toBe(1)
  })

  it('con 0 richieste: né banner né riquadro sopra il campo', () => {
    const tree = renderBotChat([botMessage(1)], [])
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-banner').length).toBe(0)
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'composer-approval').length).toBe(0)
  })

  it('nella chat di squadra resta la barra di Q2: il riquadro globale SOLO per richieste ALTROVE, ridotto', () => {
    // solo richieste della squadra aperta: nessun riquadro globale
    let tree = renderSquadChat([row({ squad: { id: 7, name: 'Weekend Torino' } })], [{ agentId: 'a1', agentName: 'Capo', approvalId: 'q1', tool: 'run-command', phrase: 'x', category: 'mac', why: null, when: 1, fromSubagent: false }])
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-banner').length).toBe(0)
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'team-pending-bar').length).toBe(1)
    // richieste di ALTRE squadre o bot: «+N altrove»
    tree = renderSquadChat([
      row({ squad: { id: 7, name: 'Weekend Torino' } }),
      row({ approvalId: 'alt', squad: { id: 2, name: 'Fatture marzo' }, when: 1 }),
      row({ approvalId: 'bot', squad: null, botId: 'a-ric', botName: 'Ricerche', when: 2 })
    ])
    const banner = findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-banner')[0]
    expect(banner).toBeTruthy()
    expect(textOf(banner!)).toContain('+2 altrove')
  })
})
