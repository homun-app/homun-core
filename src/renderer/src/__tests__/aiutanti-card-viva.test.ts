// AH3 (fase aiutanti): la card «Aiutante» è VIVA — lo stato del figlio si vede
// senza ricaricare la chat (l'evento subagents del daemon), la riga dell'attività
// corrente cambia con gli eventi activity del figlio (le STESSE etichette della
// riga del bot, mai l'argomento grezzo) e i passi fatti si contano. Render
// statico del componente VERO col store.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, dialogPassThroughMock } from './render-helper'
import { callsOf } from './render-helper-install'
import type { TranscriptEntry } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())

const { SubagentCard } = await import('../components/SubagentCard')
const { useStore } = await import('../store')

const subEntry: TranscriptEntry = {
  id: 7,
  agentId: 'bot-padre',
  kind: 'send-message',
  role: 'assistant',
  content: '',
  meta: { message: { type: 'subagent', subagentId: 'sub-1', title: 'Screenshot delle 5 foto' } },
  createdAt: 900
}

const subOf = (over: Record<string, unknown>) => ({
  id: 'sub-1',
  parentId: 'bot-padre',
  parentTaskId: null,
  batchId: 'b1',
  title: 'Screenshot delle 5 foto',
  status: 'running' as const,
  summary: null,
  reportPath: null,
  createdAt: 800,
  startedAt: 850,
  finishedAt: null,
  deadlineAt: 9e15,
  agentStatus: 'running' as const,
  steps: 0,
  pendingApprovals: [],
  ...over
})

const render = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  setStoreStateForRender(useStore, {
    activeId: 'bot-padre',
    agents: [{ id: 'bot-padre', name: 'Padre', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }],
    entries: [subEntry],
    subagents: [subOf(over)],
    ...extra
  })
  return parseHtml(renderHtml(createElement(SubagentCard, { entry: subEntry })))
}

const statoOf = (tree: ReturnType<typeof parseHtml>): string =>
  textOf(findAll(tree, (n) => n.attrs['data-testid'] === 'card-aiutante-stato')[0] ?? tree)

beforeEach(() => {
  useStore.setState({ activity: {} })
})

describe('AH3: lo stato del figlio si vede senza ricaricare la chat', () => {
  it('l\'evento subagents aggiorna la card: paused-for-approval → «aspetta te» (P6: il segno della barra)', async () => {
    // lo store: la card parte «al lavoro»…
    setStoreStateForRender(useStore, {
      activeId: 'bot-padre',
      agents: [{ id: 'bot-padre', name: 'Padre', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }],
      entries: [subEntry],
      subagents: [subOf({ agentStatus: 'running' })]
    })
    const t1 = parseHtml(renderHtml(createElement(SubagentCard, { entry: subEntry })))
    expect(statoOf(t1)).toContain('al lavoro')
    expect(statoOf(t1)).not.toContain('aspetta te')
    // …il daemon dice che il figlio si è fermato: l'evento subagents RICARICA la
    // lista (nessun reload della chat: le entries non si toccano)
    setStoreStateForRender(useStore, { subagents: [subOf({ agentStatus: 'paused-for-approval' })] })
    const t2 = parseHtml(renderHtml(createElement(SubagentCard, { entry: subEntry })))
    expect(statoOf(t2)).toContain('aspetta te')
  })

  it('lo stato «in attesa» si DISTINGUE: classe del colore d\'attesa, non quella del lavoro', () => {
    const tree = render({ agentStatus: 'paused-for-approval' })
    const stato = findAll(tree, (n) => n.attrs['data-testid'] === 'card-aiutante-stato')[0]
    expect(stato?.attrs['class'] ?? '').toContain('text-waiting')
    const running = render({ agentStatus: 'running' })
    const statoRun = findAll(running, (n) => n.attrs['data-testid'] === 'card-aiutante-stato')[0]
    expect(statoRun?.attrs['class'] ?? '').not.toContain('text-waiting')
  })
})

