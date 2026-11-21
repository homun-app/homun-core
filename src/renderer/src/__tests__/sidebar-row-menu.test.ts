// K2 (fase team-bot): il menu della riga per bot e team — «⋯» al passaggio
// del mouse e lo STESSO menu col tasto destro; voci Rinomina · Archivia ·
// Elimina (per i team anche «Apri impostazioni del team»); il bot PRINCIPALE
// non ha il menu. E la sezione «Archiviati» in fondo, chiusa di default col
// conteggio, con «Eliminati» dentro e i Ripristina; l'avviso «Eliminato ·
// Annulla» dura 10 s. Render statico della barra + guardie sul wiring del
// tasto destro (il contesto non si vede nell'HTML statico).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { i18n } from '@lingui/core'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf } from './render-helper'
import { itCatalogEntries } from './po-helper'
import type { Agent, GroupInfo } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => ({} as never))
// il menu si rende PASSANTE: così le voci (Rinomina, Archivia, Elimina) si
// vedono nell'HTML statico, come farebbe il menu APERTO
vi.mock('../components/ui/dropdown-menu', () => {
  const pass = (tag: string) => ({ children, ...rest }: { children?: unknown } & Record<string, unknown>) =>
    createElement('div', { 'data-mock': tag, ...rest }, children as never)
  return {
    DropdownMenu: pass('dropdown'),
    DropdownMenuTrigger: pass('dropdown-trigger'),
    DropdownMenuContent: pass('dropdown-content'),
    DropdownMenuItem: pass('dropdown-item'),
    DropdownMenuSeparator: pass('dropdown-sep'),
    DropdownMenuSub: pass('dropdown-sub'),
    DropdownMenuSubTrigger: pass('dropdown-sub-trigger'),
    DropdownMenuSubContent: pass('dropdown-sub-content'),
    DropdownMenuRadioGroup: pass('dropdown-radio-group'),
    DropdownMenuRadioItem: pass('dropdown-radio-item')
  }
})

i18n.load('it', itCatalogEntries())
i18n.activate('it')

const { Sidebar } = await import('../components/Sidebar')
const { useStore } = await import('../store')

const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({
  id, name, description: '', providerId: null, model: null, status: 'idle', unread: 0,
  createdAt: 1, createdBy: null, section: null, parentId: null, avatar: null, ...over
})
const group = (id: number, name: string, members: GroupInfo['members'], coordinatorId: string | null, over: Partial<GroupInfo> = {}): GroupInfo => ({
  id, name, description: '', createdBy: 'u', coordinatorId, members, createdAt: 1, lastMessageAt: null, autonomy: 'box', ...over
})

const layoutFull = { sidebar: 'full' as const, sidebarWidth: 260, panel: 'hidden' as const, panelWidth: 0 }

function renderSidebar(patch: Record<string, unknown> = {}): ReturnType<typeof parseHtml> {
  setStoreStateForRender(useStore, {
    onboarding: { needed: false, state: null, sequence: ['chat'], modelReady: false, guideOpen: false },
    agents: [
      agent('main', 'Bot'),
      agent('b1', 'Ricerche', { status: 'thinking' }),
      agent('b2', 'Competitoor'),
      // K2: uno archiviato e uno eliminato (dentro «Archiviati»/«Eliminati»)
      agent('a1', 'Vecchio Lavori', { archivedAt: 1_000 }),
      agent('d1', 'Andato', { deletedAt: 2_000 })
    ],
    groups: [
      group(1, 'Fatture marzo', [
        { agentId: 'main', name: 'Bot', coordinator: true },
        { agentId: 'b2', name: 'Competitoor', coordinator: false }
      ], 'main'),
      group(2, 'Team archiviato', [
        { agentId: 'b1', name: 'Ricerche', coordinator: true }
      ], 'b1', { archivedAt: 3_000 })
    ],
    mainAgentId: 'main', activeId: 'main', openGroupId: null,
    previews: {}, turnEnds: {}, lastSendAt: {}, typingAgentId: null, lastDeltaAt: {}, nowTick: 0,
    approvalsAll: [], approvalsBotCount: {}, groupPendingCount: {},
    activityOpen: false, openLibraryId: null, approvalsOpen: false,
    subagents: [], activity: {}, windowWidth: 1400,
    ...patch
  })
  return parseHtml(renderHtml(createElement(Sidebar, { layout: layoutFull })))
}

