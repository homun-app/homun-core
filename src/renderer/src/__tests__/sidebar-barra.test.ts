// R1+R2 (fase barra-sobria): la barra laterale per molti progetti — tavola 6.
// Test PURI del modello (ordine, taglio a 4, aggregato squadra, aperture,
// tempi) e test di RENDER della barra larga e della rotaia. La tavola:
// testo e pochi segni; niente anteprima sotto il nome (va nel suggerimento);
// il robottino 16 px solo per le squadre, il pallino per i bot e i membri;
// si aprono da sole solo la squadra attiva o quella che aspetta te.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { i18n } from '@lingui/core'
import {
  buildSidebarModel, orderRows, cutRows, memberCut, teamAutoOpens, teamOpenState,
  timeAgoShort, rowStateOf, teamRowState, collapsedVoices, type SidebarTeam
} from '../sidebar-utils'
import type { BotState } from '../bot/bot-state'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, accessibleName } from './render-helper'
import { itCatalogEntries } from './po-helper'
import type { Agent, GroupInfo } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => ({} as never))
vi.mock('../components/ui/dropdown-menu', () => ({ DropdownMenu: () => null, DropdownMenuTrigger: () => null, DropdownMenuContent: () => null, DropdownMenuItem: () => null, DropdownMenuSeparator: () => null, DropdownMenuSub: () => null, DropdownMenuSubTrigger: () => null, DropdownMenuSubContent: () => null, DropdownMenuRadioGroup: () => null, DropdownMenuRadioItem: () => null }))

i18n.load('it', itCatalogEntries())
i18n.activate('it')

const { Sidebar } = await import('../components/Sidebar')
const { useStore } = await import('../store')

const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({
  id, name, description: '', providerId: null, model: null, status: 'idle', unread: 0,
  createdAt: 1, createdBy: null, section: null, parentId: null, avatar: null, ...over
})
const group = (id: number, name: string, members: GroupInfo['members'] = [], coordinatorId: string | null = null, lastMessageAt: number | null = null): GroupInfo => ({
  id, name, description: '', createdBy: 'u', coordinatorId, members, createdAt: 1, lastMessageAt, autonomy: 'box'
})
const resolve = (d: { id: string }): string => i18n.t(d as never)

// ---- R1: il modello puro ----

describe('R1: rowStateOf — gli stati presi dalla mascotte', () => {
  it('thinking/speaking/listening → lavora; waiting → aspetta te; happy → finito; idle → fermo', () => {
    expect(rowStateOf('thinking')).toBe('lavora')
    expect(rowStateOf('speaking')).toBe('lavora')
    expect(rowStateOf('listening')).toBe('lavora')
    expect(rowStateOf('waiting')).toBe('aspetta-te')
    expect(rowStateOf('happy')).toBe('finito')
    expect(rowStateOf('idle')).toBe('fermo')
  })
  it('un figlio fermo su una card segna aspetta te anche a stato fermo (AH2)', () => {
    expect(rowStateOf('idle', true)).toBe('aspetta-te')
    expect(rowStateOf('idle', false)).toBe('fermo')
  })
})

describe('R1: teamRowState — lo stato aggregato della squadra', () => {
  it('aspetta te vince su tutto; poi lavora; poi finito; altrimenti fermo', () => {
    expect(teamRowState(['idle', 'waiting', 'thinking'])).toBe('aspetta-te')
    expect(teamRowState(['idle', 'thinking', 'happy'])).toBe('lavora')
    expect(teamRowState(['idle', 'happy'])).toBe('finito')
    expect(teamRowState(['idle', 'idle'])).toBe('fermo')
    expect(teamRowState([])).toBe('fermo')
  })
})

