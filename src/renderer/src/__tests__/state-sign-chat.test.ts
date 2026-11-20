// P6 (fase uso-permessi): gli stati in chat parlano come la barra — la card
// dell'aiutante, la card dei task e la riga di stato del turno usano lo
// STESSO componente StateSign della barra (lavora / aspetta te / finito /
// fermo), con gli stessi keyframes e colori. NIENTE emoji di stato.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll } from './render-helper'
import type { TranscriptEntry } from '../../../shared/types'

const { SubagentCard } = await import('../components/SubagentCard')
const { TaskCard } = await import('../components/TaskCard')
const { useStore } = await import('../store')

const STATE_EMOJIS = ['⏳', '✓', '⚠', '⛔', '⏱', '⏹', '✋', '❓']

const subEntry: TranscriptEntry = {
  id: 7,
  agentId: 'bot-padre',
  kind: 'send-message',
  role: 'assistant',
  content: '',
  meta: { message: { type: 'subagent', subagentId: 'sub-1', title: 'Cerca i biglietti' } },
  createdAt: 900
}
const taskEntry: TranscriptEntry = {
  id: 8,
  agentId: 'bot-padre',
  kind: 'send-message',
  role: 'assistant',
  content: '',
  meta: { message: { type: 'task', taskId: 5 } },
  createdAt: 910
}

const subOf = (over: Record<string, unknown>) => ({
  id: 'sub-1',
  parentId: 'bot-padre',
  parentTaskId: null,
  batchId: 'b1',
  title: 'Cerca i biglietti',
  status: 'running' as const,
  summary: null,
  reportPath: null,
  createdAt: 800,
  startedAt: 850,
  finishedAt: null,
  deadlineAt: 9e15,
  agentStatus: 'running' as const,
  steps: 3,
  pendingApprovals: [] as TranscriptEntry[],
  ...over
})
const taskOf = (over: Record<string, unknown>) => ({
  id: 5,
  agentId: 'bot-padre',
  title: 'Ricerca dei prezzi',
  status: 'working' as const,
  createdAt: 800,
  updatedAt: 900,
  summary: null,
  ...over
})

const htmlOf = (el: React.ReactElement): string => renderHtml(el)

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('P6: la card dell\'aiutante usa StateSign, niente emoji di stato', () => {
  it('al lavoro → il segno data-state="lavora" della barra; NESSUNA emoji', () => {
    setStoreStateForRender(useStore as never, { subagents: [subOf({})] })
    const html = htmlOf(createElement(SubagentCard, { entry: subEntry }))
    const root = parseHtml(html)
    expect(findAll(root, (n) => n.attrs['data-state'] === 'lavora')).toBeTruthy()
    for (const e of STATE_EMOJIS) expect(html).not.toContain(e)
  })

  it('in attesa dell\'utente → data-state="aspetta-te"; finito → data-state="finito"', () => {
    setStoreStateForRender(useStore as never, {
      subagents: [subOf({ status: 'running', agentStatus: 'paused-for-approval' })]
    })
    const waiting = parseHtml(htmlOf(createElement(SubagentCard, { entry: subEntry })))
    expect(findAll(waiting, (n) => n.attrs['data-state'] === 'aspetta-te')).toBeTruthy()
    setStoreStateForRender(useStore as never, {
      subagents: [subOf({ status: 'done', agentStatus: 'idle', finishedAt: 1000, summary: 'fatto' })]
    })
    const doneHtml = htmlOf(createElement(SubagentCard, { entry: subEntry }))
    const done = parseHtml(doneHtml)
    expect(findAll(done, (n) => n.attrs['data-state'] === 'finito')).toBeTruthy()
    for (const e of STATE_EMOJIS) expect(doneHtml).not.toContain(e)
  })

  it('la card dei task (il lavoro in un thread) usa gli STESSI segni', () => {
    setStoreStateForRender(useStore as never, { tasks: [taskOf({ status: 'working' })] })
    const working = parseHtml(htmlOf(createElement(TaskCard, { entry: taskEntry })))
    expect(findAll(working, (n) => n.attrs['data-state'] === 'lavora')).toBeTruthy()
    setStoreStateForRender(useStore as never, { tasks: [taskOf({ status: 'needs_input' })] })
    const needsHtml = htmlOf(createElement(TaskCard, { entry: taskEntry }))
    const needs = parseHtml(needsHtml)
    expect(findAll(needs, (n) => n.attrs['data-state'] === 'aspetta-te')).toBeTruthy()
    for (const e of STATE_EMOJIS) expect(needsHtml).not.toContain(e)
  })

  it('guardia sul sorgente: Sidebar, SubagentCard, TaskCard e la riga di stato del turno usano lo STESSO componente', () => {
    const read = (f: string): string => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')
    // il componente condiviso esiste ed è quello della barra
    expect(read('../components/StateSign.tsx')).toMatch(/export function StateSign/)
    expect(read('../components/Sidebar.tsx')).toMatch(/import \{ StateSign[^}]*\} from '\.\/StateSign'/)
    expect(read('../components/SubagentCard.tsx')).toMatch(/import \{ StateSign[^}]*\} from '\.\/StateSign'/)
    expect(read('../components/TaskCard.tsx')).toMatch(/import \{ StateSign[^}]*\} from '\.\/StateSign'/)
    // la riga di stato del turno (il pièdi della vista del sottoagente) pure
    expect(read('../components/Chat.tsx')).toMatch(/import \{ StateSign[^}]*\} from '\.\/StateSign'/)
  })
})
