// Fase design (DS4 — barra di sinistra): la barra ai token di DS1. La spec,
// parola per parola: «righe text-body, metadati text-caption, titoli di
// gruppo text-caption grigi, stesse altezze; la testata di DS3». Qui si
// fissano le scelte con cui quella frase è stata tradotta, sul render VERO
// della barra (larga e rotaia), così non tornano indietro:
//   - l'ANATOMIA della riga: [respiro 8] [slot 32] [12] [nome] [metadati]
//     [azioni]. Lo slot da 32 è ciò che tiene i nomi sulla stessa ascissa
//     davanti a un'icona di 16, alla mascotte di 22 o a un pallino di 8;
//   - l'ALTEZZA la decide la famiglia: 52 con lo slot (h-row), 40 il solo
//     testo (h-row-text). Fissa, senza respiro verticale;
//   - i METADATI a destra: text-caption grigio. NELLE RIGHE IL NOME VINCE
//     SUL TEMPO (dal vivo: «Weeken…» accanto a «adesso» intero): il tempo
//     non si tronca mai, o c'è intero o sparisce — sta in una riga che va a
//     capo e ne mostra una sola. I bottoni in riga («›», «⋯», il «+») restano
//     da 32 come bersaglio ma occupano 16 di layout (-mx-2);
//   - i TITOLI DI GRUPPO: text-caption grigio 500 su una riga da 32 (ci sta
//     il «+», un bottone da 32), 16 sopra e 4 sotto, il testo sul filo delle
//     icone delle righe;
//   - la ROTAIA: le voci fisse in bottoni da 32, il cerchio del bot a 22
//     dentro un bottone da 32, l'account sulla riga di 52 (h-col-head);
//   - in fondo chi sei: riga da 52, nome text-body 500 e modello text-caption
//     grigio, l'iniziale in un cerchio da 24 dentro lo slot da 32;
//   - nessuna misura libera: nel sorgente della barra non c'è una classe con
//     le quadre (la guardia di DS6 non guarda h-[…], size-[…], bottom-[…]:
//     qui sì);
//   - ogni classe scritta esiste nel CSS compilato da Tailwind: un token
//     sbagliato (h-rows) sta nell'HTML e non fa nulla, lo dice solo l'output.
// Quel che il render statico non apre (la ricerca, la rinomina in linea) si
// legge nel sorgente, come le altre guardie del renderer.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { i18n } from '@lingui/core'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, hasAncestor, dialogPassThroughMock, type HtmlNode } from './render-helper'
import { itCatalogEntries } from './po-helper'
import { compileRenderer, deadClasses } from './tailwind-compile'
import { stringsOf } from './design-scan'
import type { Agent, GroupInfo } from '../../../shared/types'

// il dialogo e il menu si rendono PASSANTI: così il trigger del menu account
// sta nell'HTML statico (col `<button>` che Radix crea al suo posto, porta le
// stesse classi del trigger), e il «⋯» di ogni riga si vede
vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
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

const SIDEBAR = fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url))
const SRC = readFileSync(SIDEBAR, 'utf8')
/** Le stringhe del sorgente, lette dall'AST: i commenti NON ci sono (come legge la guardia di DS6). */
const STRINGS = stringsOf(SRC)

const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({
  id, name, description: '', providerId: null, model: null, status: 'idle', unread: 0,
  createdAt: 1, createdBy: null, section: null, parentId: null, avatar: null, ...over
})
const group = (id: number, name: string, members: GroupInfo['members'], coordinatorId: string, lastMessageAt: number | null = null): GroupInfo => ({
  id, name, description: '', createdBy: 'u', coordinatorId, members, createdAt: 1, lastMessageAt, autonomy: 'box'
})

const layoutFull = { sidebar: 'full' as const, sidebarWidth: 264, panel: 'hidden' as const, panelWidth: 0 }
const layoutRail = { sidebar: 'rail' as const, sidebarWidth: 76, panel: 'hidden' as const, panelWidth: 0 }

/**
 * La barra con una squadra che aspetta te (si apre da sola), la squadra
 * attiva con tre membri («Altri 1»), abbastanza bot da far comparire «Mostra
 * tutti (N)», una sezione e un archiviato: c'è ogni tipo di riga.
 */
