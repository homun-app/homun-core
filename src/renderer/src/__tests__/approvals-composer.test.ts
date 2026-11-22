// A3 (fase approvazioni-chiare): la richiesta si vede DOVE guardi — nella
// chat del bot, la richiesta in attesa di QUEL bot sta SOPRA il campo di
// scrittura, agganciata in basso come le richieste di permesso degli
// strumenti per sviluppatori (non in cima ai messaggi), con la frase e le
// SCELTE di A1 e la stessa grafica della card. Il campo resta usabile e la
// richiesta resta visibile anche scorrendo. Il riquadro in cima resta SOLO
// per le richieste di ALTRI bot o squadre («+N altrove»).
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll } from './render-helper'
import { callsOf, stubApiMethod } from './render-helper-install'
import type { ApprovalsCenterRow, TranscriptEntry } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => ({}) as never)
vi.mock('../components/ComputerPanel', () => ({ ComputerPanel: () => null }))
vi.mock('../components/PageView', () => ({ PageView: () => null }))
vi.mock('../components/MemoryPanel', () => ({ MemoryPanel: () => null }))
// il menu «Altre scelte ▾» PASSANTE: le voci si vedono nell'HTML statico
vi.mock('../components/ui/dropdown-menu', () => {
  const pass = (tag: string) => ({ children, ...rest }: { children?: unknown } & Record<string, unknown>) =>
    createElement('div', { 'data-mock': tag, ...rest }, children as never)
  return {
    DropdownMenu: pass('dropdown'),
    DropdownMenuTrigger: pass('dropdown-trigger'),
    DropdownMenuContent: pass('dropdown-content'),
    DropdownMenuItem: pass('dropdown-item'),
    DropdownMenuSeparator: pass('dropdown-sep')
  }
})

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
const { useStore } = await import('../store')

const agent = { id: 'bot-chat', name: 'Bot', description: '', providerId: null, model: null, status: 'offline', unread: 0, createdAt: 1 }

const ownRow = (over: Partial<ApprovalsCenterRow> = {}): ApprovalsCenterRow => ({
  agentId: 'bot-chat', agentName: 'Bot', parentId: null, parentName: null, fromSubagent: false,
  botId: 'bot-chat', botName: 'Bot', squad: null,
  approvalId: 'ap-mio', entryId: 1, tool: 'run-command', phrase: 'Eseguire un comando sul Mac.',
  category: 'mac', why: null, when: Date.now() - 120_000, isDraft: false, preview: null,
  meta: { tool: 'run-command', input: { command: 'ls' } },
  ...over
})

const botMessage = (id: number): TranscriptEntry => ({
  id, agentId: 'bot-chat', kind: 'send-message', role: 'assistant', content: `messaggio numero ${id}`, meta: { message: { type: 'text' } }, createdAt: id
})

