// R2 (fase barra-sobria): GLI STATI, PRESI DALLA MASCOTTE (tavola 6, legenda).
// Le animazioni sono QUELLE che la mascotte usa già in styles.css (bot-dot,
// bot-wave, bot-hop, bot-breathe, bot-blink): riusate scalate, nessun
// keyframe nuovo. Ogni segno ha aria-label col nome dello stato; il pallino
// di colore resta decorativo. Con prefers-reduced-motion tutto fermo ma i
// segni restano leggibili da fermi (guarda sul CSS, come le altre guardie).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { i18n } from '@lingui/core'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf } from './render-helper'
import { itCatalogEntries } from './po-helper'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Agent, GroupInfo } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => ({} as never))
vi.mock('../components/ui/dropdown-menu', () => ({ DropdownMenu: () => null, DropdownMenuTrigger: () => null, DropdownMenuContent: () => null, DropdownMenuItem: () => null, DropdownMenuSeparator: () => null, DropdownMenuSub: () => null, DropdownMenuSubTrigger: () => null, DropdownMenuSubContent: () => null, DropdownMenuRadioGroup: () => null, DropdownMenuRadioItem: () => null }))

i18n.load('it', itCatalogEntries())
i18n.activate('it')

const { Sidebar } = await import('../components/Sidebar')
const { useStore } = await import('../store')

const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({
  id, name, description: '', providerId: null, model: null, status: 'idle', unread: 0,
  createdAt: Date.now(), createdBy: null, section: null, parentId: null, avatar: null, ...over
})
const group = (id: number, name: string, members: GroupInfo['members'], coordinatorId: string | null, lastMessageAt: number | null = null): GroupInfo => ({
  id, name, description: '', createdBy: 'u', coordinatorId, members, createdAt: 1, lastMessageAt, autonomy: 'box'
})

const layoutFull = { sidebar: 'full' as const, sidebarWidth: 260, panel: 'hidden' as const, panelWidth: 0 }
const layoutRail = { sidebar: 'rail' as const, sidebarWidth: 76, panel: 'hidden' as const, panelWidth: 0 }

/** rende la barra con un bot per ogni stato: lavora (thinking), aspetta te
 *  (paused-for-approval), finito (turnEnd FINISHED appena scorso), fermo */
function renderBar(layout: typeof layoutFull | typeof layoutRail, patch: Record<string, unknown> = {}): ReturnType<typeof parseHtml> {
  setStoreStateForRender(useStore, {
    onboarding: { needed: false, state: null, sequence: ['chat'], modelReady: false, guideOpen: false },
    agents: [
      agent('main', 'Bot'),
      agent('l', 'Lavora', { status: 'thinking' }),
      agent('w', 'Aspetta', { status: 'paused-for-approval' }),
      agent('f', 'Fermo'),
      agent('d', 'Finito')
    ],
    groups: [],
    mainAgentId: 'main', activeId: 'main', openGroupId: null,
    previews: {}, turnEnds: {}, lastSendAt: {}, typingAgentId: null, lastDeltaAt: {},
    nowTick: 0,
    approvalsAll: [], approvalsBotCount: {}, groupPendingCount: {},
    activityOpen: false, openLibraryId: null, approvalsOpen: false,
    subagents: [], activity: {}, windowWidth: 1400,
    ...patch
  })
  return parseHtml(renderHtml(createElement(Sidebar, { layout })))
}

const rowOf = (tree: ReturnType<typeof parseHtml>, name: string) =>
  findAll(tree, (n) => n.tag === 'button' && textOf(n).startsWith(name))[0]

/** classe ESATTA (side-dot non deve catturare side-dots) */
const hasCls = (n: { attrs: Record<string, unknown> }, cls: string): boolean =>
  String(n.attrs.class ?? '').split(/\s+/).includes(cls)