function renderSidebar(layout: typeof layoutFull | typeof layoutRail, patch: Record<string, unknown> = {}): ReturnType<typeof parseHtml> {
  setStoreStateForRender(useStore, {
    onboarding: { needed: false, state: null, sequence: ['chat'], modelReady: false, guideOpen: false },
    agents: [
      agent('main', 'Bot'),
      agent('b1', 'Ricerche', { status: 'thinking' }),
      agent('b2', 'Competitoor', { status: 'paused-for-approval' }),
      agent('b3', 'Newsletter', { section: 'Editoria' }),
      agent('x1', 'Anna'), agent('x2', 'Bruno'), agent('x3', 'Carlo'),
      ...Array.from({ length: 8 }, (_, i) => agent(`f${i}`, `Extra ${i}`)),
      agent('a1', 'Vecchio Lavori', { archivedAt: 1_000 }),
      agent('d1', 'Andato', { deletedAt: 2_000 })
    ],
    groups: [
      group(1, 'Fatture marzo', [
        { agentId: 'main', name: 'Bot', coordinator: true },
        { agentId: 'b2', name: 'Competitoor', coordinator: false }
      ], 'main', Date.now() - 4 * 60_000),
      group(2, 'Gara Lecco', [
        { agentId: 'b1', name: 'Ricerche', coordinator: true },
        { agentId: 'x1', name: 'Anna', coordinator: false },
        { agentId: 'x2', name: 'Bruno', coordinator: false },
        { agentId: 'x3', name: 'Carlo', coordinator: false }
      ], 'b1', Date.now() - 100_000)
    ],
    mainAgentId: 'main', activeId: 'main', openGroupId: 2,
    previews: {}, turnEnds: {}, lastSendAt: {}, typingAgentId: null, lastDeltaAt: {}, nowTick: 0,
    approvalsAll: [], approvalsBotCount: {}, groupPendingCount: {},
    activityOpen: false, openLibraryId: null, approvalsOpen: false, pluginOpen: false,
    subagents: [], activity: {}, windowWidth: 1400, sidebarArchivedOpen: false, removedUndo: null,
    ...patch
  })
  return parseHtml(renderHtml(createElement(Sidebar, { layout })))
}

/** Le classi di un nodo, come token. */
const cls = (n: HtmlNode): string[] => (n.attrs.class ?? '').split(/\s+/).filter(Boolean)
const has = (n: HtmlNode, c: string): boolean => cls(n).includes(c)
const byText = (tree: ReturnType<typeof parseHtml>, text: string): HtmlNode[] =>
  findAll(tree, (n) => n.tag === 'button' && textOf(n) === text)
/** Il primo bottone il cui testo comincia così. */
const rowOf = (tree: ReturnType<typeof parseHtml>, text: string): HtmlNode =>
  findAll(tree, (n) => n.tag === 'button' && textOf(n).startsWith(text))[0]!
const svgIn = (n: HtmlNode): HtmlNode => findAll(n, (s) => s.tag === 'svg')[0]!

describe('DS4 barra: le righe — anatomia, altezze, testo', () => {
  const FIXED = ['Nuovo', 'Da approvare', 'Plugin', 'Attività', 'Libreria']

  it('le voci fisse: alte 52 e FISSE (nessun respiro verticale), lo slot da 32 con l’icona di 16, il nome a 12 dallo slot, text-body, raggio dei controlli', () => {
    const tree = renderSidebar(layoutFull)
    for (const name of FIXED) {
      const rows = byText(tree, name)
      expect(rows.length, `la voce «${name}»`).toBe(1)
      const row = rows[0]!
      expect(has(row, 'h-row'), `${name}: h-row`).toBe(true)
      // l'altezza è la riga, non padding + testo: niente py-, pt-, pb-, min-h-
      expect(cls(row).filter((c) => /^(min-h|py|pt|pb)-/.test(c)), `${name}: respiro verticale`).toEqual([])
      for (const c of ['rounded-control', 'px-2', 'gap-row-gap', 'text-body']) expect(has(row, c), `${name}: ${c}`).toBe(true)
      // lo slot: 32 per 32, che non si restringe; dentro l'icona di 16
      const slot = row.children[0]!
      expect(has(slot, 'size-8'), `${name}: lo slot`).toBe(true)
      expect(has(slot, 'shrink-0'), `${name}: lo slot non si restringe`).toBe(true)
      expect(has(svgIn(slot), 'size-4'), `${name}: l'icona`).toBe(true)
      // il nome: cede lui, e tronca
      const label = row.children[1]!
      expect(textOf(label)).toBe(name)
      expect(has(label, 'min-w-0') && has(label, 'flex-1') && has(label, 'truncate'), `${name}: il nome tronca`).toBe(true)
    }
  })

  it('il principale: la mascotte (22) sta nello slot da 32; il nome text-body 500; «la tua chat» è un metadato', () => {
    const tree = renderSidebar(layoutFull)
    const row = findAll(tree, (n) => n.tag === 'button' && textOf(n).includes('la tua chat'))[0]!
    expect(has(row, 'h-row')).toBe(true)
    const slot = row.children[0]!
    expect(has(slot, 'size-8')).toBe(true)
    expect(findAll(slot, (n) => (n.attrs.class ?? '').includes('bot-svg'))[0]!.attrs.width).toBe('22')
    const name = findAll(row, (n) => n.tag === 'span' && n.children.length === 0 && textOf(n) === 'Bot')[0]!
    expect(has(name, 'font-medium'), 'il nome del principale pesa come un titolo di riga (500)').toBe(true)
    expect(has(name, 'font-semibold')).toBe(false)
    const meta = findAll(row, (n) => n.tag === 'span' && n.children.length === 0 && textOf(n) === 'la tua chat')[0]!
    for (const c of ['text-caption', 'text-muted-foreground', 'shrink-0']) expect(has(meta, c), `«la tua chat»: ${c}`).toBe(true)
  })

  it('bot, membri e squadre hanno la STESSA riga: 52, il segno nello slot da 32, il nome a 12 dallo slot, text-body', () => {
    const tree = renderSidebar(layoutFull)
    // i bot e i membri: il pallino del colore sta nello slot
    const dots = findAll(tree, (n) => n.attrs['data-testid'] === 'bot-dot-color')
    // Competitoor (membro), Anna, Bruno (membri), Extra 0…3 (i bot fuori squadra che si vedono), Newsletter
    expect(dots.length).toBeGreaterThanOrEqual(7)
    for (const dot of dots) {
      const slot = dot.parent!
      expect(has(slot, 'size-8')).toBe(true)
      const body = slot.parent!
      expect(body.tag, 'il corpo della riga è il bottone del nome').toBe('button')
      for (const c of ['gap-row-gap', 'text-body', 'min-w-0', 'flex-1']) expect(has(body, c), c).toBe(true)
      const names = findAll(body, (n) => n.tag === 'span' && n.children.length === 0 && has(n, 'truncate'))
      expect(names.length, 'il nome tronca').toBeGreaterThan(0)
      const shell = body.parent!
      expect(has(shell, 'h-row'), 'la riga è alta 52').toBe(true)
      expect(has(shell, 'rounded-control'), 'il fondo della riga ha il raggio dei controlli').toBe(true)
      expect(cls(shell).filter((c) => /^(min-h|py|pt|pb)-/.test(c))).toEqual([])
    }
    // la squadra: il robottino di 16 nello stesso slot, nella stessa riga
    // (il nome esatto: side-robot, non side-robot-dots né side-robot-dot)
    for (const robot of findAll(tree, (n) => has(n, 'side-robot'))) {
      const slot = robot.parent!
      expect(has(slot, 'size-8')).toBe(true)
      expect(has(slot.parent!.parent!, 'h-row')).toBe(true)
    }
  })

  it('i nomi di tutte le righe sono text-body: niente più 13,5 scritti a mano', () => {
    const tree = renderSidebar(layoutFull)
    // (Ricerche coordina «Gara Lecco»: la sua riga è quella della squadra)
    const names = ['Competitoor', 'Fatture marzo', 'Gara Lecco', 'Newsletter', 'Extra 0', 'Anna']
    for (const name of names) {
      const row = rowOf(tree, name)
      const body = row.tag === 'button' && has(row, 'gap-row-gap') ? row : row.children[0]!
      expect(has(body, 'text-body'), `${name}: il corpo della riga`).toBe(true)
    }
  })
})

