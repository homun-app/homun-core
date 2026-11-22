// R1 (fase ritocchi-beta18): nella chat del bot la richiesta in attesa si
// decide da UN posto solo. Il difetto del 22/11 (cattura
// fase-approvazioni-chiare/1): la STESSA richiesta compariva due volte — la
// card nei messaggi («Altre opzioni ▾») e il riquadro sopra il campo con la
// frase GREZZA dello strumento («browser_type su textbox … submit: true») e
// «Altre scelte ▾». Due «Consenti» per una decisione sola, testi diversi.
//
// Qui: un solo «Consenti» nel DOM; la card pendente diventa una riga compatta
// che porta il fuoco sul riquadro; il riquadro mostra lo STESSO titolo e la
// STESSA frase della card (mai la stringa grezza, nemmeno nel caso vero
// browser_type con submit: true); più richieste dello stesso bot → «1 di N»
// con le frecce; «Altre opzioni» sparisce dal catalogo.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll } from './render-helper'
import { callsOf } from './render-helper-install'
import type { ApprovalsCenterRow, TranscriptEntry } from '../../../shared/types'
// il caso VERO del difetto: la card browser_type con submit, col UiText che
// scrive il loop (il content dell'entry è formatUi di quel UiText)
import { UI } from '../../../shared/ui-messages'
import { ui, formatUi } from '../../../shared/ui-text'

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

// le props degli elementi resi (per «cliccare» nell'HTML statico)
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

const agent = { id: 'bot-chat', name: 'Alloggio', description: '', providerId: null, model: null, status: 'offline', unread: 0, createdAt: 1 }

const botMessage = (id: number): TranscriptEntry => ({
  id, agentId: 'bot-chat', kind: 'send-message', role: 'assistant', content: `messaggio numero ${id}`, meta: { message: { type: 'text' } }, createdAt: id
})

// ---- il caso VERO del difetto: browser_type con submit: true ----
// il UiText che il loop scrive nella card (card.browserAsk, reasonKind submit)
const browserAskUi = ui(UI.cardBrowserAsk, {
  tool: 'browser_type',
  target: 'element',
  element: 'textbox "Nome"',
  url: 'https://spa.example/prenota',
  typed: 'yes',
  text: 'rossi@example.com',
  reasonKind: 'submit',
  field: 'Nome'
})
const browserMeta = {
  approvalId: 'ap-browser',
  tool: 'browser_type',
  input: { ref: 'e4', text: 'rossi@example.com', submit: true },
  status: 'pending',
  ui: browserAskUi,
  browser: { url: 'https://spa.example/prenota' }
}
const browserEntry = (status = 'pending'): TranscriptEntry => ({
  id: 10, agentId: 'bot-chat', kind: 'approval', role: 'system',
  // il content dell'entry è la FRASE GREZZA che oggi finisce nel riquadro
  content: formatUi(browserAskUi, 'it'),
  meta: { ...browserMeta, ...(status !== 'pending' ? { status, resolutionMode: 'once' } : {}) },
  createdAt: 1_000
})
const rowOf = (over: Partial<ApprovalsCenterRow> = {}): ApprovalsCenterRow => ({
  agentId: 'bot-chat', agentName: 'Alloggio', parentId: null, parentName: null, fromSubagent: false,
  botId: 'bot-chat', botName: 'Alloggio', squad: null,
  approvalId: 'ap-browser', entryId: 10, tool: 'browser_type',
  phrase: formatUi(browserAskUi, 'it'),
  category: 'sito-interattivo', why: null, when: Date.now() - 120_000, isDraft: false, preview: null,
  meta: browserMeta as unknown as Record<string, unknown>,
  ...over
})

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

/** i bottoni «Consenti» esatti nel DOM della chat */
const consentiButtons = (tree: ReturnType<typeof parseHtml>) =>
  findAll(tree, (n) => n.tag === 'button' && textOf(n).trim() === 'Consenti')

beforeEach(() => {
  useStore.setState({ approvalsAll: [], approvalsSnoozed: {}, approvalsBannerCollapsed: false, composerApprovalIndex: 0 })
})

