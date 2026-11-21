// K3 (fase team-bot): il CLIC sul nome del team apre/chiude — un clic su un
// team NON attivo ne apre la chat E i membri; un clic sul team GIÀ attivo
// apre o chiude i membri (la freccia resta la scorciatoia di sempre, lo
// stato si salva come oggi in sandbot:sidebar.teamOpen.<id>). Il DOPPIO CLIC
// sul nome rinomina IN LINEA (Invio salva, Esc annulla), per i team e per i
// bot. Handler VERI invocati dal render con la cattura del runtime JSX.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { i18n } from '@lingui/core'
import { renderHtml, setStoreStateForRender } from './render-helper'
import { itCatalogEntries } from './po-helper'
import type { Agent, GroupInfo } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => ({} as never))
vi.mock('../components/ui/dropdown-menu', () => ({ DropdownMenu: () => null, DropdownMenuTrigger: () => null, DropdownMenuContent: () => null, DropdownMenuItem: () => null, DropdownMenuSeparator: () => null, DropdownMenuSub: () => null, DropdownMenuSubTrigger: () => null, DropdownMenuSubContent: () => null, DropdownMenuRadioGroup: () => null, DropdownMenuRadioItem: () => null }))

// il localStorage finto (la scelta aperto/chiuso si salva lì, come oggi):
// il codice usa l'identificatore GLOBALE localStorage, non window.localStorage
const lsStore = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => { lsStore.set(k, v) },
  removeItem: (k: string) => { lsStore.delete(k) }
}

const capture = { els: [] as Array<{ type: unknown; props: Record<string, unknown> }> }
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

i18n.load('it', itCatalogEntries())
i18n.activate('it')

const { Sidebar } = await import('../components/Sidebar')
const { useStore } = await import('../store')

const SRC_SIDEBAR = readFileSync(fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url)), 'utf8')

const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({
  id, name, description: '', providerId: null, model: null, status: 'idle', unread: 0,
  createdAt: 1, createdBy: null, section: null, parentId: null, avatar: null, ...over
})
const group = (id: number, name: string, members: GroupInfo['members'], coordinatorId: string, over: Partial<GroupInfo> = {}): GroupInfo => ({
  id, name, description: 'desc del team', createdBy: 'u', coordinatorId, members, createdAt: 1, lastMessageAt: null, autonomy: 'box', ...over
})

const layoutFull = { sidebar: 'full' as const, sidebarWidth: 260, panel: 'hidden' as const, panelWidth: 0 }

function render(patch: Record<string, unknown> = {}): void {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    onboarding: { needed: false, state: null, sequence: ['chat'], modelReady: false, guideOpen: false },
    agents: [agent('main', 'Bot'), agent('b2', 'Competitoor')],
    groups: [group(1, 'Weekend Torino', [
      { agentId: 'main', name: 'Bot', coordinator: true },
      { agentId: 'b2', name: 'Competitoor', coordinator: false }
    ], 'main')],
    mainAgentId: 'main', activeId: 'main', openGroupId: null,
    previews: {}, turnEnds: {}, lastSendAt: {}, typingAgentId: null, lastDeltaAt: {}, nowTick: 0,
    approvalsAll: [], approvalsBotCount: {}, groupPendingCount: {},
    activityOpen: false, openLibraryId: null, approvalsOpen: false,
    subagents: [], activity: {}, windowWidth: 1400,
    ...patch
  })
  renderHtml(createElement(Sidebar, { layout: layoutFull }))
}

/** il bottone del NOME del team (title = «nome · descrizione», come il suggerimento di oggi) */
const teamNameButton = (): Record<string, unknown> | undefined =>
  capture.els.find((e) => e.type === 'button' && e.props.title === 'Weekend Torino · desc del team')?.props

beforeEach(() => {
  lsStore.clear()
  useStore.setState({ openGroupId: null })
})

describe('K3: clic sul nome del team', () => {
  it('un clic su un team NON attivo apre la chat (openGroupId) E i membri (stato salvato)', () => {
    render()
    const btn = teamNameButton()
    expect(btn).toBeTruthy()
    ;(btn!.onClick as () => void)()
    // apre la chat del team…
    expect(useStore.getState().openGroupId).toBe(1)
    // …e mostra i membri: la scelta si salva come today in teamOpen
    expect(lsStore.get('sandbot:sidebar.teamOpen.1')).toBe('1')
  })

  it('un clic sul team GIÀ attivo apre/chiude i membri (senza riaprire la chat)', () => {
    // il team è aperto e i membri sono APERTI (come li ha lasciati il primo clic)
    lsStore.set('sandbot:sidebar.teamOpen.1', '1')
    render({ openGroupId: 1 })
    const btn = teamNameButton()
    expect(btn).toBeTruthy()
    ;(btn!.onClick as () => void)()
    // li CHIUDE: la scelta si salva, e la chat resta quella del team
    expect(lsStore.get('sandbot:sidebar.teamOpen.1')).toBe('0')
    expect(useStore.getState().openGroupId).toBe(1)
    // e il clic successivo li riapre
    render({ openGroupId: 1 })
    ;(teamNameButton()!.onClick as () => void)()
    expect(lsStore.get('sandbot:sidebar.teamOpen.1')).toBe('1')
  })
})

describe('K3: doppio clic sul nome → rinomina in linea (team e bot)', () => {
  it('il NOME del team e il nome dei bot hanno onDoubleClick', () => {
    render({ openGroupId: 1 })
    lsStore.set('sandbot:sidebar.teamOpen.1', '1')
    render({ openGroupId: 1 })
    const spans = capture.els.filter((e) => e.type === 'span' && typeof e.props.onDoubleClick === 'function')
    const names = spans.map((e) => String(e.props.children))
    expect(names).toContain('Weekend Torino')
    expect(names).toContain('Competitoor')
  })

  it('InlineName: Invio salva (onCommit col valore), Esc annulla (guardia sul sorgente del wiring)', () => {
    // il campo esiste già (K2, dal menu «Rinomina»): qui la guardia è che
    // Invio committa, Esc annulla, e il commit dei bot/team chiama le RPC
    expect(SRC_SIDEBAR).toMatch(/if \(e\.key === 'Enter'\) onCommit\(v\.trim\(\) \|\| name\)/)
    expect(SRC_SIDEBAR).toMatch(/else if \(e\.key === 'Escape'\) onCancel\(\)/)
    expect(SRC_SIDEBAR).toMatch(/onDoubleClick=\{\(\) => setRenaming\(true\)\}/)
  })
})