const SRC_SIDEBAR = readFileSync(fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url)), 'utf8')

describe('K2 render: il bottone «⋯» e le voci del menu', () => {
  it('ogni riga di BOT e di TEAM ha il «⋯» con aria-label «Altre azioni»; il PRINCIPALE no', () => {
    const tree = renderSidebar()
    const mores = findAll(tree, (n) => n.attrs['data-testid'] === 'row-more')
    // team 1 + bot singolo b1 (i membri rendono il menu quando il team è
    // aperto: la sonda lo prova sul vivo; a1 e d1 stanno in Archiviati, senza menu)
    expect(mores.map((m) => m.attrs['data-agent'] ?? m.attrs['data-group'])).toEqual(['1', 'b1'])
    for (const m of mores) expect(m.attrs['aria-label']).toBe('Altre azioni')
    // il principale non ha il menu (niente row-more con data-agent="main")
    expect(mores.some((m) => m.attrs['data-agent'] === 'main')).toBe(false)
  })

  it('le voci: Rinomina · Archivia · Elimina; il team anche «Apri impostazioni del team»', () => {
    const tree = renderSidebar()
    // il menu (mock passante) rende le voci come elementi non-bottone
    const text = textOf(tree)
    expect(text).toContain('Rinomina')
    expect(text).toContain('Archivia')
    expect(text).toContain('Elimina')
    expect(text).toContain('Apri impostazioni del team')
  })

  it('il tasto destro apre lo STESSO menu: onContextMenu sulla riga e menu controllato (guardia sul sorgente)', () => {
    expect(SRC_SIDEBAR).toMatch(/onContextMenu=/)
    expect(SRC_SIDEBAR).toMatch(/openRowMenu|menuOpen/)
  })
})

describe('K2 render: la sezione «Archiviati» e l\'avviso «Eliminato · Annulla»', () => {
  it('«Archiviati» in fondo col conteggio, chiusa di default: gli archiviati NON stanno nella barra', () => {
    const tree = renderSidebar()
    const text = textOf(tree)
    // fuori dalla barra viva…
    const navButtons = findAll(tree, (n) => n.tag === 'button' && (n.parent?.tag !== 'div' || true)).map((b) => textOf(b))
    expect(navButtons.some((t) => t === 'Vecchio Lavori')).toBe(false)
    expect(navButtons.some((t) => t === 'Team archiviato')).toBe(false)
    // …dentro Archiviati col conteggio (1 archiviato + 1 eliminato = 2)
    expect(text).toContain('Archiviati')
    expect(text).toContain('2')
    // il team archiviato mette i suoi membri come bot singoli (b1 resta visibile)
    expect(navButtons.some((t) => t.includes('Ricerche'))).toBe(true)
  })

  it('con «Archiviati» APERTA: righe col Ripristina, e la sottosezione «Eliminati»', () => {
    const tree = renderSidebar({ sidebarArchivedOpen: true })
    const text = textOf(tree)
    expect(text).toContain('Vecchio Lavori')
    expect(text).toContain('Team archiviato')
    expect(text).toContain('Eliminati')
    expect(text).toContain('Andato')
    const restores = findAll(tree, (n) => n.attrs['data-testid']?.startsWith('archived-restore-'))
    expect(restores.map((r) => r.attrs['data-testid'])).toEqual(['archived-restore-group-2', 'archived-restore-agent-a1', 'archived-restore-agent-d1'])
  })

  it('l\'avviso «Eliminato · Annulla» sta nella barra solo finché c\'è il rimovibile (10 s)', () => {
    const senza = renderSidebar()
    expect(textOf(senza).includes('Eliminato')).toBe(false)
    const con = renderSidebar({ removedUndo: { kind: 'bot', id: 'd1', name: 'Andato', expiresAt: Date.now() + 10_000 } })
    const text = textOf(con)
    expect(text).toContain('Eliminato')
    expect(text).toContain('Andato')
    expect(text).toContain('Annulla')
    expect(findAll(con, (n) => n.attrs['data-testid'] === 'removed-undo').length).toBe(1)
  })
})
