// A1 (fase approvazioni-chiare): UN SOLO modello delle scelte di una
// richiesta — approvalChoicesOf in lib/approval-app, letto BOTH dalla card
// in chat (ApprovalCard) e dal centro (ApprovalsCenter). Il difetto del
// 22/11: due posti per la stessa decisione con scelte diverse («In Da
// approvare ho sempre e solo una volta»). Qui: per ogni categoria la card e
// il centro mostrano lo STESSO insieme di scelte, «Consenti sempre su
// <dominio>» dal centro passa dalla stessa RPC della card, e l'insieme fisso
// non offre mai «sempre» né nel centro né in chat.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll } from './render-helper'
import { callsOf } from './render-helper-install'
import type { ApprovalsCenterRow, TranscriptEntry } from '../../../shared/types'

// le props degli elementi resi (per «cliccare» le voci del menu: l'HTML
// statico non porta gli handler)
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

// il menu si rende PASSANTE: così le voci si vedono nell'HTML statico, come
// farebbe il menu APERTO (come sidebar-row-menu)
vi.mock('../components/ui/dialog', () => ({}) as never)
vi.mock('../components/ui/dropdown-menu', () => {
  const pass = (tag: string) => ({ children, ...rest }: { children?: unknown } & Record<string, unknown>) =>
    createElement('div', { 'data-mock': tag, ...rest }, children as never)
  return {
    DropdownMenu: pass('dropdown'),
    DropdownMenuTrigger: pass('dropdown-trigger'),
    DropdownMenuContent: pass('dropdown-content'),
    DropdownMenuItem: pass('dropdown-item'),
    DropdownMenuSeparator: pass('dropdown-sep'),
    DropdownMenuSub: pass('dropdown-sub'),
    DropdownMenuSubTrigger: pass('dropdown-sub-trigger'),
    DropdownMenuSubContent: pass('dropdown-sub-content'),
    DropdownMenuRadioGroup: pass('dropdown-radio-group'),
    DropdownMenuRadioItem: pass('dropdown-radio-item')
  }
})

const { approvalChoicesOf } = await import('../lib/approval-app')
const { ApprovalCard } = await import('../components/ApprovalCard')
const { ApprovalsCenter } = await import('../components/ApprovalsCenter')
const { useStore } = await import('../store')

/** le categorie della prova: (nome, tool, meta, opzioni) — le STESSE per modello, card e centro */
const CASES: Array<{ name: string; tool: string; meta: Record<string, unknown>; opts: { isDraft?: boolean; squad?: boolean; category?: ApprovalsCenterRow['category'] }; kinds: string[] }> = [
  { name: 'comando', tool: 'run-command', meta: { tool: 'run-command', input: { command: 'ls' } }, opts: {}, kinds: ['turn', 'always'] },
  { name: 'sito interattivo', tool: 'browser_type', meta: { tool: 'browser_type', input: { ref: 'e4', text: 'x', submit: true }, siteGrant: { domain: 'lefrecce.it' } }, opts: {}, kinds: ['turn', 'always', 'site'] },
  { name: 'MCP in lettura', tool: 'mcp__ufficio__get_calendario', meta: { tool: 'mcp__ufficio__get_calendario', mcpServerRead: { slug: 'ufficio', name: 'Ufficio' } }, opts: {}, kinds: ['turn', 'always', 'server-reads'] },
  { name: 'invio (bozza)', tool: 'draft_external', meta: { message: { type: 'draft', to: 'a@b.example' } }, opts: { isDraft: true }, kinds: [] },
  { name: 'insieme fisso', tool: 'fill_credential', meta: { tool: 'fill_credential', squadAlwaysAsk: true, input: { origin: 'https://spa.example' } }, opts: { category: 'dati-tuoi' }, kinds: [] },
  { name: 'squadra', tool: 'send_to_agent', meta: { tool: 'send_to_agent', squadId: 3, input: { to: 'Turismo' } }, opts: { squad: true, category: 'squadra' }, kinds: ['turn', 'always', 'mission'] }
]

/** il modello puro: l'elenco dei kind delle scelte */
const kindsOf = (tool: string, meta: Record<string, unknown>, opts: { isDraft?: boolean; squad?: boolean; category?: ApprovalsCenterRow['category'] }): string[] =>
  approvalChoicesOf(tool, meta, opts).map((c) => c.kind)

// ---- 1. il modello: le scelte giuste per ogni categoria ----

