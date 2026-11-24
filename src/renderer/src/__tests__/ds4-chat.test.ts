// Fase design (DS4, Chat): la pagina della chat ai token di DS1 — la colonna
// di lettura, i messaggi, le righe di sistema, il campo di scrittura — e la
// correzione di DS3 alla testata (la riga interna che riempie la testata).
// Chat VERA resa in node (react-dom/server), come message-actions.test.ts e
// empty-reply-chat.test.ts: qui si guarda la VISTA — struttura e classi dei
// token — e, dove serve, il CSS compilato da styles.css (che una classe
// esista lo dice solo l'output).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, dialogPassThroughMock, parseHtml, findAll, textOf, type HtmlNode } from './render-helper'
import { compileRenderer, deadClasses } from './tailwind-compile'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
vi.mock('../components/ComputerPanel', () => ({ ComputerPanel: () => null }))
vi.mock('../components/PageView', () => ({ PageView: () => null }))
vi.mock('../components/MemoryPanel', () => ({ MemoryPanel: () => null }))

const { Chat } = await import('../components/Chat')
const { TeamChat } = await import('../components/TeamChat')
const { useStore } = await import('../store')

const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter(Boolean)
const has = (node: HtmlNode, cls: string): boolean => classes(node).includes(cls)
const first = (root: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode => findAll(root, pred)[0]!
const source = (f: string): string => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')

const agent = { id: 'bot-1', name: 'Trello', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }
const group = {
  id: 7, name: 'Weekend Torino', description: '', createdBy: 'user', coordinatorId: 'a1',
  members: [{ agentId: 'a1', name: 'Capo', coordinator: true }],
  createdAt: 1, lastMessageAt: null, autonomy: 'box' as const
}

/** La chat del bot, con le entry e lo stato del caso (tutto chiuso). */
function renderChat(patch: Record<string, unknown> = {}): HtmlNode {
  setStoreStateForRender(useStore, {
    rightPanel: false, openGroupId: null, activeId: 'bot-1', agents: [agent],
    providers: [], mainModel: null, tasks: [], openTaskId: null, entries: [],
    subagents: [], openSubagentId: null, subEntries: [],
    botModelOpen: false, settingsOpen: false, settingsTab: null,
    ...patch
  } as never)
  return parseHtml(renderHtml(createElement(Chat, {})))
}

function renderTeamChat(): HtmlNode {
  setStoreStateForRender(useStore, {
    openGroupId: 7, groups: [group], groupMessages: [], groupCards: [], groupPending: [], groupPendingCount: {},
    groupActivity: [], groupReviewerPassed: [], approvalsQueueOpen: false, agents: [], openPageInfo: null,
    rightPanel: false
  } as never)
  return parseHtml(renderHtml(createElement(TeamChat)))
}

describe('DS3 (correzione): la riga interna della testata riempie la testata', () => {
  // in una riga flex una figlia è larga quanto il suo contenuto: senza w-full la
  // riga interna non lascia spazio al flex-1 che centra la pillola, e la pillola
  // resta a sinistra (lo ha misurato il coordinatore dal vivo: x ≈ 360)
  const check = (root: HtmlNode, dove: string): void => {
    const head = first(root, (n) => n.attrs['data-col-head'] === 'chat')
    // la testata è la riga dei 52: una riga flex, fascia di trascinamento
    for (const cls of ['drag-region', 'h-col-head', 'flex']) expect(has(head, cls), `${dove}: ${cls}`).toBe(true)
    expect(head.children).toHaveLength(1)
    const row = head.children[0]!
    expect(has(row, 'w-full'), `${dove}: la riga interna è larga quanto la testata`).toBe(true)
    // e DENTRO la riga lo spazio che centra la pillola è quello che resta
    const centre = first(row, (n) => has(n, 'justify-center'))
    expect(has(centre, 'flex-1')).toBe(true)
  }

  it('in Chat la figlia della testata porta w-full', () => {
    check(renderChat(), 'Chat')
  })

  it('in TeamChat la figlia della testata porta w-full', () => {
    check(renderTeamChat(), 'TeamChat')
  })

  it('compilate: w-full è il 100% della testata (non una classe morta)', async () => {
    const css = await compileRenderer(['w-full', 'flex-1', 'justify-center'])
    expect(deadClasses(css, ['w-full', 'flex-1', 'justify-center'])).toEqual([])
    expect(css).toMatch(/\.w-full\s*\{\s*width:\s*100%;/)
  })
})