describe('DS4 barra: i metadati a destra', () => {
  it('tempo e conteggi: text-caption; il tempo non si restringe mai (o c’è intero o non c’è: cede lui prima del nome)', () => {
    const tree = renderSidebar(layoutFull)
    // i tempi: «4m» della squadra, quelli dei bot fermi
    // le foglie: il contenitore dei metadati di una squadra riunisce conteggio e tempo, e il suo testo non è un tempo
    const times = findAll(tree, (n) => n.tag === 'span' && n.children.length === 0 && /^(adesso|mai|\d+[mhg])$/.test(textOf(n)))
    expect(times.length).toBeGreaterThanOrEqual(3)
    for (const t of times) {
      expect(has(t, 'text-caption'), `«${textOf(t)}»: la misura`).toBe(true)
      expect(has(t, 'shrink-0'), `«${textOf(t)}»: non si restringe`).toBe(true)
      expect(has(t, 'text-muted-foreground'), `«${textOf(t)}»: grigio`).toBe(true)
    }
  })

  it('il segno di stato non si restringe e non porta testo (il nome accessibile resta il suo)', () => {
    const tree = renderSidebar(layoutFull)
    // Competitoor aspetta te: a destra il segno, non il tempo
    const row = rowOf(tree, 'Competitoor')
    expect(textOf(row)).toBe('Competitoor')
    const signs = findAll(row, (n) => has(n, 'side-sign'))
    expect(signs.length).toBe(1)
    expect(has(signs[0]!, 'shrink-0')).toBe(true)
    expect(signs[0]!.attrs.role).toBe('img')
    expect(signs[0]!.attrs['aria-label']).toBe('aspetta te')
  })
})

/** Le foglie col testo di un tempo («4m», «adesso», «mai»…): non il contenitore, che riunisce tempo e nome. */
const timeLeaves = (tree: ReturnType<typeof parseHtml>): HtmlNode[] =>
  findAll(tree, (n) => n.tag === 'span' && n.children.length === 0 && /^(adesso|mai|\d+[mhg])$/.test(textOf(n)))
/** Le frecce che aprono e chiudono i membri di una squadra. */
const chevronsOf = (tree: ReturnType<typeof parseHtml>): HtmlNode[] =>
  findAll(tree, (n) => n.tag === 'button' && /^((Apri|Chiudi) i membri di )/.test(n.attrs['aria-label'] ?? ''))