describe('R1: buildSidebarModel con stati e tempi (le righe col pallino)', () => {
  const agents = [agent('m', 'Main'), agent('w', 'Aspetta', { status: 'paused-for-approval' }), agent('z', 'Zitto')]
  const opts = { states: { m: 'idle', w: 'waiting', z: 'idle' } as Record<string, BotState>, lastSendAt: { w: 500, z: 900 } }
  it('i bot singoli portano waiting, state e lastAt (lastSendAt, o createdAt)', () => {
    const mdl = buildSidebarModel(agents, [], 'm', '', new Set(), opts)
    const w = mdl.bots.find((b) => b.agent.id === 'w')!
    const z = mdl.bots.find((b) => b.agent.id === 'z')!
    expect(w.waiting).toBe(true)
    expect(w.state).toBe('waiting')
    expect(w.lastAt).toBe(500)
    expect(z.lastAt).toBe(900)
  })
  it('senza opzioni niente esplode: state idle e lastAt dal createdAt', () => {
    const mdl = buildSidebarModel(agents, [], 'm')
    expect(mdl.bots.find((b) => b.agent.id === 'z')!.lastAt).toBe(1)
    expect(mdl.bots.find((b) => b.agent.id === 'z')!.state).toBe('idle')
  })
  it('la squadra porta lo stato aggregato (coordinatore + membri)', () => {
    const team = [agent('c', 'Capo'), agent('w', 'Aspetta', { status: 'paused-for-approval' }), agent('l', 'Lavora')]
    const groups = [group(1, 'Weekend', [
      { agentId: 'c', name: 'Capo', coordinator: true },
      { agentId: 'w', name: 'Aspetta', coordinator: false },
      { agentId: 'l', name: 'Lavora', coordinator: false }
    ], 'c', 10)]
    const mdl = buildSidebarModel(team, groups, 'c', '', new Set(), { states: { c: 'idle', w: 'waiting', l: 'thinking' } })
    expect(mdl.teams[0]!.state).toBe('aspetta-te')
  })
})

describe('R1: l\'ordine dentro ogni sezione — prima chi aspetta te, poi ultima attività', () => {
  it('le righe in attesa salgono; le altre per lastAt decrescente (null in fondo)', () => {
    const rows = [
      { id: 'a', waiting: false, works: false, lastAt: 100 },
      { id: 'b', waiting: true, works: false, lastAt: 5 },
      { id: 'c', waiting: false, works: false, lastAt: 300 },
      { id: 'd', waiting: false, works: false, lastAt: null },
      { id: 'e', waiting: true, works: false, lastAt: 900 }
    ]
    // tra due in attesa vince l'ultima attività: e (900) prima di b (5)
    expect(orderRows(rows).map((r) => r.id)).toEqual(['e', 'b', 'c', 'a', 'd'])
  })
})

// ---- M4 (fase beta12-correzioni): chi lavora ADESSO conta come attività ----

describe('M4: chi lavora adesso sta subito dopo chi aspetta te', () => {
  it('un bot che lavora (thinking/speaking/listening) con attività VECCHIA sta sopra un bot fermo più recente', () => {
    const rows = [
      { id: 'recente', waiting: false, works: false, lastAt: 900 },
      { id: 'lavora', waiting: false, works: true, lastAt: 5 }
    ]
    expect(orderRows(rows).map((r) => r.id)).toEqual(['lavora', 'recente'])
  })

  it('chi aspetta te resta PRIMA di chi lavora; tra chi lavora vince l\'ultima attività', () => {
    const rows = [
      { id: 'lavora-vecchio', waiting: false, works: true, lastAt: 5 },
      { id: 'aspetta', waiting: true, works: false, lastAt: 1 },
      { id: 'lavora-nuovo', waiting: false, works: true, lastAt: 800 }
    ]
    expect(orderRows(rows).map((r) => r.id)).toEqual(['aspetta', 'lavora-nuovo', 'lavora-vecchio'])
  })

  it('buildSidebarModel: il bot in thinking con lastSendAt vecchio viene per primo tra i singoli', () => {
    const agents = [agent('m', 'Main'), agent('ricerche', 'Ricerche'), agent('chiacchiere', 'Chiacchiere')]
    const mdl = buildSidebarModel(agents, [], 'm', '', new Set(), {
      states: { m: 'idle', ricerche: 'thinking', chiacchiere: 'idle' },
      lastSendAt: { ricerche: 5, chiacchiere: 900 }
    })
    expect(orderRows(mdl.bots).map((b) => b.agent.id)).toEqual(['ricerche', 'chiacchiere'])
    // e la riga dichiara works per la barra
    expect(mdl.bots.find((b) => b.agent.id === 'ricerche')!.works).toBe(true)
  })

  it('la ROTAIA segue lo stesso ordine per i bot (il robottino che lavora prima di quello fermo recente)', () => {
    const agents = [agent('m', 'Main'), agent('ricerche', 'Ricerche'), agent('chiacchiere', 'Chiacchiere')]
    const mdl = buildSidebarModel(agents, [], 'm', '', new Set(), {
      states: { m: 'idle', ricerche: 'thinking', chiacchiere: 'idle' },
      lastSendAt: { ricerche: 5, chiacchiere: 900 }
    })
    const botVoices = collapsedVoices(mdl).filter((v) => v.kind === 'bot')
    expect(botVoices.map((v) => v.name)).toEqual(['Ricerche', 'Chiacchiere'])
  })
})

