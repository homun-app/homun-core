// AH1 (fase aiutanti): le azioni delle card chiamano la RPC con L'AGENTE DELLA
// CARD (entry.agentId), mai con activeId — il clic nel pannello del figlio
// finiva al padre e il daemon scartava l'approvazione («non in attesa»).
// L'aggiornamento ottimistico tocca la lista dove sta la card: entries (padre)
// oppure subEntries (figlio aperto). Store VERO con api finta: si chiamano le
// azioni e si guardano le chiamate RPC e lo stato.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { callsOf } from './render-helper-install'
import type { TranscriptEntry } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => ({}) as never)

const { useStore } = await import('../store')

const approvalEntry = (agentId: string, approvalId: string, id: number): TranscriptEntry => ({
  id,
  agentId,
  kind: 'approval',
  role: 'system',
  content: 'run-command: esegue un comando',
  meta: { approvalId, tool: 'run-command', status: 'pending', input: { command: 'echo x' } },
  createdAt: 1_000
})

beforeEach(() => {
  useStore.setState({
    activeId: 'bot-padre',
    openSubagentId: null,
    entries: [],
    subEntries: []
  })
})

describe('AH1: resolveApproval usa l\'agente della card (entry.agentId)', () => {
  it('card di approvazione del FIGLIO nel pannello → la RPC riceve l\'id del FIGLIO', () => {
    useStore.setState({
      activeId: 'bot-padre',
      openSubagentId: 'sub-1',
      entries: [approvalEntry('bot-padre', 'a-padre', 1)],
      subEntries: [approvalEntry('sub-1', 'a-figlio', 7)]
    })
    useStore.getState().resolveApproval('sub-1', 'a-figlio', 'allow', 'once')
    const calls = callsOf('resolveApproval')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1]!.args).toEqual(['sub-1', 'a-figlio', 'allow', 'once'])
  })

  it('la card nel pannello passa a «consentito» (ottimistico su subEntries)', () => {
    useStore.setState({
      activeId: 'bot-padre',
      openSubagentId: 'sub-1',
      subEntries: [approvalEntry('sub-1', 'a-figlio', 7)]
    })
    useStore.getState().resolveApproval('sub-1', 'a-figlio', 'allow', 'turn')
    const en = useStore.getState().subEntries.find((e) => e.meta?.approvalId === 'a-figlio')
    expect(en?.meta?.status).toBe('allowed')
    expect(en?.meta?.resolutionMode).toBe('turn')
  })

  it('GUARDIA: la card del PADRE continua a mandare l\'id del padre (entries)', () => {
    useStore.setState({
      activeId: 'bot-padre',
      entries: [approvalEntry('bot-padre', 'a-padre', 1)]
    })
    useStore.getState().resolveApproval('bot-padre', 'a-padre', 'deny', 'once')
    const calls = callsOf('resolveApproval')
    expect(calls[calls.length - 1]!.args).toEqual(['bot-padre', 'a-padre', 'deny', 'once'])
    const en = useStore.getState().entries.find((e) => e.meta?.approvalId === 'a-padre')
    expect(en?.meta?.status).toBe('denied')
  })

  it('negare la card del figlio NON tocca le entries del padre', () => {
    useStore.setState({
      activeId: 'bot-padre',
      openSubagentId: 'sub-1',
      entries: [approvalEntry('bot-padre', 'a-padre', 1)],
      subEntries: [approvalEntry('sub-1', 'a-figlio', 7)]
    })
    useStore.getState().resolveApproval('sub-1', 'a-figlio', 'deny', 'once')
    const padre = useStore.getState().entries.find((e) => e.meta?.approvalId === 'a-padre')
    expect(padre?.meta?.status).toBe('pending')
  })
})

describe('AH1: le card passano entry.agentId (guardia sul sorgente)', () => {
  const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

  it('ApprovalCard risolve con l\'agente della entry', () => {
    const s = src('../components/ApprovalCard.tsx')
    expect(s).toContain('resolve(entry.agentId')
    expect(s).not.toMatch(/resolve\((approvalId|activeId)/)
  })

  it('FillCard e ContactCard risolvono con l\'agente della entry', () => {
    expect(src('../components/LibraryCards.tsx')).toContain('resolveApproval(entry.agentId')
  })

  it('SecureInputCard annulla con l\'agente della entry', () => {
    expect(src('../components/LibraryCards.tsx')).toContain('resolveApproval(entry.agentId')
  })
})