describe('DS4 barra: nelle righe il NOME vince sul tempo (visto dal vivo: «Weeken…» accanto a «adesso» intero)', () => {
  /*
   * I CONTI, sulla riga di squadra in una barra da 264 px (quella di default):
   *   248 dentro l'elenco (px-2), 232 dentro la riga (px-2), 44 per lo slot
   *   da 32 e i 12 che lo separano dal nome, 52 per «›» e «⋯» (due caselle da
   *   16, 16 in mezzo, 4 dal nome). Alla riga del nome restano 136 px.
   * «Weekend Torino» a 14 px ne misura circa 103: ci sta intero. «adesso»
   * (circa 40, più 8 di respiro) no: sparisce, e torna sopra i 279 px di
   * barra. A 220 px (il minimo) ne restano 92: tronca il nome — ma il tempo
   * se n'è già andato. Prima i due bottoni occupavano 72 px e il tempo era
   * fisso: al nome restavano 64, e usciva «Weeken…».
   */
  it('il tempo non si tronca mai: o c’è intero o sparisce — sta in una riga che VA A CAPO e ne mostra una sola', () => {
    const tree = renderSidebar(layoutFull)
    const times = timeLeaves(tree)
    expect(times.length).toBeGreaterThanOrEqual(3)
    for (const t of times) {
      expect(has(t, 'shrink-0'), `«${textOf(t)}» non si restringe`).toBe(true)
      expect(has(t, 'truncate'), `«${textOf(t)}» non si tronca: un tempo a metà («ad…») non si legge`).toBe(false)
      const line = t.parent!
      // ciò che non ci sta accanto al nome passa alla riga sotto…
      expect(has(line, 'flex-wrap'), 'la riga del nome va a capo').toBe(true)
      // …e la riga sotto non si vede: la riga è alta UNA riga di text-body (20) e taglia
      expect(has(line, 'overflow-hidden'), 'la riga del nome taglia').toBe(true)
      expect(has(line, 'h-5'), 'alta una riga di text-body').toBe(true)
      for (const c of ['min-w-0', 'flex-1', 'items-center']) expect(has(line, c), `la riga del nome: ${c}`).toBe(true)
      // sta nel bottone del nome, dentro la riga da 52: è parte del clic
      expect(line.parent!.tag, 'la riga del nome sta nel bottone del nome').toBe('button')
      expect(has(line.parent!.parent!, 'h-row')).toBe(true)
    }
  })

  it('davanti al tempo c’è ciò che deve restare — il nome, e il conteggio che gli sta attaccato — misurato a larghezza PIENA quando si decide se il tempo ci sta', () => {
    const tree = renderSidebar(layoutFull)
    for (const t of timeLeaves(tree)) {
      const line = t.parent!
      expect(line.children.length, 'nella riga del nome: ciò che resta, poi il tempo').toBeGreaterThanOrEqual(2)
      const head = line.children[0]!
      // flex-auto, non flex-1: la base è il CONTENUTO, non zero. Con base zero
      // la riga crederebbe di avere tutto lo spazio libero, il tempo ci
      // «starebbe» sempre, e a cedere sarebbe il nome
      expect(has(head, 'flex-auto'), 'la base di ciò che resta è la sua larghezza vera').toBe(true)
      expect(has(head, 'min-w-0'), '…ma può stringersi: tronca').toBe(true)
      const name = head.children[0]!
      expect(has(name, 'min-w-0') && has(name, 'flex-1') && has(name, 'truncate'), 'il nome è ciò che tronca').toBe(true)
      expect(/^(adesso|mai|\d+[mhg])$/.test(textOf(name)), 'prima viene il nome, non il tempo').toBe(false)
      // il tempo è l'ULTIMO della riga: è lui a passare sotto
      expect(line.children[line.children.length - 1] === t, 'il tempo è l’ultimo').toBe(true)
    }
  })

  it('il conteggio di chi aspetta («1») sta con il nome, non col tempo: sparisce il tempo, non lui', () => {
    const tree = renderSidebar(layoutFull)
    const count = findAll(tree, (n) => n.tag === 'span' && n.children.length === 0 && textOf(n) === '1' && n.attrs['aria-label'] === '1 ti aspettano')[0]!
    const head = count.parent!
    expect(has(head, 'flex-auto'), 'il conteggio sta in ciò che resta').toBe(true)
    const line = head.parent!
    expect(timeLeaves(line).length, 'e il tempo è nella riga, dopo').toBe(1)
  })

  it('il segno di stato non sparisce mai: sta FUORI dalla riga che va a capo', () => {
    const tree = renderSidebar(layoutFull)
    // Competitoor aspetta te: il suo segno è un segnale, non un metadato
    const row = rowOf(tree, 'Competitoor')
    const sign = findAll(row, (n) => has(n, 'side-sign'))[0]!
    expect(hasAncestor(sign, (a) => has(a, 'flex-wrap'))).toBe(false)
    expect(has(sign, 'shrink-0')).toBe(true)
  })

  it('i bottoni dentro le righe («›», «⋯») e il «+» dei titoli: bersaglio da 32, 16 di layout (-mx-2: 8 in meno per lato)', () => {
    const tree = renderSidebar(layoutFull)
    const mores = findAll(tree, (n) => n.attrs['data-testid'] === 'row-more')
    const chevrons = chevronsOf(tree)
    expect(mores.length).toBeGreaterThan(2)
    expect(chevrons.length).toBe(2)
    const teamTitle = findAll(tree, (n) => n.tag === 'p' && textOf(n) === 'Team')[0]!
    const plus = findAll(teamTitle.parent!, (n) => n.tag === 'button')[0]!
    for (const b of [...mores, ...chevrons, plus]) {
      expect(has(b, 'size-control-sm'), 'il bersaglio resta 32 per 32').toBe(true)
      expect(has(b, '-mx-2'), 'ma nella riga occupa 16: 8 px in meno per lato').toBe(true)
      expect(has(svgIn(b), 'size-4')).toBe(true)
    }
    // la testata di DS3 non si tocca: le sue icone restano com'erano, senza margini
    const head = findAll(tree, (n) => n.attrs['data-col-head'] === 'barra')[0]!
    for (const b of findAll(head, (n) => n.tag === 'button')) expect(has(b, '-mx-2'), 'le icone della testata').toBe(false)
  })

  it('i due bottoni vicini della squadra («›» e «⋯») NON si sovrappongono: stanno in una casella con 16 px in mezzo — i cerchi tangenti, tutti e due cliccabili per interi', () => {
    const tree = renderSidebar(layoutFull)
    // con -mx-2 su tutti e due e i 4 px fra un bottone e l'altro, due bersagli
    // da 32 si coprirebbero per 12 px: la «›» resterebbe cliccabile per 20
    const moresOf = (actions: HtmlNode): HtmlNode[] => findAll(actions, (n) => n.attrs['data-testid'] === 'row-more')
    for (const chevron of chevronsOf(tree)) {
      const actions = chevron.parent!
      for (const c of ['flex', 'shrink-0', 'items-center', 'gap-4']) expect(has(actions, c), `la casella delle azioni: ${c}`).toBe(true)
      expect(moresOf(actions).length, 'il «⋯» della stessa riga').toBe(1)
      expect(has(actions.parent!, 'h-row'), 'la casella sta nella riga da 52').toBe(true)
    }
    // le righe col solo «⋯» (bot e membri) hanno la stessa casella
    for (const m of findAll(tree, (n) => n.attrs['data-testid'] === 'row-more')) {
      expect(hasAncestor(m, (a) => has(a, 'gap-4') && has(a, 'shrink-0') && has(a, 'items-center')), 'il «⋯» sta nella casella delle azioni').toBe(true)
    }
  })

  it('ciò che i bottoni disegnano fuori dalla loro casella non è tagliato: né l’elenco, né la riga, né la casella delle azioni nascondono il loro sfondo', () => {
    const tree = renderSidebar(layoutFull)
    const nav = findAll(tree, (n) => n.tag === 'nav')[0]!
    expect(has(nav, 'overflow-hidden'), 'l’elenco scorre in verticale e non taglia in orizzontale').toBe(false)
    const clipped = findAll(tree, (n) => has(n, 'overflow-hidden') && !has(n, 'h-5'))
    // l'unica cosa che taglia è la riga del nome (alta una riga): tutto il resto no
    expect(clipped.map((n) => n.attrs.class ?? '')).toEqual([])
  })
})