describe('R2: il segno a destra delle righe dei bot — per ogni BotState quello giusto', () => {
  it('lavora → TRE puntini blu che saltellano (bot-dot, ritardi 0/.15/.3)', () => {
    const tree = renderBar(layoutFull, { turnEnds: { d: { value: 'FINISHED', sendAt: Date.now() - 100 } } })
    const row = rowOf(tree, 'Lavora')!
    const dots = findAll(row, (n) => hasCls(n, 'side-dot'))
    expect(dots).toHaveLength(3)
    expect(dots.every((d) => (d.attrs.style ?? '').includes('animation-delay') || d.attrs.style === undefined)).toBe(true)
    const delays = dots.map((d) => String(d.attrs.style ?? ''))
    expect(delays.join(' ')).toContain('.15s')
    expect(delays.join(' ')).toContain('.3s')
  })

  it('aspetta te → pallino arancio con l\'onda che si allarga (bot-wave)', () => {
    const tree = renderBar(layoutFull)
    const row = rowOf(tree, 'Aspetta')!
    expect(findAll(row, (n) => (n.attrs.class ?? '').includes('side-wait-dot')).length).toBe(1)
    expect(findAll(row, (n) => (n.attrs.class ?? '').includes('side-wait-wave')).length).toBe(1)
  })

  it('finito → arco felice verde con UN saltello', () => {
    const tree = renderBar(layoutFull, { turnEnds: { d: { value: 'FINISHED', sendAt: Date.now() - 100 } } })
    const row = rowOf(tree, 'Finito')!
    const done = findAll(row, (n) => (n.attrs.class ?? '').includes('side-done'))
    expect(done).toHaveLength(1)
    expect(String(done[0]!.attrs.class)).not.toContain('infinite')
  })

  it('fermo → NESSUN segno: solo il tempo a destra', () => {
    const tree = renderBar(layoutFull)
    const row = rowOf(tree, 'Fermo')!
    expect(findAll(row, (n) => (n.attrs.class ?? '').includes('side-sign')).length).toBe(0)
    expect(textOf(row)).toMatch(/m$|h$|g$|adesso/)
  })

  it('il membro della squadra ha lo STESSO segno (e il pallino resta decorativo)', () => {
    const tree = renderBar(layoutFull, {
      openGroupId: 1,
      groups: [group(1, 'Weekend', [
        { agentId: 'main', name: 'Bot', coordinator: true },
        { agentId: 'l', name: 'Lavora', coordinator: false }
      ], 'main', Date.now())]
    })
    // la squadra ATTIVA si apre da sola: il membro Lavora si vede rientrato
    const member = rowOf(tree, 'Lavora')!
    expect(findAll(member, (n) => hasCls(n, 'side-dot')).length).toBe(3)
    expect(findAll(member, (n) => n.attrs['data-testid'] === 'bot-dot-color')[0]!.attrs['aria-hidden']).toBe('true')
  })
})

describe('R2: l\'aria-label del segno — il nome dello stato, per chi non lo vede', () => {
  it('ogni segno ha role="img" e aria-label col nome dello stato', () => {
    const tree = renderBar(layoutFull, { turnEnds: { d: { value: 'FINISHED', sendAt: Date.now() - 100 } } })
    const signs = findAll(tree, (n) => (n.attrs.class ?? '').includes('side-sign'))
    const labels = signs.map((s) => String(s.attrs['aria-label'] ?? ''))
    expect(signs.length).toBeGreaterThanOrEqual(3)
    expect(labels).toContain('lavora')
    expect(labels).toContain('aspetta te')
    expect(labels).toContain('finito')
    expect(signs.every((s) => s.attrs.role === 'img')).toBe(true)
  })
})