describe('R1: la richiesta in attesa si decide da un posto solo', () => {
  it('una richiesta in attesa nella chat del bot → UN solo bottone «Consenti» nel DOM', () => {
    const tree = renderBotChat([browserEntry(), botMessage(2)], [rowOf()])
    // il riquadro sopra il campo c'è, con i suoi bottoni
    const box = findAll(tree, (n) => n.attrs['data-testid'] === 'composer-approval')[0]
    expect(box).toBeTruthy()
    // UN «Consenti» in tutta la chat: la card nei messaggi è compatta
    expect(consentiButtons(tree).length).toBe(1)
  })

  it('la riga compatta nei messaggi c\'è, e il clic porta il fuoco sul riquadro', () => {
    const tree = renderBotChat([browserEntry(), botMessage(2)], [rowOf()])
    const compact = findAll(tree, (n) => n.attrs['data-testid'] === 'approval-compact-row')[0]
    expect(compact).toBeTruthy()
    expect(textOf(compact)).toContain('In attesa della tua scelta')
    expect(textOf(compact)).toContain('qui sotto')
    // il clic porta il fuoco al riquadro sopra il campo (shim del document)
    const focused: string[] = []
    ;(globalThis as Record<string, unknown>).document = {
      querySelector: (sel: string) => sel === '[data-testid="composer-approval"]'
        ? { scrollIntoView: () => undefined, focus: () => focused.push(sel) }
        : null
    }
    try {
      const btn = capture.els.find((e) => e.props['data-testid'] === 'approval-compact-row')
      expect(btn).toBeTruthy()
      ;(btn!.props.onClick as () => void)()
      expect(focused).toEqual(['[data-testid="composer-approval"]'])
    } finally {
      delete (globalThis as Record<string, unknown>).document
    }
  })

  it('il riquadro mostra lo STESSO titolo e la STESSA frase della card — caso vero browser_type con submit: nessuna stringa browser_type visibile', () => {
    const tree = renderBotChat([browserEntry(), botMessage(2)], [rowOf()])
    const box = findAll(tree, (n) => n.attrs['data-testid'] === 'composer-approval-card')[0]
    expect(box).toBeTruthy()
    // mai la stringa grezza dello strumento, nemmeno nel caso vero del submit
    expect(textOf(box)).not.toContain('browser_type')
    // il titolo in parole, come la card di oggi
    expect(textOf(box)).toContain('vuole usare Azioni nel browser del bot')
    // e la STESSA frase della card: senza riquadro la card nei messaggi è
    // piena (_approvalsAll vuoto) — i due testi coincidono
    const treeCard = renderBotChat([browserEntry(), botMessage(2)], [])
    const card = findAll(treeCard, (n) => n.attrs['data-testid'] === 'card-approvazione')[0]
    expect(card).toBeTruthy()
    expect(textOf(box)).toBe(textOf(card))
  })

  it('dopo «Consenti» la riga torna card con l\'esito, e il riquadro sparisce', () => {
    // prima: la richiesta è in attesa → riga compatta + riquadro
    const tree1 = renderBotChat([browserEntry(), botMessage(2)], [rowOf()])
    expect(findAll(tree1, (n) => n.attrs['data-testid'] === 'approval-compact-row').length).toBe(1)
    // il «Consenti» del riquadro (il pezzo unico lo chiama approval-allow):
    // le RPC di sempre, via 'chat'
    const btn = capture.els.find((e) => e.props['data-testid'] === 'approval-allow')
    expect(btn).toBeTruthy()
    ;(btn!.props.onClick as () => void)()
    expect(callsOf('resolveApproval').slice(-1)[0]!.args).toEqual(['bot-chat', 'ap-browser', 'allow', 'once', 'chat'])
    // dopo: la card con l'esito, niente riquadro, niente riga compatta
    const tree2 = renderBotChat([browserEntry('allowed'), botMessage(2)], [])
    expect(findAll(tree2, (n) => n.attrs['data-testid'] === 'composer-approval').length).toBe(0)
    expect(findAll(tree2, (n) => n.attrs['data-testid'] === 'approval-compact-row').length).toBe(0)
    const messages = findAll(tree2, (n) => (n.attrs.class ?? '').includes('overflow-y-auto'))[0]
    expect(textOf(messages!)).toContain('Consentito una volta')
  })

  it('due richieste dello stesso bot → «1 di 2», la freccia passa alla seconda, decidere la prima mostra la seconda', () => {
    const metaCmd = { approvalId: 'ap-cmd', tool: 'run-command', input: { command: 'ls -la' }, status: 'pending' }
    const entryCmd: TranscriptEntry = {
      id: 11, agentId: 'bot-chat', kind: 'approval', role: 'system',
      content: 'Eseguire un comando sul Mac.', meta: metaCmd, createdAt: 2_000
    }
    const rowCmd = rowOf({
      approvalId: 'ap-cmd', entryId: 11, tool: 'run-command', phrase: 'Eseguire un comando sul Mac.',
      category: 'mac', when: Date.now() - 90_000, meta: metaCmd as unknown as Record<string, unknown>
    })
    // la più vecchia (browser) è la prima; il comando è la seconda
    const rows = [rowCmd, rowOf()]
    const entries = [browserEntry(), entryCmd, botMessage(3)]
    const tree = renderBotChat(entries, rows)
    let box = findAll(tree, (n) => n.attrs['data-testid'] === 'composer-approval-card')[0]!
    let whole = findAll(tree, (n) => n.attrs['data-testid'] === 'composer-approval')[0]!
    expect(textOf(whole)).toContain('1 di 2')
    expect(textOf(box)).toContain('vuole usare Azioni nel browser del bot')
    // TUTTE le card pendenti del bot sono compatte nei messaggi
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'approval-compact-row').length).toBe(2)
    // la freccia passa alla seconda
    const next = capture.els.find((e) => e.props['data-testid'] === 'composer-approval-next')
    expect(next).toBeTruthy()
    ;(next!.props.onClick as () => void)()
    expect(useStore.getState().composerApprovalIndex).toBe(1)
    const tree2 = renderBotChat(entries, rows, { composerApprovalIndex: 1 })
    box = findAll(tree2, (n) => n.attrs['data-testid'] === 'composer-approval-card')[0]!
    whole = findAll(tree2, (n) => n.attrs['data-testid'] === 'composer-approval')[0]!
    expect(textOf(whole)).toContain('2 di 2')
    expect(textOf(box)).toContain('vuole eseguire un comando')
    // decidere la PRIMA (la più urgente): il riquadro mostra la SECONDA
    const tree3 = renderBotChat(entries, [rowCmd], { composerApprovalIndex: 1 })
    box = findAll(tree3, (n) => n.attrs['data-testid'] === 'composer-approval-card')[0]!
    whole = findAll(tree3, (n) => n.attrs['data-testid'] === 'composer-approval')[0]!
    expect(textOf(box)).toContain('vuole eseguire un comando')
    expect(textOf(whole)).not.toContain('di 2')
  })
})

