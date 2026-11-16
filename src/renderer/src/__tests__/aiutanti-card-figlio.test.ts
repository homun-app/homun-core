// AH2 (fase aiutanti): la card del figlio compare nella CHAT DEL PADRE, sotto
// la card «Aiutante», con l'intestazione «L'aiutante «titolo» chiede:» — è la
// STESSA approvazione (entry del FIGLIO, letta da subagents:list), il clic
// risolve sul figlio (entry.agentId, AH1). Render statico del componente
// VERO col store; la sidebar segna il bot «ti aspetta» finché c'è una card
// del figlio aperta (funzione pura di sidebar-utils).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, dialogPassThroughMock } from './render-helper'
import type { TranscriptEntry } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())

const { SubagentCard } = await import('../components/SubagentCard')
const { useStore } = await import('../store')
const { buildSidebarModel, collapsedVoices } = await import('../sidebar-utils')
const { notifyOpenAgentOf } = await import('../../../daemon/notifications')

const childApproval: TranscriptEntry = {
  id: 42,
  agentId: 'sub-1',
  kind: 'approval',
  role: 'system',
  content: 'run-command: run-command requires approval',
  meta: { approvalId: 'ap-1', tool: 'run-command', status: 'pending', input: { command: 'echo x' } },
  createdAt: 1_000
}

const subEntry = (subagentId: string, title: string): TranscriptEntry => ({
  id: 7,
  agentId: 'bot-padre',
  kind: 'send-message',
  role: 'assistant',
  content: '',
  meta: { message: { type: 'subagent', subagentId, title } },
  createdAt: 900
})

const subagentsOf = (pendingApprovals: TranscriptEntry[]) => [{
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
  agentStatus: 'paused-for-approval' as const,
  pendingApprovals
}]

describe('AH2: la card del figlio nella chat del padre', () => {
  it('figlio con approval pending → intestazione «L’aiutante «titolo» chiede:» e la card con Consenti, dentro aiutante-card-figlio', () => {
    setStoreStateForRender(useStore, {
      activeId: 'bot-padre',
      agents: [{ id: 'bot-padre', name: 'Padre', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }],
      entries: [subEntry('sub-1', 'Screenshot delle 5 foto')],
      subagents: subagentsOf([childApproval])
    })
    const tree = parseHtml(renderHtml(createElement(SubagentCard, { entry: subEntry('sub-1', 'Screenshot delle 5 foto') })))
    const wrap = findAll(tree, (n) => n.attrs['data-testid'] === 'aiutante-card-figlio')[0]
    expect(wrap).toBeDefined()
    const txt = textOf(wrap!)
    expect(txt).toContain('L’aiutante')
    expect(txt).toContain('Screenshot delle 5 foto')
    expect(txt).toContain('chiede:')
    // la card è QUELLA del figlio (stessa approvalId, agentId del figlio) e ha i bottoni
    const buttons = findAll(wrap!, (n) => n.tag === 'button').map((b) => textOf(b))
    expect(buttons).toContain('Consenti')
    expect(buttons).toContain('Rifiuta')
  })

  it('nessuna approval pending → nessuna card del figlio nella chat del padre', () => {
    setStoreStateForRender(useStore, {
      activeId: 'bot-padre',
      agents: [{ id: 'bot-padre', name: 'Padre', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }],
      entries: [subEntry('sub-1', 'Screenshot delle 5 foto')],
      subagents: subagentsOf([])
    })
    const tree = parseHtml(renderHtml(createElement(SubagentCard, { entry: subEntry('sub-1', 'Screenshot delle 5 foto') })))
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'aiutante-card-figlio')).toHaveLength(0)
  })
})

describe('AH2: la sidebar segna il bot «ti aspetta» finché c’è una card del figlio aperta', () => {
  const agents: import('../../../shared/types').Agent[] = [
    { id: 'bot-padre', name: 'Padre', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 },
    { id: 'bot-2', name: 'Altro', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 2 }
  ]

  it('un bot con figli in attesa → la barra stretta dice waiting («ti aspetta»)', () => {
    const model = buildSidebarModel(agents, [], 'bot-padre', '', new Set(['bot-padre']))
    const padre = collapsedVoices(model).find((v) => v.key === 'bot-padre')
    expect(padre?.status).toBe('waiting')
  })

  it('GUARDIA: senza figli in attesa lo stato resta quello dell’agente (idle)', () => {
    const model = buildSidebarModel(agents, [], 'bot-padre', '', new Set())
    const padre = collapsedVoices(model).find((v) => v.key === 'bot-padre')
    expect(padre?.status).toBe('idle')
    // e il proprio stato dell'agente vince comunque per gli altri bot
    const altro = collapsedVoices(model).find((v) => v.key === 'bot-2')
    expect(altro?.status).toBe('idle')
  })
})

describe('AH2: la notifica di un figlio apre la chat del PADRE', () => {
  it('notifyOpenAgentOf: il figlio porta al padre, il bot normale resta senza destinazione', () => {
    expect(notifyOpenAgentOf({ parentId: 'bot-padre' })).toBe('bot-padre')
    expect(notifyOpenAgentOf({ parentId: null })).toBeUndefined()
    expect(notifyOpenAgentOf(null)).toBeUndefined()
  })
})