describe('A1: il modello unico delle scelte (approvalChoicesOf)', () => {
  it('per ogni categoria l\'elenco è quello giusto', () => {
    for (const c of CASES) {
      expect(kindsOf(c.tool, c.meta, c.opts), c.name).toEqual(c.kinds)
    }
  })

  it('le regole di esclusione di oggi restano: update_state, never-auto, use-app dei tasti di invio', () => {
    // update_state: turno e sempre esclusi (offerti spenti, come oggi)
    const st = approvalChoicesOf('update_state', { tool: 'update_state' }, {})
    expect(st.find((x) => x.kind === 'turn')?.disabled).toBe(true)
    expect(st.find((x) => x.kind === 'always')?.disabled).toBe(true)
    // comando never-auto: il turno è escluso, «sempre» resta
    const na = approvalChoicesOf('run-command', { tool: 'run-command', neverAuto: true }, {})
    expect(na.find((x) => x.kind === 'turn')?.disabled).toBe(true)
    expect(na.find((x) => x.kind === 'always')?.disabled).not.toBe(true)
    // use-app sui tasti di invio: mai «sempre» né i 10 minuti
    const send = approvalChoicesOf('use-app', { tool: 'use-app', ui: { id: 'approval.useAppSend' }, input: { action: 'key', app: 'Mail' } }, {})
    expect(send.find((x) => x.kind === 'always')?.disabled).toBe(true)
    expect(send.some((x) => x.kind === 'minutes10')).toBe(false)
    // use-app di un'app normale: i 10 minuti ci sono
    const app = approvalChoicesOf('use-app', { tool: 'use-app', input: { action: 'type', app: 'Safari', text: 'x' } }, {})
    expect(app.find((x) => x.kind === 'minutes10')?.app).toBe('Safari')
  })

  it('l\'insieme fisso non offre mai «sempre» (nemmeno il turno, nemmeno la missione)', () => {
    for (const meta of [{ squadAlwaysAsk: true }, { squadAlwaysAsk: true, siteGrant: { domain: 'x.it' } }, { squadAlwaysAsk: true, mcpServerRead: { slug: 's', name: 'S' } }]) {
      expect(approvalChoicesOf('browser_type', { tool: 'browser_type', ...meta }, { squad: true, category: 'sito-interattivo' })).toEqual([])
    }
  })

  it('la missione solo dove Q2 la permette: squadra o sito, mai insieme fisso né bozze né create_*', () => {
    expect(kindsOf('send_to_agent', { tool: 'send_to_agent', squadId: 1 }, { squad: true, category: 'squadra' })).toContain('mission')
    expect(kindsOf('browser_click', { tool: 'browser_click', squadId: 1 }, { squad: true, category: 'sito-interattivo' })).toContain('mission')
    // niente squadra: niente missione
    expect(kindsOf('browser_click', { tool: 'browser_click' }, { squad: false, category: 'sito-interattivo' })).not.toContain('mission')
    // create_agent / create_group mai
    expect(kindsOf('create_agent', { tool: 'create_agent', squadId: 1 }, { squad: true, category: 'squadra' })).not.toContain('mission')
    expect(kindsOf('create_group', { tool: 'create_group', squadId: 1 }, { squad: true, category: 'squadra' })).not.toContain('mission')
  })
})

// ---- 2. card e centro: lo STESSO insieme, dallo stesso modello ----

const entryOf = (tool: string, meta: Record<string, unknown>, id: number): TranscriptEntry => ({
  id, agentId: 'a-bot', kind: 'approval', role: 'system',
  content: `${tool}: chiede`, meta: { approvalId: 'ap-' + id, status: 'pending', ...meta }, createdAt: 1_000
})

const rowOf = (tool: string, meta: Record<string, unknown>, opts: { isDraft?: boolean; squad?: boolean; category?: ApprovalsCenterRow['category'] }): ApprovalsCenterRow => ({
  agentId: 'a-bot', agentName: 'Bot', parentId: null, parentName: null, fromSubagent: false,
  botId: 'a-bot', botName: 'Bot', squad: opts.squad ? { id: 3, name: 'Weekend Torino' } : null,
  approvalId: 'ap-1', entryId: 1, tool, phrase: `${tool} chiede`,
  category: opts.category ?? 'altro', why: null, when: 1_000, isDraft: opts.isDraft === true, preview: null,
  meta
})

/** i testid delle scelte resi (card o centro), nell'ordine */
const renderedChoiceKinds = (html: string): string[] =>
  findAll(parseHtml(html), (n) => (n.attrs['data-testid'] ?? '').startsWith('approval-choice-'))
    .map((n) => String(n.attrs['data-testid']).slice('approval-choice-'.length))

function renderCard(entry: TranscriptEntry): string {
  setStoreStateForRender(useStore, {
    agents: [{ id: 'a-bot', name: 'Bot', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1, createdBy: null, section: null, parentId: null, avatar: null }],
    activeId: 'a-bot', entries: [entry], approvalsOpen: false, approvalsAll: [], approvalsSnoozed: {}
  })
  return renderHtml(createElement(ApprovalCard, { entry }))
}