describe('R1: il taglio a 4 con «Mostra tutti (N)»', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i), waiting: false, lastAt: i }))
  it('più di 4 righe: se ne vedono 4, hidden dice quante mancano', () => {
    const cut = cutRows(mk(14), false)
    expect(cut.visible).toHaveLength(4)
    expect(cut.hidden).toBe(10)
  })
  it('espanso si vedono tutte; 4 o meno non si taglia niente', () => {
    expect(cutRows(mk(14), true).visible).toHaveLength(14)
    expect(cutRows(mk(3), false).hidden).toBe(0)
    expect(cutRows(mk(4), false).hidden).toBe(0)
  })
})

describe('R1: i membri della squadra — al massimo 2 più «Altri N»', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }))
  it('3 membri: 2 visibili, 1 nascosto; espanso tutti', () => {
    expect(memberCut(mk(3), false).visible).toHaveLength(2)
    expect(memberCut(mk(3), false).hidden).toBe(1)
    expect(memberCut(mk(3), true).visible).toHaveLength(3)
  })
  it('2 o meno: niente da espandere', () => {
    expect(memberCut(mk(2), false).hidden).toBe(0)
  })
})

describe('R1: quali squadre si aprono da sole', () => {
  const t = (waiting: boolean, id: number): SidebarTeam => ({ group: group(id, 'X'), coordinator: null, members: [], waiting, waitingCount: 0, lastAt: 0, state: 'fermo' })
  it('solo quella attiva o quella che aspetta te; le altre chiuse', () => {
    expect(teamAutoOpens(t(true, 1), 99)).toBe(true)
    expect(teamAutoOpens(t(false, 2), 2)).toBe(true)
    expect(teamAutoOpens(t(false, 3), 2)).toBe(false)
  })
  it('teamOpenState: di default CHIUSA salvo auto; l\'utente comanda (\'1\' aperta, \'0\' chiusa)', () => {
    expect(teamOpenState(null, true)).toBe(true)
    expect(teamOpenState(null, false)).toBe(false)
    expect(teamOpenState('1', false)).toBe(true)
    expect(teamOpenState('0', true)).toBe(false)
  })
})

describe('R1: timeAgoShort — «4m», «1g», come nella tavola', () => {
  const now = 1_000_000_000_000
  it('adesso, minuti, ore, giorni', () => {
    expect(resolve(timeAgoShort(now - 10_000, now))).toBe('adesso')
    expect(resolve(timeAgoShort(now - 4 * 60_000, now))).toBe('4m')
    expect(resolve(timeAgoShort(now - 59 * 60_000, now))).toBe('59m')
    expect(resolve(timeAgoShort(now - 2 * 3_600_000, now))).toBe('2h')
    expect(resolve(timeAgoShort(now - 26 * 3_600_000, now))).toBe('1g')
    expect(resolve(timeAgoShort(now - 40 * 86_400_000, now))).toBe('40g')
  })
  it('null → mai (bot mai usato)', () => {
    expect(resolve(timeAgoShort(null, now))).toBe('mai')
  })
})

// ---- R1: il render della barra LARGA ----

const layoutFull = { sidebar: 'full' as const, sidebarWidth: 260, panel: 'hidden' as const, panelWidth: 0 }
const layoutRail = { sidebar: 'rail' as const, sidebarWidth: 76, panel: 'hidden' as const, panelWidth: 0 }

