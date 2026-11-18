// Q2 (fase squadra): la coda «Da approvare» (tavola 2) — guardia UI. Le tre
// sezioni del disegno, il chip di categoria, il perché, e «Consenti per
// questa missione» SOLO per sito-interattivo e squadra (mai dati tuoi,
// pagamento, invio). Il clic decide con la resolveApproval di oggi.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf } from './render-helper'

const { ApprovalsQueue, missionOffered, pendingWantsLine } = await import('../components/ApprovalsQueue')
const { useStore } = await import('../store')
const { i18n } = await import('../lib/i18n')

const group = () => ({
  id: 1, name: 'Weekend Torino', description: '', createdBy: 'user', coordinatorId: 'a1',
  members: [
    { agentId: 'a1', name: 'Capo', coordinator: true },
    { agentId: 'a2', name: 'Turismo', coordinator: false }
  ],
  createdAt: 1, lastMessageAt: null, autonomy: 'box' as const
})

const row = (over: Partial<Parameters<typeof missionOffered>[0] extends never ? never : Record<string, unknown>>): Record<string, unknown> => ({
  agentId: 'a2', agentName: 'Turismo', approvalId: 'ap-1', tool: 'fill_credential',
  phrase: 'Compilare il modulo del Museo Egizio con nome ed email.',
  category: 'dati-tuoi', why: 'fisso', when: Date.now() - 120_000, fromSubagent: false,
  ...over
})

function renderQueue(pending: Array<Record<string, unknown>>): ReturnType<typeof parseHtml> {
  const resolved: Array<Record<string, unknown>> = []
  setStoreStateForRender(useStore, {
    openGroupId: 1,
    groups: [group()],
    groupPending: pending,
    groupActivity: [
      { id: 'files', count: 14, who: ['Treni', 'Alloggio', 'Turismo'] },
      { id: 'pages', count: 44, who: ['Capo', 'Treni'] }
    ],
    groupReviewerPassed: [
      { agentId: 'a1', agentName: 'Treni', tool: 'browser_click', reason: 'serve alla tua richiesta', when: 1, grantId: null }
    ],
    resolveGroupApproval: (agentId: string, approvalId: string, decision: string, mode: string) => {
      resolved.push({ agentId, approvalId, decision, mode })
    },
    setApprovalsQueueOpen: () => resolved.push({ close: true }),
    refreshGroupPending: () => undefined
  })
  const html = renderHtml(createElement(ApprovalsQueue))
  return parseHtml(html)
}

describe('Q2: la coda «Da approvare» (tavola 2)', () => {
  it('le tre sezioni del disegno e la testata con «Torna alla squadra»', () => {
    const tree = renderQueue([])
    const text = textOf(tree)
    expect(text).toContain('Da approvare')
    expect(text).toContain('Weekend Torino · tutte le richieste della squadra, in un posto')
    expect(text).toContain('Torna alla squadra')
    expect(text).toContain('Solo tu puoi decidere')
    expect(text).toContain('Fatto da soli, senza chiederti')
    expect(text).toContain('Lasciato passare dal revisore')
    expect(text).toContain('14 file scritti nel computer')
    expect(text).toContain('44 pagine web lette')
    expect(text).toContain('Treni · serve alla tua richiesta')
  })

  it('la card mostra chip, bot, perché e i bottoni; il clic decide', () => {
    const tree = renderQueue([row({})])
    const text = textOf(tree)
    expect(text).toContain('i tuoi dati')
    expect(text).toContain('Turismo')
    expect(text).toContain('sempre a te')
    expect(text).toContain('Compilare il modulo del Museo Egizio con nome ed email.')
    expect(text).toContain('Consenti una volta')
    expect(text).toContain('Rifiuta')
    // l'insieme fisso NON offre la missione
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'approval-mission').length).toBe(0)
  })

  it('«Consenti per questa missione» c\'è per sito-interattivo e squadra, NON per dati-tuoi, pagamento e invio', () => {
    const tree = renderQueue([
      row({ approvalId: 'ap-s', category: 'sito-interattivo', tool: 'browser_click', why: 'revisore' }),
      row({ approvalId: 'ap-q', category: 'squadra', tool: 'send_to_agent', why: 'contaminato' })
    ])
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'approval-mission').length).toBe(2)
    // e la purea: missionOffered
    expect(missionOffered('sito-interattivo')).toBe(true)
    expect(missionOffered('squadra')).toBe(true)
    for (const c of ['dati-tuoi', 'pagamento', 'invio', 'mac', 'altro'] as const) expect(missionOffered(c), c).toBe(false)
  })

  it('la riga breve della barra: «Turismo vuole compilare un modulo con i tuoi dati»', () => {
    expect(pendingWantsLine(row({}) as never, i18n)).toContain('Turismo vuole compilare un modulo con i tuoi dati')
    expect(pendingWantsLine(row({ category: 'sito-interattivo' }) as never, i18n)).toContain('vuole aprire un sito')
  })
})
