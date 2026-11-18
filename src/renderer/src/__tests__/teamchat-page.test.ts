// Q6 (fase squadra): la pagina si apre a lato ANCHE dentro la chat di
// squadra. Causa: PageView viveva solo dentro Chat.tsx e App.tsx mostra
// TeamChat quando c'è una squadra aperta — il clic su un documento nella
// Libreria impostava openPageInfo ma nessuno lo mostrava. Il test è stato
// visto ROSSO prima della correzione.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'

vi.mock('../components/PageView', () => ({ PageView: () => null }))

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

const { renderHtml, setStoreStateForRender } = await import('./render-helper')
const { TeamChat } = await import('../components/TeamChat')
const { useStore } = await import('../store')

const group = {
  id: 7, name: 'Weekend Torino', description: '', createdBy: 'user', coordinatorId: 'a1',
  members: [{ agentId: 'a1', name: 'Capo', coordinator: true }],
  createdAt: 1, lastMessageAt: null, autonomy: 'box' as const
}

function renderTeamChatWithPage(open: boolean): void {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    openGroupId: 7,
    groups: [group],
    groupMessages: [],
    groupCards: [],
    groupPending: [],
    groupPendingCount: {},
    groupActivity: [],
    groupReviewerPassed: [],
    approvalsQueueOpen: false,
    agents: [],
    ...(open ? { openPageInfo: { id: 'doc-1', from: 'library' as const, title: '', version: 0 } } : { openPageInfo: null })
  })
}

describe('Q6: il documento si apre a lato anche con la squadra aperta', () => {
  it('con openPageInfo impostato, TeamChat monta PageView (il clic in Libreria apre la pagina)', () => {
    renderTeamChatWithPage(true)
    renderHtml(createElement(TeamChat))
    const pageView = capture.els.find((e) => {
      const t = e.type as { name?: string } | string
      return typeof t === 'function' && t.name === 'PageView'
    })
    expect(pageView).toBeTruthy()
  })

  it('senza pagina aperta la timeline resta al suo posto (PageView si spegne da sé, come in Chat)', () => {
    renderTeamChatWithPage(false)
    const html = renderHtml(createElement(TeamChat))
    // nessun marcato di pagina nell'HTML (il mock rende null) e la timeline c'è
    expect(html).not.toContain('data-testid="page-view"')
    expect(html).toContain('Nessun messaggio nella squadra')
  })
})