/** il padre della catena del riquadro sta nel contenitore che scorre? */
const hasScrollingAncestor = (node: { parent: unknown } | null | undefined): boolean => {
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

beforeEach(() => {
  useStore.setState({ approvalsAll: [], approvalsSnoozed: {}, approvalsBannerCollapsed: false })
})

describe('A3: la richiesta del bot aperto sta SOPRA il campo di scrittura', () => {
  it('il riquadro sopra il campo: la frase, le scelte di A1, e NON nel banner in cima', () => {
    const entries = Array.from({ length: 30 }, (_, i) => botMessage(i + 1))
    const tree = renderBotChat(entries, [ownRow()])
    const box = findAll(tree, (n) => n.attrs['data-testid'] === 'composer-approval')[0]
    expect(box).toBeTruthy()
    // sta nel FOOTER (agganciato in basso), non nel contenitore che scorre
    expect(hasScrollingAncestor(box)).toBe(false)
    const footer = findAll(tree, (n) => (n.attrs.class ?? '').includes('pb-4') && (n.attrs.class ?? '').includes('@container'))[0]
    expect(footer).toBeTruthy()
    expect(textOf(footer!)).toContain('Eseguire un comando sul Mac.')
    // la frase e le scelte di A1 (Consenti, Rifiuta, Altre scelte col modello unico)
    expect(textOf(box!)).toContain('Bot')
    expect(textOf(box!)).toContain('Consenti')
    expect(textOf(box!)).toContain('Rifiuta')
    expect(textOf(box!)).toContain('Altre scelte')
    // il campo di scrittura resta USABILE, col riquadro presente
    expect(findAll(tree, (n) => n.tag === 'textarea').length).toBeGreaterThan(0)
    // e il banner in cima NON c'è (la richiesta è di QUESTO bot)
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-banner').length).toBe(0)
  })

  it('la richiesta resta visibile anche scorrendo: fuori dal contenitore dei messaggi, dentro il footer', () => {
    const tree = renderBotChat([botMessage(1)], [ownRow()])
    const box = findAll(tree, (n) => n.attrs['data-testid'] === 'composer-approval')[0]!
    const scroller = findAll(tree, (n) => (n.attrs.class ?? '').includes('overflow-y-auto'))[0]
    // il riquadro NON è dentro lo scroller; i messaggi sì
    expect(hasScrollingAncestor(box)).toBe(false)
    expect(textOf(scroller!)).toContain('messaggio numero 1')
  })

  it('la richiesta di UN ALTRO bot sta nel banner «+N altrove», non nel riquadro del campo', () => {
    const other = ownRow({ agentId: 'a-turismo', agentName: 'Turismo', botId: 'a-turismo', botName: 'Turismo', approvalId: 'ap-altro', phrase: 'Compilare il modulo del museo.', squad: { id: 1, name: 'Weekend Torino' } })
    const tree = renderBotChat([botMessage(1)], [other])
    const banner = findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-banner')[0]
    expect(banner).toBeTruthy()
    expect(textOf(banner!)).toContain('+1 altrove')
    // il riquadro sopra il campo resta per le richieste di QUESTO bot: qui non c'è
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'composer-approval').length).toBe(0)
  })

  it('il riquadro decide con le RPC di sempre, via chat: Consenti → allow once', () => {
    renderBotChat([botMessage(1)], [ownRow()])
    // R1 (fase ritocchi-beta18): il pezzo unico — il Consenti si chiama approval-allow
    const btn = capture.els.find((e) => e.type === 'button' && e.props['data-testid'] === 'approval-allow')
    expect(btn).toBeTruthy()
    ;(btn!.props.onClick as () => void)()
    expect(callsOf('resolveApproval').slice(-1)[0]!.args).toEqual(['bot-chat', 'ap-mio', 'allow', 'once', 'chat'])
  })

  it('il menu «Altre scelte» del riquadro: le scelte del modello unico (turno, sempre)', () => {
    renderBotChat([botMessage(1)], [ownRow()])
    const items = capture.els.filter((e) => String(e.props['data-testid'] ?? '').startsWith('approval-choice-'))
    expect(items.map((e) => e.props['data-testid'])).toEqual(['approval-choice-turn', 'approval-choice-always'])
    ;(items[1]!.props.onClick as () => void)()
    expect(callsOf('resolveApproval').slice(-1)[0]!.args).toEqual(['bot-chat', 'ap-mio', 'allow', 'always', 'chat'])
  })

  it('più richieste di QUESTO bot: la più urgente nel riquadro, con «1 di 2» e la freccia per passare alle altre', () => {
    const rows = [
      ownRow({ approvalId: 'nuova', phrase: 'La nuova.', when: Date.now() - 60_000 }),
      ownRow({ approvalId: 'fissa', phrase: 'La fissa.', why: 'fisso', meta: { squadAlwaysAsk: true }, when: Date.now() - 300_000 })
    ]
    const tree = renderBotChat([botMessage(1)], rows)
    const box = findAll(tree, (n) => n.attrs['data-testid'] === 'composer-approval')[0]!
    // prima l'insieme fisso (byUrgency), la dichiara e c'è il conto «1 di 2»
    expect(textOf(box)).toContain('La fissa.')
    expect(textOf(box)).toContain('1 di 2')
    // la freccia porta alla seconda (R1: niente più «+N altre», si passa qui)
    expect(capture.els.some((e) => e.props['data-testid'] === 'composer-approval-next')).toBe(true)
  })

  it('l\'insieme fisso nel riquadro: NESSUNA scelta oltre a Consenti/Rifiuta (il modello unico A1)', () => {
    const rows = [ownRow({ approvalId: 'fissa', phrase: 'La fissa.', why: 'fisso', meta: { squadAlwaysAsk: true } })]
    renderBotChat([botMessage(1)], rows)
    const items = capture.els.filter((e) => String(e.props['data-testid'] ?? '').startsWith('approval-choice-'))
    expect(items).toEqual([])
    expect(capture.els.some((e) => e.props['data-testid'] === 'composer-altre-scelte')).toBe(false)
  })
})

describe('A3: il badge del Dock segue il conteggio', () => {
  it('il numero delle richieste in attesa arriva all\'RPC del badge (0 → lo azzera)', async () => {
    // la passata del refresh legge l'RPC delle pendenti: qui risponde la riga del bot
    stubApiMethod('approvalsPendingAll', () => [ownRow()])
    useStore.getState()._squadRefreshPass(false)
    await new Promise((r) => setTimeout(r, 10))
    const calls = callsOf('setDockBadge')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1]!.args).toEqual([1])
    // a 0 richieste il badge si AZZERA (nessun numero sul Dock)
    stubApiMethod('approvalsPendingAll', () => [])
    useStore.getState()._squadRefreshPass(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(callsOf('setDockBadge').slice(-1)[0]!.args).toEqual([0])
  })
})