function renderSidebar(layout: typeof layoutFull | typeof layoutRail, patch: Record<string, unknown> = {}): ReturnType<typeof parseHtml> {
  const fourMinAgo = Date.now() - 4 * 60_000
  setStoreStateForRender(useStore, {
    onboarding: { needed: false, state: null, sequence: ['chat'], modelReady: false, guideOpen: false },
    agents: [
      agent('main', 'Bot'),
      agent('b1', 'Ricerche', { status: 'thinking', section: null }),
      agent('b2', 'Competitoor', { status: 'paused-for-approval' }),
      agent('b3', 'Newsletter', { section: 'Editoria' }),
      agent('b4', 'Analisi prezzi', { section: 'Editoria' })
    ],
    groups: [
      group(1, 'Fatture marzo', [
        { agentId: 'main', name: 'Bot', coordinator: true },
        { agentId: 'b2', name: 'Competitoor', coordinator: false }
      ], 'main', fourMinAgo)
    ],
    mainAgentId: 'main', activeId: 'main', openGroupId: null,
    previews: { main: 'Ciao come va', b1: 'Sto cercando…' },
    turnEnds: {}, lastSendAt: { b1: Date.now() - 60_000 }, typingAgentId: null, lastDeltaAt: {}, nowTick: 0,
    approvalsAll: [], approvalsBotCount: {}, groupPendingCount: {},
    activityOpen: false, openLibraryId: null, approvalsOpen: false,
    subagents: [], activity: {}, windowWidth: 1400,
    ...patch
  })
  return parseHtml(renderHtml(createElement(Sidebar, { layout })))
}

const mascots = (tree: ReturnType<typeof parseHtml>) =>
  findAll(tree, (n) => n.attrs['data-testid'] === 'bot-mascot' || (n.attrs.class ?? '').includes('bot-svg'))