function renderCenter(row: ApprovalsCenterRow): string {
  setStoreStateForRender(useStore, {
    approvalsAll: [row], approvalsSnoozed: {}, approvalsOpen: true, approvalsFocusId: null,
    approvalsBannerCollapsed: false, groups: [], agents: [], entries: [], activeId: 'a-bot',
    openGroupId: null, activityOpen: false, openLibraryId: null, approvalsQueueOpen: false
  })
  return renderHtml(createElement(ApprovalsCenter))
}

beforeEach(() => {
  useStore.setState({ approvalsAll: [], approvalsOpen: false })
})

describe('A1: card in chat e centro mostrano lo stesso insieme di scelte', () => {
  for (const c of CASES) {
    const entry = entryOf(c.tool, c.meta, 1)
    const row = rowOf(c.tool, c.meta, c.opts)
    it(`${c.name}: stesse scelte nel modello, nella card e nel centro`, () => {
      const model = kindsOf(c.tool, c.meta, c.opts)
      const card = renderedChoiceKinds(renderCard(entry))
      const center = renderedChoiceKinds(renderCenter(row))
      expect(card, 'la card rende le scelte del modello').toEqual(model)
      expect(center, 'il centro rende le scelte del modello').toEqual(model)
    })
  }

  it('l\'insieme fisso: nessuna scelta «sempre» né nella card né nel centro', () => {
    const meta = { tool: 'fill_credential', squadAlwaysAsk: true, input: { origin: 'https://spa.example' } }
    expect(renderedChoiceKinds(renderCard(entryOf('fill_credential', meta, 2)))).not.toContain('always')
    expect(renderedChoiceKinds(renderCenter(rowOf('fill_credential', meta, { category: 'dati-tuoi' })))).not.toContain('always')
  })
})

// ---- 3. «Consenti sempre su <dominio>» dal centro: la STESSA grant della card ----

/** la voce del menu col testid cercato, PRIMA del render (gli handler si
 *  catturano dal runtime JSX: l'HTML statico non li porta) */
const clickChoice = (renderFn: () => string, testid: string): boolean => {
  capture.els.length = 0
  renderFn()
  const el = capture.els.find((e) => e.props['data-testid'] === testid)
  if (!el || typeof el.props.onClick !== 'function') return false
  ;(el.props.onClick as () => void)()
  return true
}

describe('A1: le decisioni del centro passano dalle RPC che esistono già', () => {
  it('«Consenti sempre su <dominio>» dal centro chiama resolveApproval allow/site (come la card)', () => {
    const meta = { tool: 'browser_type', input: { ref: 'e4', text: 'x', submit: true }, siteGrant: { domain: 'lefrecce.it' } }
    expect(clickChoice(() => renderCenter(rowOf('browser_type', meta, {})), 'approval-choice-site')).toBe(true)
    const calls = callsOf('resolveApproval')
    expect(calls[calls.length - 1]!.args).toEqual(['a-bot', 'ap-1', 'allow', 'site', 'center'])
  })

  it('«Consenti sempre le letture di <server>» dal centro: la grant delle letture + resolve server-reads (come la card)', () => {
    const meta = { tool: 'mcp__ufficio__get_calendario', mcpServerRead: { slug: 'ufficio', name: 'Ufficio' } }
    expect(clickChoice(() => renderCenter(rowOf('mcp__ufficio__get_calendario', meta, {})), 'approval-choice-server-reads')).toBe(true)
    expect(callsOf('grantServerReads').slice(-1)[0]!.args).toEqual(['ufficio'])
    const calls = callsOf('resolveApproval')
    expect(calls[calls.length - 1]!.args).toEqual(['a-bot', 'ap-1', 'allow', 'server-reads', 'center'])
  })

  it('«Consenti per questa missione» dal centro: resolveApproval allow/mission (la RPC di Q2)', () => {
    const meta = { tool: 'send_to_agent', squadId: 3, input: { to: 'Turismo' } }
    expect(clickChoice(() => renderCenter(rowOf('send_to_agent', meta, { squad: true, category: 'squadra' })), 'approval-choice-mission')).toBe(true)
    const calls = callsOf('resolveApproval')
    expect(calls[calls.length - 1]!.args).toEqual(['a-bot', 'ap-1', 'allow', 'mission', 'center'])
  })

  it('la CARD in chat decide dagli stessi testid (il modello è uno)', () => {
    const meta = { tool: 'browser_type', input: { ref: 'e4', text: 'x', submit: true }, siteGrant: { domain: 'lefrecce.it' } }
    expect(clickChoice(() => renderCard(entryOf('browser_type', meta, 5)), 'approval-choice-site')).toBe(true)
    const calls = callsOf('resolveApproval')
    expect(calls[calls.length - 1]!.args).toEqual(['a-bot', 'ap-5', 'allow', 'site', 'chat'])
  })
})