describe('R2: il robottino della squadra — gli stati della mascotte, scalati', () => {
  const teams = (waiting: boolean, finished: boolean): GroupInfo[] => [
    // il coordinatore LAVORA (thinking): l'aggregato della squadra è «lavora»
    group(1, 'Squadra Lavora', [
      { agentId: 'l', name: 'Lavora', coordinator: true },
      { agentId: 'f', name: 'Fermo', coordinator: false }
    ], 'l', Date.now()),
    group(2, waiting ? 'Squadra Aspetta' : 'Squadra Calma', [
      { agentId: 'w', name: 'Aspetta', coordinator: true },
      { agentId: 'f', name: 'Fermo', coordinator: false }
    ], 'w', Date.now() - 60_000),
    group(3, finished ? 'Squadra Finito' : 'Squadra Vecchia', [
      { agentId: 'd', name: 'Finito', coordinator: true },
      { agentId: 'f', name: 'Fermo', coordinator: false }
    ], 'd', Date.now() - 120_000)
  ]

  it('lavora → il robottino respira (~2 s) e ha i TRE puntini blu in alto a destra', () => {
    const tree = renderBar(layoutFull, { groups: teams(false, false), turnEnds: { d: { value: 'FINISHED', sendAt: Date.now() - 100 } } })
    const robot = findAll(tree, (n) => hasCls(n, 'side-robot--lavora'))
    expect(robot.length).toBeGreaterThanOrEqual(1)
    const dots = findAll(robot[0]!, (n) => hasCls(n, 'side-robot-dot'))
    expect(dots).toHaveLength(3)
  })

  it('aspetta te → occhi più grandi: il Bot va in stato waiting (bot--waiting)', () => {
    const tree = renderBar(layoutFull, { groups: teams(true, false) })
    const wrapper = findAll(tree, (n) => (n.attrs.class ?? '').includes('side-robot--aspetta-te'))[0]
    expect(wrapper).toBeTruthy()
    expect(String(findAll(wrapper!, (n) => (n.attrs.class ?? '').includes('bot--waiting'))[0]?.attrs.class)).toContain('bot--waiting')
  })

  it('finito → il saltello UNA volta sola (classe side-robot--finito sul wrapper)', () => {
    const tree = renderBar(layoutFull, { groups: teams(false, true), turnEnds: { d: { value: 'FINISHED', sendAt: Date.now() - 100 } } })
    expect(findAll(tree, (n) => (n.attrs.class ?? '').includes('side-robot--finito')).length).toBeGreaterThanOrEqual(1)
  })

  it('fermo → respiro lento (side-robot--fermo)', () => {
    const tree = renderBar(layoutFull, { groups: teams(false, false) })
    expect(findAll(tree, (n) => (n.attrs.class ?? '').includes('side-robot--fermo')).length).toBeGreaterThanOrEqual(1)
  })
})

describe('R2: la rotaia — il segno di stato in piccolo sull\'angolo', () => {
  it('le voci della rotaia portano il mini-segno con aria-label', () => {
    const tree = renderBar(layoutRail, { turnEnds: { d: { value: 'FINISHED', sendAt: Date.now() - 100 } } })
    const signs = findAll(tree, (n) => (n.attrs['data-testid'] ?? '') === 'rail-state-sign')
    const labels = signs.map((s) => String(s.attrs['aria-label'] ?? ''))
    expect(labels).toContain('lavora')
    expect(labels).toContain('aspetta te')
    expect(labels).toContain('finito')
  })
})

describe('R2: SOLO keyframes della mascotte — e il movimento ridotto li ferma tutti', () => {
  const CSS = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8')

  it('i segni riusano bot-dot / bot-wave / bot-hop: NESSUN keyframe nuovo', () => {
    expect(CSS).toMatch(/\.side-dot[^}]*animation:\s*bot-dot/)
    expect(CSS).toMatch(/\.side-wait-wave[^}]*animation:\s*bot-wave/)
    expect(CSS).toMatch(/\.side-done[^}]*animation:\s*bot-hop/)
    // il robottino: durate scalate sul RESPIRO della mascotte, nessun keyframe in più
    expect(CSS).toMatch(/\.side-robot--lavora \.bot-svg[^}]*animation-duration:\s*2s/)
    expect(CSS).toMatch(/\.side-robot--fermo \.bot-svg[^}]*animation-duration:\s*4s/)
    expect(CSS).toMatch(/\.side-robot--finito \.bot-svg[^}]*animation-iteration-count:\s*1/)
    expect(CSS).not.toMatch(/@keyframes side-/)
  })

  it('prefers-reduced-motion: le animazioni dei segni si fermano, i segni restano leggibili', () => {
    // dentro il blocco reduce del CSS: .side-dot e .side-done e l'onda ferme
    const reduce = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduce).toMatch(/\.side-dot[^{]*\{[^}]*animation:\s*none/)
    expect(reduce).toMatch(/\.side-done[^{]*\{[^}]*animation:\s*none/)
    expect(reduce).toMatch(/\.side-wait-wave[^{]*\{[^}]*animation:\s*none/)
    // e il robottino della squadra respira FERMO (le .bot* sono già coperte)
    expect(CSS.match(/@media \(prefers-reduced-motion: reduce\)/g)?.length).toBeGreaterThanOrEqual(1)
  })

  it('il segno non usa MAI un timer JS: nessun setInterval/requestAnimationFrame nel cammino della barra', () => {
    const SIDEBAR = readFileSync(fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url)), 'utf8')
    expect(SIDEBAR).not.toContain('setInterval')
    expect(SIDEBAR).not.toContain('requestAnimationFrame')
  })
})