describe('DS4 barra: i titoli di gruppo', () => {
  it('«Team», «Bot» e le sezioni: text-caption grigio 500 su una riga da 32, 16 sopra e 4 sotto', () => {
    const tree = renderSidebar(layoutFull)
    for (const title of ['Team', 'Bot', 'Editoria']) {
      const p = findAll(tree, (n) => n.tag === 'p' && textOf(n) === title)[0]!
      for (const c of ['text-caption', 'font-medium', 'text-muted-foreground']) expect(has(p, c), `${title}: ${c}`).toBe(true)
      const head = p.parent!
      // la riga è 32 anche senza l'azione: ci sta il «+» (un bottone da 32), e
      // così ogni titolo sta alla stessa distanza dalle righe
      expect(has(head, 'h-control-sm'), `${title}: la riga del titolo`).toBe(true)
      expect(has(head, 'mt-block'), `${title}: 16 sopra`).toBe(true)
      expect(has(head, 'mb-1'), `${title}: 4 sotto`).toBe(true)
      // in orizzontale il testo comincia dove cominciano le ICONE delle righe (pl-4: 16 dentro l'elenco)
      expect(has(head, 'pl-4'), `${title}: sul filo delle icone`).toBe(true)
    }
  })

  it('l’azione della squadra (il «+») è un bottone tondo da 32 con l’icona di 16', () => {
    const tree = renderSidebar(layoutFull)
    const p = findAll(tree, (n) => n.tag === 'p' && textOf(n) === 'Team')[0]!
    const plus = findAll(p.parent!, (n) => n.tag === 'button')[0]!
    expect(plus.attrs['aria-label']).toBe('Crea')
    for (const c of ['size-control-sm', 'rounded-full', 'shrink-0']) expect(has(plus, c), c).toBe(true)
    expect(has(svgIn(plus), 'size-4')).toBe(true)
  })

  it('«Archiviati» in fondo è un titolo di gruppo anche lui (caption grigio 500, riga da 32, con la freccia di 16)', () => {
    const tree = renderSidebar(layoutFull)
    const toggle = findAll(tree, (n) => n.attrs['data-testid'] === 'archived-section')[0]!
    for (const c of ['h-control-sm', 'text-caption', 'font-medium', 'text-muted-foreground']) expect(has(toggle, c), c).toBe(true)
    expect(has(svgIn(toggle), 'size-4')).toBe(true)
    expect(has(toggle, 'pl-4'), 'la freccia sul filo delle icone, come il testo di «Team»').toBe(true)
    expect(has(toggle.parent!, 'mt-block')).toBe(true)
  })

  it('le righe di «Archiviati» aperto: 40, col «Ripristina» che è un bottone da 32', () => {
    const tree = renderSidebar(layoutFull, { sidebarArchivedOpen: true })
    const restores = findAll(tree, (n) => n.attrs['data-testid']?.startsWith('archived-restore-'))
    expect(restores).toHaveLength(2)
    for (const r of restores) {
      expect(has(r, 'h-control-sm'), 'Ripristina').toBe(true)
      expect(has(r, 'rounded-control')).toBe(true)
      expect(has(r, 'text-body')).toBe(true)
      expect(has(r.parent!, 'h-row-text'), 'la riga dell’archiviato è di solo testo').toBe(true)
      // il nome dell'archiviato comincia dove comincia il testo di «Archiviati»: 8 (elenco) + 32 (rientro) + 8 (respiro) = 48
      expect(has(r.parent!.parent!, 'pl-8'), 'le righe rientrate sotto il testo del titolo').toBe(true)
    }
  })
})