describe('R1 render: la barra larga — righe sobrie, niente anteprima, suggerimenti', () => {
  it('in alto, fisse, in quest\'ordine: Nuovo, Bot (la tua chat), Da approvare, Attività, Libreria', () => {
    const tree = renderSidebar(layoutFull)
    const texts = findAll(tree, (n) => n.tag === 'button').map((b) => textOf(b))
    const idx = (t: string): number => texts.findIndex((x) => x.includes(t))
    expect(idx('Nuovo')).toBeGreaterThanOrEqual(0)
    expect(idx('Da approvare')).toBeGreaterThan(idx('Nuovo'))
    expect(idx('Attività')).toBeGreaterThan(idx('Da approvare'))
    expect(idx('Libreria')).toBeGreaterThan(idx('Attività'))
    // la riga del principale: mascotte 20 px e «la tua chat» a destra
    const main = texts.find((t) => t.includes('Bot') && t.includes('la tua chat'))
    expect(main).toBeTruthy()
  })

  it('NESSUNA mascotte nelle righe dei bot e dei membri: solo il principale (20) e i robottini delle squadre (20)', () => {
    const tree = renderSidebar(layoutFull)
    const bots = mascots(tree)
    // il principale + il robottino dell\'unica squadra — R3 (b20-ritocchi):
    // nella barra larga avatar e robottini a 20, l'altezza della riga è 36
    expect(bots.length).toBe(2)
    const sizes = bots.map((b) => b.attrs.width ?? b.attrs['data-size'])
    expect(sizes).toEqual(['20', '20'])
  })

  it('niente anteprima sotto il nome: il testo della riga è SOLO il nome; l\'anteprima sta nel title', () => {
    const tree = renderSidebar(layoutFull)
    const row = findAll(tree, (n) => n.tag === 'button' && textOf(n) === 'Ricerche')[0]
    expect(row).toBeTruthy()
    expect(textOf(row)).not.toContain('Sto cercando…')
    expect(String(row.attrs.title ?? '')).toContain('Sto cercando…')
  })

  it('bot e membri col PALLINO del colore (aria-hidden), non la mascotte', () => {
    const tree = renderSidebar(layoutFull)
    const row = findAll(tree, (n) => n.tag === 'button' && textOf(n) === 'Ricerche')[0]!
    const dot = findAll(row, (n) => (n.attrs['data-testid'] ?? '') === 'bot-dot-color')[0]
    expect(dot).toBeTruthy()
    expect(dot!.attrs['aria-hidden']).toBe('true')
  })

  it('la squadra: robottino 16, nome, tempo a destra («4m»); il conteggio arancio solo se aspetta te', () => {
    const tree = renderSidebar(layoutFull, { agents: [
      agent('main', 'Bot'),
      agent('b1', 'Ricerche', { status: 'thinking', section: null }),
      agent('b2', 'Competitoor'),
      agent('b3', 'Newsletter', { section: 'Editoria' }),
      agent('b4', 'Analisi prezzi', { section: 'Editoria' })
    ] })
    // squadra SENZA nessuno in attesa: nome + tempo, e NIENTE numero
    const teamRow = findAll(tree, (n) => n.tag === 'button' && textOf(n).includes('Fatture marzo'))[0]
    expect(teamRow).toBeTruthy()
    expect(textOf(teamRow!)).toBe('Fatture marzo4m')
    // con un membro in pausa il numero arancio compare a destra, prima del tempo
    const tree2 = renderSidebar(layoutFull)
    const teamRow2 = findAll(tree2, (n) => n.tag === 'button' && textOf(n).includes('Fatture marzo'))[0]!
    expect(textOf(teamRow2)).toBe('Fatture marzo14m')
  })

  it('«Mostra tutti (N)» quando le righe della sezione superano 4', () => {
    const extra = Array.from({ length: 8 }, (_, i) => agent(`x${i}`, `Extra ${i}`))
    const tree = renderSidebar(layoutFull, { agents: [
      agent('main', 'Bot'), agent('b1', 'Ricerche'), ...extra
    ] })
    const mostra = findAll(tree, (n) => n.tag === 'button' && textOf(n).includes('Mostra tutti (9)'))[0]
    expect(mostra).toBeTruthy()
    // e senza espansione le righe di bot visibili sono 4 (b1 + i primi 3 Extra;
    // il tempo a destra dei bot fermi fa parte del testo della riga)
    const botRows = findAll(tree, (n) => n.tag === 'button' && /^Extra \d/.test(textOf(n)))
    expect(botRows).toHaveLength(3)
  })

  it('la squadra che aspetta te si apre DA SOLA (i membri si vedono); le altre restano chiuse', () => {
    const closed = group(2, 'Gara Lecco', [
      { agentId: 'b1', name: 'Ricerche', coordinator: true },
      { agentId: 'b3', name: 'Newsletter', coordinator: false }
    ], 'b1', Date.now() - 100_000)
    const tree = renderSidebar(layoutFull, { groups: [
      group(1, 'Fatture marzo', [
        { agentId: 'main', name: 'Bot', coordinator: true },
        { agentId: 'b2', name: 'Competitoor', coordinator: false }
      ], 'main', Date.now() - 4 * 60_000),
      closed
    ] })
    // Fatture marzo aspetta te (Competitoor in pausa): Competitoon si vede rientrato
    expect(findAll(tree, (n) => n.tag === 'button' && textOf(n) === 'Competitoor').length).toBeGreaterThan(0)
    // Gara Lecco è chiusa: Newsletter no
    expect(findAll(tree, (n) => n.tag === 'button' && textOf(n) === 'Newsletter').length).toBe(0)
  })

  it('il tempo dell\'ultima attività per il bot fermo, a destra', () => {
    const tree = renderSidebar(layoutFull)
    const row = findAll(tree, (n) => n.tag === 'button' && textOf(n) === 'Ricerche')[0]!
    // b1 sta pensando (thinking): a destra il SEGNO, non il tempo — il tempo
    // arriva con R2; qui chiediamo che NON ci sia l\'anteprima di prima
    expect(textOf(row)).not.toContain('Sta')
  })
})

describe('R1 render: la rotaia — icone fisse, robottini e cerchi con l\'iniziale', () => {
  it('le voci fisse come icone; i bot come cerchio 22 px col colore e l\'iniziale; squadre col robottino 16', () => {
    const tree = renderSidebar(layoutRail)
    // il cerchio con l'iniziale del bot (Ricerche → R)
    const circle = findAll(tree, (n) => (n.attrs['data-testid'] ?? '') === 'rail-bot-circle' && textOf(n) === 'R')[0]
    expect(circle).toBeTruthy()
    expect(String(circle.attrs['data-size'] ?? circle.attrs.style ?? '')).toContain('22')
    // il robottino della squadra a 16 px
    const robots = mascots(tree)
    expect(robots.some((r) => r.attrs.width === '16' || r.attrs['data-size'] === '16')).toBe(true)
  })

  it('i suggerimenti col nome (aria-label «Nome, …» sulle voci della rotaia)', () => {
    const tree = renderSidebar(layoutRail)
    const ricerche = findAll(tree, (n) => (accessibleName(n) ?? '').includes('Ricerche'))
    expect(ricerche.length).toBeGreaterThan(0)
  })
})