describe('AH3: la riga viva dell\'attività del figlio (le etichette del bot, mai l\'argomento grezzo)', () => {
  it('activity run-command → «esegue un comando…» (mai il comando intero)', () => {
    const tree = render({}, { activity: { 'sub-1': { tool: 'run-command', target: 'echo segretissimo-che-non-si-vede' } } })
    const row = findAll(tree, (n) => n.attrs['data-testid'] === 'aiutante-attivita')[0]
    expect(textOf(row!)).toContain('esegue un comando')
    expect(textOf(row!)).not.toContain('segretissimo')
  })

  it('un evento activity NUOVO cambia la riga: web_fetch → «legge dealer.moto.it…» (solo il dominio)', () => {
    const t1 = render({}, { activity: { 'sub-1': { tool: 'run-command', target: 'echo x' } } })
    expect(textOf(findAll(t1, (n) => n.attrs['data-testid'] === 'aiutante-attivita')[0]!)).toContain('esegue un comando')
    const t2 = render({}, { activity: { 'sub-1': { tool: 'web_fetch', target: 'https://dealer.moto.it/usato/v7' } } })
    expect(textOf(findAll(t2, (n) => n.attrs['data-testid'] === 'aiutante-attivita')[0]!)).toContain('legge dealer.moto.it')
    expect(textOf(findAll(t2, (n) => n.attrs['data-testid'] === 'aiutante-attivita')[0]!)).not.toContain('/usato/v7')
  })

  it('senza attività non c\'è riga viva (niente rumore)', () => {
    const tree = render({}, { activity: {} })
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'aiutante-attivita')).toHaveLength(0)
  })
})

describe('AH3: i passi fatti si contano e il tempo è sulla card', () => {
  it('steps 3 → «3 passi» sulla card (e cresce col valore del registro)', () => {
    const tree = render({ steps: 3 })
    const txt = textOf(tree)
    expect(txt).toContain('3 passi')
    const tree2 = render({ steps: 4 })
    expect(textOf(tree2)).toContain('4 passi')
  })

  it('il tempo trascorso sta nella riga con la sua ancora (aiutante-tempo)', () => {
    const tree = render({ startedAt: Date.now() - 90_000 })
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'aiutante-tempo').length).toBeGreaterThan(0)
  })

  it('un clic sul titolo della card apre il pannello del figlio (guardia sul sorgente: openSubagent sul titolo)', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('../components/SubagentCard.tsx', import.meta.url)), 'utf8')
    expect(src).toMatch(/onClick=\{\(\) => openSubagent\(message\.subagentId\)\}/)
    expect(src).toContain('aiutante-tempo')
  })
})

describe('AH3: lo store ricarica i subagents all\'evento (nessun reload della chat)', () => {
  it('evento subagents col parentId attivo → listSubagents richiamata, entries intatte', async () => {
    const { stubApiMethod } = await import('./render-helper-install')
    stubApiMethod('listAgents', () => [{ id: 'bot-padre', name: 'Padre', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }])
    stubApiMethod('listProviders', () => [])
    stubApiMethod('getPermissions', () => ({}))
    stubApiMethod('settingsGet', (...args: unknown[]) => args[1])
    stubApiMethod('listSubagents', () => [subOf({ agentStatus: 'paused-for-approval' })])
    await useStore.getState().init()
    useStore.setState({ entries: [subEntry], subagents: [], activeId: 'bot-padre' })
    const before = callsOf('listSubagents').length
    const onEvent = callsOf('onEvent')[0]!.args[0] as (e: unknown) => void
    onEvent({ type: 'subagents', parentId: 'bot-padre' })
    await vi.waitFor(() => expect(callsOf('listSubagents').length).toBeGreaterThan(before), { timeout: 2000, interval: 5 })
    expect(useStore.getState().subagents[0]?.agentStatus).toBe('paused-for-approval')
    // NESSUN reload della chat: le entries non si toccano
    expect(useStore.getState().entries).toEqual([subEntry])
  })
})