describe('DS4 barra: le righe di solo testo e le azioni in riga', () => {
  it('«Mostra tutti (N)» e «Altri N»: alte 40, col testo dove partono i nomi (lo slot c’è, vuoto)', () => {
    const tree = renderSidebar(layoutFull)
    const mostra = findAll(tree, (n) => n.tag === 'button' && /^Mostra tutti \(\d+\)$/.test(textOf(n)))[0]!
    expect(has(mostra, 'h-row-text')).toBe(true)
    expect(has(mostra, 'text-body')).toBe(true)
    expect(has(mostra, 'size-8'), 'una riga di solo testo non ha lo slot da 32: è alta 40').toBe(false)
    const slot = mostra.children[0]!
    expect(has(slot, 'size-8') && slot.children.length === 0, 'lo slot vuoto: il testo parte a 52 dal bordo, come i nomi').toBe(true)
    expect(has(mostra.children[1]!, 'truncate')).toBe(true)
    const altri = findAll(tree, (n) => n.tag === 'button' && textOf(n) === 'Altri 1')[0]!
    expect(has(altri, 'h-row-text')).toBe(true)
    expect(altri.children[0]!.children).toHaveLength(0)
  })

  it('la freccia della squadra e il «⋯»: bottoni tondi da 32 (le icone di 16), come i controlli di DS1', () => {
    const tree = renderSidebar(layoutFull)
    const mores = findAll(tree, (n) => n.attrs['data-testid'] === 'row-more')
    expect(mores.length).toBeGreaterThan(0)
    for (const m of mores) {
      for (const c of ['size-control-sm', 'rounded-full']) expect(has(m, c), `row-more: ${c}`).toBe(true)
      expect(has(svgIn(m), 'size-4')).toBe(true)
    }
    // la freccia apre/chiude i membri: entrambe le squadre sono aperte, quindi «Chiudi i membri di …»
    const chevrons = findAll(tree, (n) => n.tag === 'button' && (n.attrs['aria-label'] ?? '').startsWith('Chiudi i membri di'))
    expect(chevrons.map((c) => c.attrs['aria-label'])).toEqual(['Chiudi i membri di Fatture marzo', 'Chiudi i membri di Gara Lecco'])
    for (const c of chevrons) {
      expect(has(c, 'size-control-sm'), 'la freccia').toBe(true)
      expect(has(c, 'rounded-full')).toBe(true)
      expect(has(svgIn(c), 'size-4')).toBe(true)
    }
  })

  it('l’avviso «Eliminato · Annulla»: una riga da 36 col bottone da 32, a 80 px dal fondo (64 del blocco dell’account in larga + 16: non lo copre, in larga e in rotaia)', () => {
    const undo = { kind: 'bot', id: 'd1', name: 'Andato', expiresAt: Date.now() + 10_000 }
    for (const layout of [layoutFull, layoutRail]) {
      const tree = renderSidebar(layout, { removedUndo: undo })
      const pill = findAll(tree, (n) => n.attrs['data-testid'] === 'removed-undo')[0]!
      expect(has(pill, 'h-control'), 'l’avviso').toBe(true)
      // 80 = 64 + 16: la scala delle spaziature finisce a 16, e 20 non c'è
      expect(has(pill, 'bottom-16') && has(pill, 'mb-4'), 'sopra il blocco in fondo: 64 + 16').toBe(true)
      expect(cls(pill).filter((c) => /^bottom-\d/.test(c)), 'nessun altro offset dal fondo').toEqual(['bottom-16'])
      const annulla = findAll(pill, (n) => n.tag === 'button')[0]!
      expect(textOf(annulla)).toBe('Annulla')
      expect(has(annulla, 'h-control-sm')).toBe(true)
    }
  })

  it('in rotaia l’avviso non sta nella barra (76 px: non ci starebbe il solo «Annulla»): è largo come la ricerca sospesa; in larga va da un margine all’altro', () => {
    const undo = { kind: 'bot', id: 'd1', name: 'Andato', expiresAt: Date.now() + 10_000 }
    const pillOf = (layout: typeof layoutFull | typeof layoutRail) => findAll(renderSidebar(layout, { removedUndo: undo }), (n) => n.attrs['data-testid'] === 'removed-undo')[0]!
    expect(has(pillOf(layoutFull), 'right-2'), 'in larga: da un margine all’altro').toBe(true)
    const rail = pillOf(layoutRail)
    expect(has(rail, 'w-60'), 'in rotaia: 240, come la ricerca sospesa').toBe(true)
    expect(has(rail, 'right-2'), 'in rotaia non si chiude sul margine destro').toBe(false)
    // la ricerca sospesa della rotaia: la stessa larghezza
    expect(SRC).toContain('<div className="absolute left-2 top-16 z-30 w-60">')
  })
})

