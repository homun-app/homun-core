// B1 (fase beta10-correzioni): il centro «Da approvare» si disegna SOLO con
// approvalsOpen === true. La beta.10 lo rendeva da App SENZA condizione e il
// centro copriva la chat per sempre: scegliere un bot, crearne uno, aprire
// una squadra, la Libreria o Attività cambiava solo il pannello di destra.
// Qui si rende App INTERA (non il componente da solo): con lo stato chiuso il
// centro non c'è, e ogni azione che lo chiude riporta la vista che tocca.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf } from './render-helper'
import { stubApiMethod } from './render-helper-install'
import type { OnboardingStatus } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => ({} as never))

const { App } = await import('../App')
const { useStore } = await import('../store')

// lo stato della shell: onboarding noto, guida chiusa → la finestra è la chat
const onboarding = { needed: false, state: null, sequence: ['chat'], modelReady: false, guideOpen: false } as unknown as OnboardingStatus

const agentA = { id: 'a-turismo', name: 'Turismo', description: '', providerId: 'p', model: 'm', status: 'idle', unread: 0, createdAt: 1 }
const agentB = { id: 'a-alloggio', name: 'Alloggio', description: '', providerId: 'p', model: 'm', status: 'idle', unread: 0, createdAt: 2 }
const agentNuovo = { id: 'a-nuovo', name: 'Nuovo', description: '', providerId: null, model: null, status: 'offline', unread: 0, createdAt: 3 }
const groups = [{
  id: 1, name: 'Weekend Torino', description: '', createdBy: 'user', coordinatorId: 'a-turismo',
  members: [{ agentId: 'a-turismo', name: 'Turismo', coordinator: true }], createdAt: 1, lastMessageAt: null, autonomy: 'box' as const
}]

/** lo stato della corsa: la shell coi due bot, il centro come lo chiede il test */
function shellState(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    onboarding, agents: [agentA, agentB], activeId: 'a-turismo', entries: [],
    groups, groupMessages: [], openGroupId: null, activityOpen: false, openLibraryId: null,
    approvalsAll: [], approvalsSnoozed: {}, approvalsOpen: false, approvalsFocusId: null,
    approvalsQueueOpen: false, approvalsBannerCollapsed: false,
    settingsOpen: false, appsOpen: false, skillsOpen: false, rightPanel: false,
    ...patch
  }
}

function renderApp(): ReturnType<typeof parseHtml> {
  return parseHtml(renderHtml(createElement(App)))
}

/** il render server legge getServerSnapshot (lo stato iniziale): dopo
 *  un'azione dello store VIVO lo si ricopia lì, come fa il render helper */
function syncServerState(): void {
  Object.assign(useStore.getInitialState() as unknown as Record<string, unknown>, useStore.getState())
}

const centerIn = (tree: ReturnType<typeof parseHtml>) =>
  findAll(tree, (n) => n.attrs['data-testid'] === 'approvals-center')
const composerOf = (tree: ReturnType<typeof parseHtml>) =>
  findAll(tree, (n) => n.tag === 'textarea' && (n.attrs.placeholder ?? '').includes('Scrivi a')).map((n) => n.attrs.placeholder)

describe('B1: il centro «Da approvare» si disegna solo quando è aperto', () => {
  it('approvalsOpen false → NESSUN centro nel DOM (la chat resta libera)', () => {
    setStoreStateForRender(useStore, shellState({ approvalsOpen: false }))
    expect(centerIn(renderApp())).toHaveLength(0)
  })

  it('approvalsOpen true → il centro c\'è (e copre l\'area centrale)', () => {
    setStoreStateForRender(useStore, shellState({ approvalsOpen: true }))
    expect(centerIn(renderApp())).toHaveLength(1)
  })

  it('dal centro aperto, select(altro bot) → il centro sparisce e c\'è la chat di quel bot', async () => {
    stubApiMethod('getEntries', () => [])
    stubApiMethod('listSubagents', () => [])
    stubApiMethod('updateAgent', () => ({}))
    setStoreStateForRender(useStore, shellState({ approvalsOpen: true, activeId: 'a-turismo' }))
    expect(centerIn(renderApp())).toHaveLength(1)
    await useStore.getState().select('a-alloggio')
    expect(useStore.getState().approvalsOpen).toBe(false)
    syncServerState()
    const tree = renderApp()
    expect(centerIn(tree)).toHaveLength(0)
    expect(composerOf(tree)).toEqual(['Scrivi a Alloggio'])
  })

  it('dal centro aperto, createAgent + selezione del nuovo → il centro sparisce', async () => {
    stubApiMethod('createAgent', () => agentNuovo)
    stubApiMethod('listAgents', () => [agentA, agentB, agentNuovo])
    stubApiMethod('getEntries', () => [])
    stubApiMethod('listSubagents', () => [])
    stubApiMethod('updateAgent', () => ({}))
    setStoreStateForRender(useStore, shellState({ approvalsOpen: true }))
    await useStore.getState().createAgent('Nuovo')
    expect(useStore.getState().activeId).toBe('a-nuovo')
    expect(useStore.getState().approvalsOpen).toBe(false)
    syncServerState()
    const tree = renderApp()
    expect(centerIn(tree)).toHaveLength(0)
    expect(composerOf(tree)).toEqual(['Scrivi a Nuovo'])
  })

  it('dal centro aperto, openGroup(id) → il centro sparisce, la squadra al suo posto', async () => {
    // openGroup forza la passata di refresh: le sue risposte (api finta)
    // non devono spazzare lo stato del test
    stubApiMethod('listGroups', () => groups)
    stubApiMethod('listAgents', () => [agentA, agentB])
    stubApiMethod('approvalsPendingAll', () => [])
    stubApiMethod('groupMessages', () => [])
    stubApiMethod('groupApprovalCards', () => [])
    stubApiMethod('groupOverview', () => ({ members: [], produced: [] }))
    stubApiMethod('groupPendingApprovals', () => ({ pending: [], activity: [], reviewerPassed: [] }))
    setStoreStateForRender(useStore, shellState({ approvalsOpen: true }))
    expect(centerIn(renderApp())).toHaveLength(1)
    await useStore.getState().openGroup(1)
    expect(useStore.getState().approvalsOpen).toBe(false)
    syncServerState()
    const tree = renderApp()
    expect(centerIn(tree)).toHaveLength(0)
    expect(textOf(tree)).toContain('Weekend Torino')
  })

  it('dal centro aperto, la Libreria → il centro sparisce', () => {
    setStoreStateForRender(useStore, shellState({ approvalsOpen: true }))
    useStore.getState().openLibrary('lib-1')
    expect(useStore.getState().approvalsOpen).toBe(false)
    syncServerState()
    const tree = renderApp()
    expect(centerIn(tree)).toHaveLength(0)
    expect(textOf(tree)).toContain('Libreria')
  })

  it('dal centro aperto, Attività → il centro sparisce', () => {
    setStoreStateForRender(useStore, shellState({ approvalsOpen: true }))
    useStore.getState().setActivityOpen(true)
    expect(useStore.getState().approvalsOpen).toBe(false)
    syncServerState()
    const tree = renderApp()
    expect(centerIn(tree)).toHaveLength(0)
    expect(textOf(tree)).toContain('Attività')
  })
})