describe('R1: un\'etichetta sola — «Altre scelte ▾»', () => {
  const po = (lang: 'it' | 'en'): string =>
    readFileSync(fileURLToPath(new URL(`../locales/${lang}/messages.po`, import.meta.url)), 'utf8')

  it('il catalogo non contiene più «Altre opzioni» (it e en)', () => {
    expect(po('it')).not.toContain('Altre opzioni')
    expect(po('en')).not.toContain('Altre opzioni')
  })

  it('la card piena (senza riquadro) apre «Altre scelte ▾», non «Altre opzioni»', () => {
    const tree = renderBotChat([browserEntry(), botMessage(2)], [])
    const card = findAll(tree, (n) => n.attrs['data-testid'] === 'card-approvazione')[0]!
    expect(textOf(card)).toContain('Altre scelte')
    expect(textOf(card)).not.toContain('Altre opzioni')
  })

  it('il riquadro usa la STESSA etichetta «Altre scelte ▾» della card', () => {
    const tree = renderBotChat([browserEntry(), botMessage(2)], [rowOf()])
    const box = findAll(tree, (n) => n.attrs['data-testid'] === 'composer-approval-card')[0]!
    expect(textOf(box)).toContain('Altre scelte')
    expect(textOf(box)).not.toContain('Altre opzioni')
  })
})