describe('DS4 barra: in fondo chi sei', () => {
  /**
   * Il bottone del menu account e la riga in cui sta. Il `<button>` lo crea
   * Radix: col menu passante dei test al suo posto c'è il div del trigger, che
   * porta le STESSE classi (sono quelle che Radix mette sul bottone). Col
   * menu passante il trigger sta dentro il div del menu: la riga è il nonno.
   */
  const accountButton = (tree: ReturnType<typeof parseHtml>): { button: HtmlNode; row: HtmlNode } => {
    const button = findAll(tree, (n) => n.attrs['data-testid'] === 'account-menu-trigger')[0]!
    return { button, row: button.parent!.parent! }
  }

  it('larga: sulla riga di 52 della testata (h-col-head); nome text-body 500, modello text-caption grigio, l’iniziale in un cerchio da 24', () => {
    const { button, row } = accountButton(renderSidebar(layoutFull))
    expect(has(row, 'h-col-head')).toBe(true)
    expect(has(button, 'rounded-control'), 'la riga si evidenzia col raggio dei controlli').toBe(true)
    expect(cls(button).filter((c) => /^(py|pt|pb)-/.test(c)), 'l’altezza è della riga, non del respiro').toEqual([])
    // l'iniziale del cerchio, il nome, il modello: come oggi (l'iniziale è sempre stata dentro il bottone)
    expect(textOf(button)).toBe('BBotnessun modello')
    const avatar = findAll(button, (n) => has(n, 'rounded-full'))[0]!
    expect(has(avatar, 'size-6')).toBe(true)
    expect(has(avatar, 'text-caption')).toBe(true)
    const lines = findAll(button, (n) => n.tag === 'span' && has(n, 'truncate'))
    expect(lines.map((l) => textOf(l))).toEqual(['Bot', 'nessun modello'])
    expect(has(lines[0]!, 'font-medium')).toBe(true)
    for (const c of ['text-caption', 'text-muted-foreground']) expect(has(lines[1]!, c), `il modello: ${c}`).toBe(true)
  })

  it('rotaia: la riga dell’account è alta 52 come la testata (prima 60), e il bottone è da 32', () => {
    const { button, row } = accountButton(renderSidebar(layoutRail))
    expect(has(row, 'h-col-head')).toBe(true)
    for (const c of ['size-control-sm', 'rounded-full']) expect(has(button, c), c).toBe(true)
    expect(textOf(button)).toBe('B')
  })
})

