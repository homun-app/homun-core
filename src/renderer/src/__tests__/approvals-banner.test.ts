// A3 (fase centro-autorizzazioni): il riquadro in cima alle chat (tavola 5)
// — «La chat principale: le richieste restano in cima». FISSO sopra i
// messaggi (non scorre con loro), mostra le 2 più urgenti (prima l'insieme
// fisso, poi la più vecchia), «e altre N: …» per tipo, «Apri "Da
// approvare"» e «Riduci» (una riga sola per la sessione). Con 0 richieste
// sparisce. Nella chat di squadra resta la barra di Q2 e il riquadro
// globale compare SOLO per richieste di ALTRE squadre o bot, ridotto
// («+N altrove»).
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll } from './render-helper'
import type { ApprovalsCenterRow, TranscriptEntry } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => ({} as never))
vi.mock('../components/ComputerPanel', () => ({ ComputerPanel: () => null }))
vi.mock('../components/PageView', () => ({ PageView: () => null }))
vi.mock('../components/MemoryPanel', () => ({ MemoryPanel: () => null }))

const capture = vi.hoisted(() => ({ els: [] as Array<{ type: unknown; props: Record<string, unknown> }> }))
vi.mock('react/jsx-dev-runtime', async (orig) => {
  const m = (await orig()) as Record<string, (...a: unknown[]) => unknown>
  return {
    ...m,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      capture.els.push({ type, props })
      return m.jsxDEV!(type, props, ...rest)
    }
  }
})

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

/** il padre della catena del riquadro dentro il contenitore che scorre? */
const hasScrollingAncestor = (node: { parent: unknown } | null): boolean => {
  let p = (node as { parent?: { attrs?: Record<string, string>; parent?: unknown } | null } | null)?.parent ?? null
  while (p) {
    const cls = (p as { attrs?: Record<string, string> }).attrs?.class ?? ''
    if (cls.includes('overflow-y-auto')) return true
    p = (p as { parent?: unknown }).parent as never
  }
  return false
}

function renderBotChat(entries: TranscriptEntry[], approvalsAll: ApprovalsCenterRow[], patch: Record<string, unknown> = {}): ReturnType<typeof parseHtml> {
  capture.els.length = 0
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
  capture.els.length = 0
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

describe('A3: il riquadro in cima alle chat (tavola 5)', () => {
  it('NON è dentro il contenitore che scorre: resta sopra i messaggi anche dopo 50 messaggi', () => {
    const entries = Array.from({ length: 50 }, (_, i) => botMessage(i + 1))
    const tree = renderBotChat(entries, [row()])
    const banner = findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-banner')[0]
    expect(banner).toBeTruthy()
    expect(hasScrollingAncestor(banner ?? null)).toBe(false)
    // i 50 messaggi sono tutti nel contenitore che scorre
    const scroller = findAll(tree, (n) => (n.attrs.class ?? '').includes('overflow-y-auto'))[0]
    expect(textOf(scroller!)).toContain('messaggio numero 50')
    expect(textOf(banner!)).toContain('Turismo')
  })

  it('le 2 righe rispettano l\'ordine di urgenza: prima l\'insieme fisso, poi la più vecchia', () => {
    const rows = [
      row({ approvalId: 'nuova', phrase: 'La richiesta nuova.', when: Date.now() - 60_000 }),
      row({ approvalId: 'vecchia', phrase: 'La richiesta vecchia.', when: Date.now() - 600_000 }),
      row({ approvalId: 'fissa', phrase: 'La richiesta fissa.', why: 'fisso', when: Date.now() - 300_000 }),
      row({ approvalId: 'quarta', phrase: 'La richiesta quarta.', when: Date.now() - 400_000 })
    ]
    const tree = renderBotChat([], rows)
    const banner = findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-banner')[0]!
    const text = textOf(banner)
    // prima la fissa, poi la più vecchia delle altre; nuova e quarta nel riepilogo
    expect(text.indexOf('La richiesta fissa.')).toBeLessThan(text.indexOf('La richiesta vecchia.'))
    expect(text).not.toContain('La richiesta nuova.')
    expect(text).toContain('e altre 2')
    // la testata del riquadro
    expect(text).toContain('4 richieste aspettano te')
    expect(text).toContain('Apri «Da approvare»')
    expect(text).toContain('Riduci')
  })

  it('«e altre N»: il riepilogo per tipo («2 siti interattivi, 1 login»)', () => {
    const rows = [
      row({ approvalId: 'a', why: 'fisso', when: 1 }),
      row({ approvalId: 'b', when: 2 }),
      row({ approvalId: 'c1', category: 'sito-interattivo', when: 3 }),
      row({ approvalId: 'c2', category: 'sito-interattivo', when: 4 }),
      row({ approvalId: 'd', category: 'dati-tuoi', botId: 'x', botName: 'Ricerche', squad: null, when: 5 })
    ]
    const tree = renderBotChat([], rows)
    const banner = findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-banner')[0]!
    const text = textOf(banner)
    expect(text).toContain('e altre 3: 2 siti interattivi, 1 login')
  })

  it('«Riduci» lo porta a una riga sola, «N richieste aspettano te», per la sessione', () => {
    const rows = [row(), row({ approvalId: 'b' })]
    renderBotChat([], rows)
    const btn = capture.els.find((e) => e.type === 'button' && e.props['data-testid'] === 'approvals-banner-collapse')
    expect(btn).toBeTruthy()
    ;(btn!.props.onClick as () => void)()
    expect(useStore.getState().approvalsBannerCollapsed).toBe(true)
    // il render successivo (stesso stato di sessione): UNA riga sola
    const tree = renderBotChat([], rows, { approvalsBannerCollapsed: true })
    const banner = findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-banner')[0]!
    const text = textOf(banner)
    expect(text).toContain('2 richieste aspettano te')
    expect(text).not.toContain('Turismo (Weekend Torino)')
  })

  it('con 0 richieste il riquadro sparisce (e «Riduci» si resetta)', () => {
    const tree = renderBotChat([botMessage(1)], [])
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-banner').length).toBe(0)
    expect(useStore.getState().approvalsBannerCollapsed).toBe(false)
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
