// P4 (fase uso-permessi): le richieste dell'aiutante si vedono dove sei — la
// card «Aiutante» nella chat del padre mostra in evidenza «aspetta te» con la
// frase della richiesta e «Decidi», che apre il centro «Da approvare» SU
// quella richiesta (lo stesso riquadro A3 in cima alla chat conta già le
// richieste degli aiutanti: qui si verifica che compaia). Render statico del
// componente VERO col store, come aiutanti-card-viva.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf } from './render-helper'
import type { TranscriptEntry, ApprovalsCenterRow } from '../../../shared/types'

const { SubagentCard } = await import('../components/SubagentCard')
const { useStore } = await import('../store')

const subEntry: TranscriptEntry = {
  id: 7,
  agentId: 'bot-padre',
  kind: 'send-message',
  role: 'assistant',
  content: '',
  meta: { message: { type: 'subagent', subagentId: 'sub-1', title: 'Cerca i biglietti' } },
  createdAt: 900
}

/** la entry di approvazione PENDENTE del figlio (come subagents:list la porta) */
const childApproval: TranscriptEntry = {
  id: 42,
  agentId: 'sub-1',
  kind: 'approval',
  role: 'system',
  content: 'vuole cliccare «Conferma acquisto» su lefrecce.it',
  meta: { approvalId: 'appr-b1', tool: 'browser_click', status: 'pending', input: { ref: 'e8' } },
  createdAt: 950
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

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('P4: la card dell\'aiutante che aspetta te — «aspetta te» e «Decidi»', () => {
  it('col figlio in attesa: la card mostra «aspetta te», la FRASE della richiesta e il bottone «Decidi»', () => {
    setStoreStateForRender(useStore as never, {
      subagents: [subOf({ agentStatus: 'paused-for-approval', pendingApprovals: [childApproval] })]
    })
    const html = renderHtml(createElement(SubagentCard, { entry: subEntry }))
    const root = parseHtml(html)
    // il riquadro in evidenza col nome dello stato della barra
    const waiting = findAll(root, (n) => n.attrs['data-testid'] === 'card-aiutante-aspetta-te')[0]
    expect(waiting).toBeTruthy()
    expect(textOf(waiting)).toContain('aspetta te')
    // la FRASE della richiesta (quella della card del figlio), non solo il conto
    expect(textOf(waiting)).toContain('Conferma acquisto')
    // «Decidi» apre il centro SU quella richiesta (guardia sul sorgente)
    const decidi = findAll(root, (n) => n.tag === 'button' && textOf(n) === 'Decidi')[0]
    expect(decidi).toBeTruthy()
    const src = readFileSync(fileURLToPath(new URL('../components/SubagentCard.tsx', import.meta.url)), 'utf8')
    expect(src).toMatch(/setApprovalsOpen\(true, String\(sub!\.pendingApprovals!\[0\]!\.meta\?\.approvalId/)
  })

  it('il figlio al lavoro SENZA richieste: niente riquadro «aspetta te», niente «Decidi»', () => {
    setStoreStateForRender(useStore as never, {
      subagents: [subOf({ agentStatus: 'running', pendingApprovals: [] })]
    })
    const html = renderHtml(createElement(SubagentCard, { entry: subEntry }))
    const root = parseHtml(html)
    expect(findAll(root, (n) => n.attrs['data-testid'] === 'card-aiutante-aspetta-te')).toEqual([])
    expect(findAll(root, (n) => n.tag === 'button' && textOf(n) === 'Decidi')).toEqual([])
  })

  it('il riquadro A3 della chat conta GIÀ le richieste degli aiutanti (verifica: «+N altrove»)', async () => {
    const { ApprovalsBannerElsewhere } = await import('../components/ApprovalsBanner')
    // la riga del centro per la richiesta del FIGLIO: botName del padre (il
    // figlio non è in roster), agentId del figlio
    const row: ApprovalsCenterRow = {
      agentId: 'sub-1',
      approvalId: 'appr-b1',
      botId: 'bot-padre',
      botName: 'Bot padre',
      phrase: 'vuole cliccare «Conferma acquisto» su lefrecce.it',
      category: 'sito-interattivo',
      when: 950,
      fromSubagent: true
    } as unknown as ApprovalsCenterRow
    setStoreStateForRender(useStore as never, {
      approvalsAll: [row],
      approvalsSnoozed: {},
      openGroupId: null
    })
    const html = renderHtml(createElement(ApprovalsBannerElsewhere))
    const root = parseHtml(html)
    expect(textOf(root)).toContain('+1 altrove')
  })
})