describe('DS4 barra: la rotaia', () => {
  it('le voci fisse sono icone di 16 in bottoni da 32', () => {
    const tree = renderSidebar(layoutRail)
    const labels = ['Crea', 'Plugin', 'Attività', 'Libreria', 'Cerca']
    const voices = findAll(tree, (n) => n.tag === 'button' && (labels.includes(n.attrs['aria-label'] ?? '') || n.attrs['data-testid'] === 'rail-approvals'))
    expect(voices.map((v) => v.attrs['aria-label'])).toEqual(['Crea', 'Da approvare', 'Plugin', 'Attività', 'Libreria', 'Cerca'])
    for (const v of voices) {
      for (const c of ['size-control-sm', 'rounded-full', 'shrink-0']) expect(has(v, c), `${v.attrs['aria-label']}: ${c}`).toBe(true)
      expect(has(svgIn(v), 'size-4'), `${v.attrs['aria-label']}: l'icona`).toBe(true)
    }
  })

  it('il cerchio del bot resta di 22 (con la lettera a text-caption) dentro un bottone da 32: stessa zona di clic per ogni voce', () => {
    const tree = renderSidebar(layoutRail)
    const circles = findAll(tree, (n) => n.attrs['data-testid'] === 'rail-bot-circle')
    // il principale, Competitoor (in squadra), Anna, Bruno, Carlo, Extra 0…3, Newsletter
    expect(circles.length).toBeGreaterThanOrEqual(9)
    for (const circle of circles) {
      expect(circle.attrs['data-size'], 'il diametro, per le sonde').toBe('22')
      expect(has(circle, 'text-caption')).toBe(true)
      expect((circle.attrs.style ?? '').includes('22'), 'il diametro è scritto nello stile, non in una classe libera').toBe(true)
      expect(has(circle, 'font-semibold')).toBe(true)
      const button = circle.parent!.parent!
      expect(button.tag).toBe('button')
      for (const c of ['size-control-sm', 'rounded-full']) expect(has(button, c), c).toBe(true)
    }
  })
})

describe('DS4 barra: quel che il render statico non apre si legge nel sorgente', () => {
  it('il campo di ricerca (larga e sospesa in rotaia): h-control, rounded-control, text-body, px-3', () => {
    const fields = [...SRC.matchAll(/<input[\s\S]{0,500}?placeholder=\{t`Cerca bot e team`\}[\s\S]{0,120}?className="([^"]*)"/g)]
    expect(fields.length, 'due campi: la barra larga e quello sospeso della rotaia').toBe(2)
    for (const m of fields) {
      for (const c of ['h-control', 'rounded-control', 'text-body', 'px-3']) expect(m[1]!.split(/\s+/), 'il campo di ricerca').toContain(c)
      expect(m[1]).not.toMatch(/\bpy-/)
    }
  })

  it('la rinomina in linea è un campo da 32 che si vede anche sulla riga attiva (fondo card e bordo, non fondo muted come la riga)', () => {
    expect(SRC).toContain('className="no-drag h-control-sm min-w-0 flex-1 rounded-control border border-input bg-card px-2 text-body outline-none"')
  })

  it('nessuna misura libera nel sorgente della barra: nessuna classe con le quadre', () => {
    // la guardia di DS6 non guarda le altezze, le misure e gli offset tra quadre
    // (solo le larghezze in px e le spaziature): qui non ne resta nessuna
    expect(STRINGS.flatMap((s) => /[\w-]+-\[[^\]]*\]/g.exec(s) ?? [])).toEqual([])
  })

  it('le testate di DS3 non sono state toccate: la riga dei 52 resta com’era, col bottone della barra a 12 px dai semafori', () => {
    expect(SRC).toContain('data-col-head="barra" className="drag-region flex h-col-head shrink-0 items-center gap-2 px-3" style={{ paddingLeft: SIDEBAR_HEAD_PAD }}')
    expect(SRC).toContain('data-col-head="barra" className="drag-region h-col-head shrink-0" aria-hidden="true"')
    expect(SRC).toContain('data-testid="sidebar-toggle"')
    // l’anello del fuoco solo da tastiera: mai la variante focus: (focus-visible: no)
    expect(STRINGS.filter((s) => /(^|\s)focus:/.test(s)), 'mai focus:').toEqual([])
  })
})

describe('DS4 barra: le classi scritte esistono', () => {
  it('nel CSS compilato da Tailwind ogni classe del render della barra (larga e rotaia) ha la sua regola', async () => {
    // non sono utility: le classi del CSS a mano (la mascotte, i segni di stato) e quelle che lucide mette sulle sue icone;
    // `group` è un marcatore (non ha una regola sua)
    const custom = /^(?:bot(?:$|-)|hm-|side-|rail-sign$|scroll-thin$|drag-region$|no-drag$|lucide(?:$|-)|group$|space-y-px$)/
    const classes = new Set<string>()
    for (const layout of [layoutFull, layoutRail]) {
      for (const n of findAll(renderSidebar(layout, { removedUndo: { kind: 'bot', id: 'd1', name: 'Andato', expiresAt: Date.now() + 10_000 }, sidebarArchivedOpen: true }), () => true)) {
        for (const c of cls(n)) if (!custom.test(c)) classes.add(c)
      }
    }
    expect(classes.size).toBeGreaterThan(40)
    const css = await compileRenderer([...classes, 'space-y-px'])
    expect(deadClasses(css, classes)).toEqual([])
    // space-y-px (l'1 px fra le righe dell'elenco) c'è, ma il suo selettore
    // compilato comincia con :where( — deadClasses non lo trova, lo si cerca da sé
    expect(css).toMatch(/:where\(\.space-y-px > :not\(:last-child\)\)\s*\{[^}]*margin/)
  })
})
