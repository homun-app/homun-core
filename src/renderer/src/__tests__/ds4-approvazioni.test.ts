// Fase design (DS4): «Da approvare» con il suo «Registro», la coda «Da
// approvare» della squadra, «Attività» e il riquadro «+N altrove» delle chat
// PASSANO AL SISTEMA: il guscio di DS2 (PageShell: il corpo che scorre è largo
// quanto l'area, il contenuto centrato alla larghezza scelta), la testata
// (PageHeader, la riga dei 52), le schede (UnderlineTabs), le sezioni
// (Section), le righe (FlatList / FlatRow), la tabella (DataTable), i bottoni
// (Button) e l'avviso (Notice).
//
// Le misure vive le fa la sonda di misura (DS6) sull'app vera; qui le pagine
// si rendono in node (render-helper) e si controlla ciò che da fuori non si
// vede: che la pagina sia fatta coi PEZZI e non con classi scritte a mano, che
// i testid e i nomi accessibili delle sonde delle altre fasi (centro, squadra,
// uso-permessi, design) ci siano TUTTI e dove le sonde li cercano, che le
// azioni in testata siano no-drag, e che ogni classe scritta in questi file
// generi davvero la sua regola nel CSS compilato (una classe sbagliata tace:
// lo dice solo l'output).
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll, hasAncestor, type HtmlNode } from './render-helper'
import { callsOf } from './render-helper-install'
import { isClassList, stringsOf } from './design-scan'
import { compileRenderer, deadClasses } from './tailwind-compile'
import type { ApprovalsCenterRow, GlobalActivityData } from '../../../shared/types'

// il menu «Altre scelte ▾» si rende PASSANTE (come approvals-center.test.ts):
// così trigger e voci si vedono nell'HTML statico
vi.mock('../components/ui/dialog', () => ({}) as never)
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

// le props degli elementi resi, catturate dal runtime JSX: è così che si
// invoca il VERO handler di un bottone (l'HTML statico non lo porta)
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

const { ApprovalsCenter } = await import('../components/ApprovalsCenter')
const { ApprovalsQueue } = await import('../components/ApprovalsQueue')
const { ApprovalsBannerElsewhere } = await import('../components/ApprovalsBanner')
const { ActivityPanel } = await import('../components/ActivityPanel')
const { useStore } = await import('../store')

// ---- come si guarda l'albero ----

const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter((c) => c !== '')
const has = (node: HtmlNode, cls: string): boolean => classes(node).includes(cls)
const all = (root: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode[] => findAll(root, pred)
const first = (root: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode => all(root, pred)[0]!
const byTestid = (root: HtmlNode, id: string): HtmlNode => first(root, (n) => n.attrs['data-testid'] === id)
const withTestid = (root: HtmlNode, id: string): HtmlNode[] => all(root, (n) => n.attrs['data-testid'] === id)
/** Il nodo PIÙ INTERNO il cui testo è esattamente questo (non il contenitore che ha lo stesso testo). */
const ofText = (root: HtmlNode, text: string): HtmlNode => all(root, (n) => textOf(n) === text).at(-1)!
/** Il nodo porta TUTTE queste classi; se mancano, il messaggio dice quali e dove. */
function expectHasAll(node: HtmlNode, list: string[]): void {
  const missing = list.filter((c) => !has(node, c))
  expect(missing, `a <${node.tag} class="${node.attrs.class ?? ''}"> mancano:`).toEqual([])
}
const isContent = (n: HtmlNode): boolean => 'data-page-content' in n.attrs
const isColHead = (n: HtmlNode): boolean => 'data-col-head' in n.attrs
const slot = (root: HtmlNode, name: string): HtmlNode => first(root, (n) => n.attrs['data-page-shell'] === name)
const testidsOf = (root: HtmlNode): string[] => all(root, (n) => n.attrs['data-testid'] !== undefined).map((n) => n.attrs['data-testid']!)

/**
 * Il VERO handler del bottone reso che soddisfa `pred`. L'n-esimo <button>
 * dell'HTML è l'n-esimo elemento nativo che il runtime JSX ha creato: li crea
 * nello stesso ordine in cui finiscono nel documento (lo controlla la
 * lunghezza: se fossero diversi, il test si ferma qui).
 */
function nativeOf(root: HtmlNode, pred: (n: HtmlNode) => boolean): Record<string, unknown> {
  const buttons = all(root, (n) => n.tag === 'button')
  const i = buttons.findIndex(pred)
  expect(i, 'il bottone cercato').toBeGreaterThan(-1)
  const nativi = capture.els.filter((e) => e.type === 'button')
  expect(nativi, 'i <button> resi sono quelli dell\'HTML, nello stesso ordine').toHaveLength(buttons.length)
  return nativi[i]!.props
}

beforeEach(() => { capture.els.length = 0 })

// ---- il guscio: lo stesso contratto per tutte le pagine a tutta area ----

/** Il guscio di DS2: radice inchiodata all'area, il corpo che scorre suo figlio diretto, DENTRO una colonna sola alla larghezza scelta. */
function expectGuscio(root: HtmlNode, testid: string, width: 'page' | 'wide'): void {
  const page = byTestid(root, testid)
  expect(page.attrs['data-page-shell']).toBe('root')
  expectHasAll(page, ['no-drag', 'absolute', 'inset-0', 'z-20', 'bg-background'])
  const scroller = slot(root, 'scroll')
  expect(scroller.parent).toBe(page)
  expectHasAll(scroller, ['min-h-0', 'flex-1', 'overflow-y-auto'])
  // UNA colonna per scorrimento, dentro il corpo (non annidate): larga al più quanto la larghezza scelta
  const colonne = all(scroller, isContent)
  expect(colonne).toHaveLength(1)
  expectHasAll(colonne[0]!, ['mx-auto', 'w-full'])
  expect(colonne[0]!.attrs.style).toBe(`max-width:var(--w-${width})`)
}

/** La testata di DS2: la riga dei 52 con il bottone indietro e il suo nome accessibile; OGNI suo bottone è no-drag e alto 32. */
function expectTestata(root: HtmlNode, back: { testid?: string; label: string }): { head: HtmlNode; back: HtmlNode } {
  const head = first(root, isColHead)
  expectHasAll(head, ['drag-region', 'h-col-head', 'shrink-0'])
  expect(hasAncestor(head, (n) => n.attrs['data-page-shell'] === 'header')).toBe(true)
  const back_ = first(head, (n) => n.tag === 'button' && n.attrs['aria-label'] === back.label)
  expect(back_.attrs['data-testid']).toBe(back.testid)
  expectHasAll(back_, ['no-drag', 'size-control-sm', 'rounded-full'])
  expect(has(back_.children[0]!, 'size-4')).toBe(true)
  for (const b of all(head, (n) => n.tag === 'button')) {
    expectHasAll(b, ['no-drag'])
    expect(has(b, 'size-control-sm') || has(b, 'h-control-sm'), `il bottone «${textOf(b) || b.attrs['aria-label']}» della testata è alto 32`).toBe(true)
  }
  return { head, back: back_ }
}

// ==================== «Da approvare» ====================

const row = (over: Partial<ApprovalsCenterRow> = {}): ApprovalsCenterRow => ({
  agentId: 'a-turismo', agentName: 'Turismo', parentId: null, parentName: null, fromSubagent: false,
  botId: 'a-turismo', botName: 'Turismo', squad: { id: 1, name: 'Weekend Torino' },
  approvalId: 'ap-1', entryId: 1, tool: 'fill_credential', phrase: 'Compilare il modulo del Museo Egizio con nome ed email.',
  category: 'dati-tuoi', why: 'fisso', when: Date.now() - 120_000, isDraft: false, preview: null,
  ...over
})

const RIGHE = (): ApprovalsCenterRow[] => [
  row(),
  row({ agentId: 'a-alloggio', botId: 'a-alloggio', botName: 'Alloggio', fromSubagent: true, parentId: 'a-capo', parentName: 'Capo', agentName: 'Figlio', approvalId: 'ap-2', tool: 'browser_click', phrase: 'Cliccare «Verifica disponibilità».', category: 'sito-interattivo', why: 'revisore', when: Date.now() - 240_000, preview: { url: 'https://booking.example' } }),
  row({ agentId: 'a-solleciti', agentName: 'Solleciti', botId: 'a-solleciti', botName: 'Solleciti', squad: { id: 2, name: 'Fatture marzo' }, approvalId: 'ap-3', tool: 'draft_external', phrase: 'Mandare il sollecito a Rossi Srl.', category: 'invio', why: null, when: Date.now() - 720_000, isDraft: true, preview: { to: 'amministrazione@rossi.example', subject: 'Fattura 214' } }),
  row({ agentId: 'a-ricerche', agentName: 'Ricerche', botId: 'a-ricerche', botName: 'Ricerche', squad: null, approvalId: 'ap-4', tool: 'fill_credential', phrase: 'Accedere a LinkedIn.', category: 'dati-tuoi', why: null, when: Date.now() - 3_600_000 })
]

/** Le 9, 10, 11 e 12 di OGGI: il registro non dipende dall'ora in cui gira il test. */
const oraDiOggi = (h: number): number => new Date(new Date().setHours(h, 0, 0, 0)).getTime()
const logRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'decision', key: 'ap-1', approvalId: 'ap-1', agentId: 'a-solleciti', botName: 'Solleciti',
  phrase: 'Mandare il sollecito a Rossi Srl.', tool: 'draft_external', decision: 'allow', mode: 'always',
  via: 'chat', allowedBy: null, at: oraDiOggi(9), legacy: false, ...over
})
const REGISTRO = (): Array<Record<string, unknown>> => [
  logRow(),
  logRow({ key: 'ap-2', approvalId: 'ap-2', agentId: 'a-archivio', botName: 'Archivio', phrase: 'Cliccare «Verifica».', decision: 'deny', mode: 'once', via: 'center', at: oraDiOggi(10) }),
  logRow({ key: 'ap-3', approvalId: 'ap-3', agentId: 'a-turismo', botName: 'Turismo', phrase: 'Compilare il modulo.', decision: 'expired', mode: null, via: 'expired', at: oraDiOggi(11) }),
  logRow({ kind: 'auto', key: 'auto-write-file', approvalId: null, agentId: 'a-ricerche', botName: 'Ricerche', phrase: 'write-file', tool: 'write-file', decision: 'auto', mode: null, via: null, allowedBy: 'grant 12', at: oraDiOggi(12) }),
  logRow({ key: 'ap-vecchia', approvalId: 'ap-vecchia', agentId: 'a-vecchio', botName: 'Vecchio', phrase: 'Clic vecchio.', decision: null, mode: null, via: null, legacy: true, at: 1_000 })
]
const grant = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 7, tool: 'run-command', target: 'git status', createdAt: Date.now() - 86_400_000, scope: null, expiresAt: null, agentId: null, ...over
})
const concessioni = (): Array<Record<string, unknown>> => [grant(), grant({ id: 8, tool: 'mcp__notion__*', target: '*', scope: 'readOnly', agentId: 'a-bot' })]
const agente = (id: string, name: string): Record<string, unknown> => ({ id, name, description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 })

function renderCenter(patch: Record<string, unknown> = {}, registroInitial?: { log?: unknown[]; grants?: unknown[] }): HtmlNode {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    approvalsAll: [] as ApprovalsCenterRow[], approvalsSnoozed: {}, approvalsOpen: true, approvalsFocusId: null, approvalsView: 'richieste',
    approvalsBannerCollapsed: false, agents: [], entries: [], activeId: 'a-turismo', groups: [], openGroupId: null,
    activityOpen: false, openLibraryId: null, approvalsQueueOpen: false, ...patch
  })
  return parseHtml(renderHtml(createElement(ApprovalsCenter, registroInitial ? ({ registroInitial } as never) : undefined)))
}
/** Il Registro con le sue decisioni e le sue concessioni. */
const renderRegistro = (grants: unknown[] = concessioni()): HtmlNode =>
  renderCenter({ approvalsView: 'registro', agents: [agente('a-bot', 'Alloggio')] }, { log: REGISTRO(), grants })

describe('DS4: «Da approvare» — il guscio e la testata', () => {
  it('è il guscio di DS2: radice approvals-center, il corpo che scorre largo quanto l\'area e DENTRO una colonna sola, larga al più quanto l\'unica larghezza degli elenchi (wide, 1120: C2)', () => {
    const root = renderCenter({ approvalsAll: RIGHE() })
    expectGuscio(root, 'approvals-center', 'wide')
    // la radice resta dentro la regione «Da approvare» (il nome accessibile di oggi)
    const regione = byTestid(root, 'approvals-center').parent!
    expect(regione.tag).toBe('section')
    expect(regione.attrs['aria-label']).toBe('Da approvare')
  })

  it('la testata: indietro «Chiudi» (approvals-center-close), l\'icona di 20, il titolo di pagina, la descrizione sotto la riga, a destra l\'azione «Registro di oggi»', () => {
    const root = renderCenter({ approvalsAll: RIGHE() })
    const { head } = expectTestata(root, { testid: 'approvals-center-close', label: 'Chiudi' })
    const h1 = first(head, (n) => n.tag === 'h1')
    expectHasAll(h1, ['font-display', 'font-semibold', 'text-page'])
    expect(textOf(h1)).toBe('Da approvare')
    // l'icona è 20 px, e la misura è scritta
    const icona = first(head, (n) => n.tag === 'svg' && (n.attrs.class ?? '').includes('lucide-shield-check'))
    expect(has(icona, 'size-5')).toBe(true)
    // l'azione a destra: secondaria, da 32, no-drag (sta nella fascia), col testid che le sonde cercano
    const azione = byTestid(head, 'approvals-open-registro')
    expect(textOf(azione)).toBe('Registro di oggi')
    expectHasAll(azione, ['bg-muted', 'no-drag', 'h-control-sm'])
    // C2: NIENTE descrizione sotto il titolo (ListPage) — la barra sta a y=52 come ogni pagina
    expect(findAll(slot(root, 'header'), (n) => textOf(n).includes('4 richieste da 4 bot'))).toHaveLength(0)
  })

  it('indietro chiude il centro; l\'azione «Registro di oggi» porta al Registro senza chiuderlo', () => {
    const root = renderCenter({ approvalsAll: RIGHE() })
    ;(nativeOf(root, (n) => n.attrs['data-testid'] === 'approvals-center-close').onClick as () => void)()
    expect(useStore.getState().approvalsOpen).toBe(false)
    const root2 = renderCenter({ approvalsAll: RIGHE() })
    ;(nativeOf(root2, (n) => n.attrs['data-testid'] === 'approvals-open-registro').onClick as () => void)()
    expect(useStore.getState().approvalsView).toBe('registro')
    expect(useStore.getState().approvalsOpen).toBe(true)
  })

  it('le schede «Richieste | Registro» nel toolbar: una tablist sola (approvals-center-tabs), su una riga sola, ogni scheda col suo testid, l\'attiva selezionata; la riga si estende per tutto il contenuto', () => {
    const root = renderCenter({ approvalsAll: RIGHE() })
    const toolbar = slot(root, 'toolbar')
    const list = byTestid(toolbar, 'approvals-center-tabs')
    expect(list.attrs.role).toBe('tablist')
    expectHasAll(list, ['flex-nowrap', 'overflow-x-auto'])
    const tabs = all(list, (n) => n.attrs.role === 'tab')
    expect(tabs.map((t) => t.attrs['data-testid'])).toEqual(['approvals-tab-richieste', 'approvals-tab-registro'])
    expect(tabs.map((t) => textOf(t))).toEqual(['Richieste', 'Registro'])
    expect(tabs.map((t) => t.attrs['aria-selected'])).toEqual(['true', 'false'])
    expectHasAll(tabs[0]!, ['shrink-0', 'whitespace-nowrap', 'text-body'])
    // l'involucro delle schede riempie la riga: il filetto di base va da un bordo all'altro del contenuto
    expectHasAll(list.parent!, ['flex-1', 'min-w-0', 'border-b'])
  })

  it('il clic sulla scheda «Registro» cambia la vista; nella vista Registro il guscio è largo wide (1120), senza azione né descrizione', () => {
    const root = renderCenter({ approvalsAll: RIGHE() })
    ;(nativeOf(root, (n) => n.attrs.role === 'tab' && n.attrs['data-testid'] === 'approvals-tab-registro').onClick as () => void)()
    expect(useStore.getState().approvalsView).toBe('registro')
    const registro = renderRegistro()
    expectGuscio(registro, 'approvals-center', 'wide')
    expect(withTestid(registro, 'approvals-open-registro')).toHaveLength(0)
    expect(all(slot(registro, 'header'), isContent)).toHaveLength(1)
    expect(all(registro, (n) => n.attrs.role === 'tab').map((t) => t.attrs['aria-selected'])).toEqual(['false', 'true'])
  })
})

describe('DS4: «Da approvare» — filtri, gruppi e card coi pezzi del sistema', () => {
  it('i filtri per tipo sono pillole (Button): l\'attiva in primo piano, le altre col fondo tenue, tutte della STESSA forma, in text-caption; aria-pressed resta', () => {
    const root = renderCenter({ approvalsAll: RIGHE() })
    const gruppo = first(root, (n) => n.attrs.role === 'group' && n.attrs['aria-label'] === 'Filtra per tipo')
    const pills = all(gruppo, (n) => n.tag === 'button')
    expect(pills.map((p) => textOf(p))).toEqual(['Tutte · 4', 'I tuoi dati · 2', 'Invii · 1', 'Siti · 1'])
    for (const [i, p] of pills.entries()) {
      expectHasAll(p, ['rounded-full', 'h-control-sm', 'text-caption', 'font-medium'])
      expect(p.attrs['aria-pressed']).toBe(i === 0 ? 'true' : 'false')
      if (i === 0) expectHasAll(p, ['bg-foreground'])
      else { expectHasAll(p, ['bg-muted']); expect(has(p, 'bg-foreground')).toBe(false) }
    }
  })

  it('i gruppi sono Section: titolo text-caption grigio col contatore «team · N» / «bot · N»; «Apri il team» è un bottone ghost da 32, solo per le squadre', () => {
    const root = renderCenter({ approvalsAll: RIGHE() })
    const gruppi = withTestid(root, 'approvals-center-group')
    // l'ordine è quello del modello (groupApprovalsRows): le squadre dalla più urgente, poi i bot
    expect(gruppi.map((g) => g.attrs['aria-label'])).toEqual(['Fatture marzo', 'Weekend Torino', 'Ricerche'])
    const titoli = gruppi.map((g) => first(g, (n) => n.tag === 'h2'))
    for (const h of titoli) expectHasAll(h, ['text-caption', 'font-medium', 'text-muted-foreground'])
    expect(titoli.map((h) => textOf(h))).toEqual(['Fatture marzo team · 1', 'Weekend Torino team · 2', 'Ricerche bot · 1'])
    for (const g of gruppi) expectHasAll(first(g, (n) => n.tag === 'section'), ['flex', 'flex-col', 'gap-section-head'])
    const apri = first(gruppi[0]!, (n) => n.tag === 'button')
    expect(textOf(apri)).toBe('Apri il team')
    expectHasAll(apri, ['h-control-sm', 'text-muted-foreground', 'rounded-control'])
    expect(has(first(apri, (n) => n.tag === 'svg'), 'size-4')).toBe(true)
    // il gruppo di un bot non ha l'azione: sulla riga del titolo c'è solo il titolo
    expect(first(gruppi[2]!, (n) => n.tag === 'h2').parent!.children).toHaveLength(1)
    // «Apri il team» apre la squadra e chiude il centro
    ;(nativeOf(root, (n) => n.tag === 'button' && textOf(n) === 'Apri il team').onClick as () => void)()
    expect(useStore.getState().approvalsOpen).toBe(false)
  })

  it('la card di una richiesta: una scheda (rounded-surface, bordo, p-4), il titolo text-body medium, le azioni sono Button — Consenti primary a pillola, Altre scelte secondary, Rifiuta destructive, Rimanda ghost', () => {
    const root = renderCenter({ approvalsAll: RIGHE() })
    const cards = withTestid(root, 'approvals-center-card')
    expect(cards).toHaveLength(4)
    for (const card of cards) {
      expect(card.tag).toBe('article')
      expectHasAll(card, ['rounded-surface', 'border', 'border-border', 'bg-card', 'p-4'])
    }
    // la card della richiesta di Turismo (insieme fisso: solo «Consenti una volta»), quella di Alloggio (ha le altre scelte) e la bozza di Solleciti
    const card = cards.find((c) => textOf(c).includes('Museo Egizio'))!
    const conScelte = cards.find((c) => withTestid(c, 'approval-altre-scelte').length > 0)!
    const bozza = cards.find((c) => withTestid(c, 'approval-draft-send').length > 0)!
    // il chip di categoria e il perché: badge in text-caption
    expectHasAll(ofText(card, 'i tuoi dati'), ['rounded-full', 'bg-muted', 'text-caption'])
    expectHasAll(ofText(card, 'sempre a te'), ['text-caption', 'text-muted-foreground'])
    // il titolo: il nome del bot, text-body in peso medio; sotto la frase della richiesta in text-body
    const nome = ofText(card, 'Turismo')
    expectHasAll(nome, ['font-medium'])
    expectHasAll(nome.parent!, ['text-body'])
    expectHasAll(ofText(card, 'Compilare il modulo del Museo Egizio con nome ed email.'), ['text-body'])
    // le azioni, in una riga flex gap-2
    const allow = byTestid(card, 'approval-allow-once')
    expect(textOf(allow)).toBe('Consenti una volta')
    expectHasAll(allow, ['h-control', 'rounded-full', 'bg-foreground', 'text-body', 'font-medium'])
    expectHasAll(allow.parent!, ['flex', 'gap-2'])
    // l'insieme fisso non offre altre scelte (il modello unico A1): il menu sta nella card che le ha
    expect(withTestid(card, 'approval-altre-scelte')).toHaveLength(0)
    const altre = byTestid(conScelte, 'approval-altre-scelte')
    expect(textOf(altre)).toBe('Altre scelte ▾')
    expectHasAll(altre, ['h-control', 'rounded-control', 'bg-muted', 'font-medium'])
    expectHasAll(byTestid(card, 'approval-deny'), ['h-control', 'rounded-control', 'bg-destructive'])
    const snooze = byTestid(card, 'approval-snooze')
    expectHasAll(snooze, ['h-control', 'rounded-control', 'text-muted-foreground'])
    expect(snooze.attrs.title).toContain('Sparisce da qui')
    // la bozza: Invia primary, Modifica secondary, Rifiuta destructive
    expectHasAll(byTestid(bozza, 'approval-draft-send'), ['rounded-full', 'bg-foreground'])
    expectHasAll(byTestid(bozza, 'approval-draft-edit'), ['bg-muted'])
    expectHasAll(byTestid(bozza, 'approval-deny'), ['bg-destructive'])
  })

  it('più di 3 richieste dello stesso tipo nel gruppo: le altre in una riga quieta con «Vedi» (bottone ghost); le card mostrate restano 3', () => {
    const root = renderCenter({ approvalsAll: [
      row(), row({ approvalId: 'ap-b' }), row({ approvalId: 'ap-c' }),
      row({ agentId: 'a-alloggio', botId: 'a-alloggio', botName: 'Alloggio', approvalId: 'ap-d', phrase: 'Archivio: clic su fatture.' }),
      row({ agentId: 'a-alloggio', botId: 'a-alloggio', botName: 'Alloggio', approvalId: 'ap-e', phrase: 'Archivio: altro clic.' })
    ] })
    expect(withTestid(root, 'approvals-center-card')).toHaveLength(3)
    const riga = first(root, (n) => textOf(n).startsWith('+2'))
    expect(textOf(riga)).toContain('Vedi')
    expectHasAll(riga, ['rounded-surface', 'bg-muted/50'])
    expectHasAll(first(riga, (n) => n.tag === 'button'), ['h-control-sm', 'text-muted-foreground'])
  })

  it('i testid e i testi delle sonde delle altre fasi (centro, uso-permessi, design): ci sono tutti e sono dove le sonde li cercano', () => {
    // C2: la descrizione sotto il titolo non c'è più — il conteggio delle richieste lo dicono le pillole («Tutte · 4»)
    const root = renderCenter({ approvalsAll: RIGHE() })
    const ids = new Set(testidsOf(root))
    for (const id of [
      'approvals-center', 'approvals-center-close', 'approvals-open-registro', 'approvals-center-tabs', 'approvals-tab-richieste', 'approvals-tab-registro',
      'approvals-center-group', 'approvals-center-card', 'approval-allow-once', 'approval-deny', 'approval-snooze', 'approval-altre-scelte',
      'approval-draft-send', 'approval-draft-edit', 'approval-choice-turn', 'approval-choice-always'
    ]) expect(ids.has(id), id).toBe(true)
    // le scelte del menu e le azioni stanno DENTRO la card (le sonde le cliccano dalla card che contiene il testo)
    for (const card of withTestid(root, 'approvals-center-card')) {
      for (const id of ['approval-deny', 'approval-snooze']) expect(withTestid(card, id).length, `${id} nella card`).toBeGreaterThan(0)
    }
    const text = textOf(root)
    for (const t of ['Tutte · 4', 'I tuoi dati · 2', 'Invii · 1', 'Siti · 1', 'team · 2', 'team · 1', 'bot · 1', 'Apri il team', 'tramite un sottoagente', 'aspetta da 2 min', 'sempre a te', 'il revisore non è sicuro', 'A: amministrazione@rossi.example', 'Oggetto: Fattura 214', 'Nessuna richiesta di dati tuoi, pagamenti o invii passa senza di te.']) {
      expect(text, t).toContain(t)
    }
    for (const b of all(root, (n) => n.tag === 'button')) expect(textOf(b).toLowerCase()).not.toContain('approva tutto')
  })
})

describe('DS4: il Registro — la tabella unica, per giorno', () => {
  /** Le quattro celle di una riga, come si leggono. */
  const celle = (r: HtmlNode): string[] => r.children.filter((c) => c.tag === 'td').map((c) => textOf(c))

  it('le decisioni sono una DataTable: intestazioni Quando · Bot · Cosa · Esito (text-caption, che non vanno a capo), righe da 52 col testid approvals-registro-row, celle che troncano col titolo intero', () => {
    const root = renderRegistro()
    const registro = byTestid(root, 'approvals-registro')
    const tables = all(registro, (n) => n.tag === 'table')
    expect(tables).toHaveLength(2)
    for (const table of tables) {
      expectHasAll(table, ['table-fixed', 'w-full'])
      const th = all(table, (n) => n.tag === 'th')
      expect(th.map((t) => textOf(t))).toEqual(['Quando', 'Bot', 'Cosa', 'Esito'])
      for (const t of th) expectHasAll(t, ['text-caption', 'whitespace-nowrap', 'font-normal'])
    }
    const righe = withTestid(registro, 'approvals-registro-row')
    expect(righe).toHaveLength(REGISTRO().length)
    for (const r of righe) {
      expectHasAll(r, ['h-row', 'border-t'])
      const td = r.children.filter((c) => c.tag === 'td')
      expect(td).toHaveLength(4)
      // ogni pezzo di testo della cella sta su UNA riga (tronca): niente a capo
      for (const c of td) {
        const pezzi = all(c, (n) => n.children.length === 0)
        expect(pezzi.length, 'la cella ha del testo').toBeGreaterThan(0)
        for (const p of pezzi) expect(has(p, 'truncate'), `«${textOf(p)}» tronca`).toBe(true)
      }
    }
    // il testo intero al passaggio, sulle celle lunghe
    expect(ofText(righe[3]!, 'Mandare il sollecito a Rossi Srl.').attrs.title).toBe('Mandare il sollecito a Rossi Srl.')
  })

  it('ogni riga dice quando e da dove, chi, cosa e con quale esito — dal più recente; le righe vecchie lo dicono', () => {
    const righe = withTestid(byTestid(renderRegistro(), 'approvals-registro'), 'approvals-registro-row')
    expect(celle(righe[0]!)).toEqual(['12:00da sola · grant 12', 'Ricerche', 'write-file', 'Passata da solagrant 12'])
    expect(celle(righe[1]!)).toEqual(['11:00senza risposta', 'Turismo', 'Compilare il modulo.', 'Scaduto'])
    expect(celle(righe[2]!)).toEqual(['10:00dal centro', 'Archivio', 'Cliccare «Verifica».', 'Rifiutato'])
    expect(celle(righe[3]!)).toEqual(['09:00dalla chat', 'Solleciti', 'Mandare il sollecito a Rossi Srl.', 'Consentito sempre'])
    // la riga vecchia: l'ora c'è, il «da dove» no (non lo sapeva il registro di allora)
    expect(celle(righe[4]!).slice(1)).toEqual(['Vecchio', 'Clic vecchio.', 'decisione precedente al registro'])
    expect(celle(righe[4]!)[0]).toMatch(/^\d\d:\d\d$/)
    // il rifiutato e lo scaduto sono grigi; il consentito e la passata da sola in primo piano
    const esito = (r: HtmlNode): HtmlNode => r.children[3]!.children[0]!
    expect(has(esito(righe[2]!), 'text-muted-foreground')).toBe(true)
    expect(has(esito(righe[1]!), 'text-muted-foreground')).toBe(true)
    expect(has(esito(righe[3]!), 'text-muted-foreground')).toBe(false)
    expect(has(esito(righe[0]!), 'text-muted-foreground')).toBe(false)
  })

  it('per giorno una Section (approvals-registro-day) col nome del giorno; i filtri del registro sono pillole come quelle delle richieste', () => {
    const root = renderRegistro()
    const giorni = withTestid(root, 'approvals-registro-day')
    expect(giorni.map((g) => g.tag)).toEqual(['section', 'section'])
    for (const g of giorni) expectHasAll(first(g, (n) => n.tag === 'h2'), ['text-body', 'font-medium', 'text-muted-foreground'])
    // «oggi» resta «oggi» nel testo (è l'etichetta del modello) ed esce come «Oggi»: la maiuscola la mette capitalize
    const titolo = first(giorni[0]!, (n) => n.tag === 'h2')
    expect(textOf(titolo)).toBe('oggi')
    expect(has(titolo.children[0]!, 'capitalize')).toBe(true)
    // C3: i filtri stanno nella BARRA del centro (approvals-filters), non più nel corpo
        // findAll non guarda la radice: il gruppo si cerca dall'albero intero
    const gruppo = first(root, (n) => n.attrs['data-testid'] === 'approvals-filters' && n.attrs.role === 'group' && n.attrs['aria-label'] === 'Filtra il registro')
    const pills = all(gruppo, (n) => n.tag === 'button')
    expect(pills.map((b) => textOf(b))).toEqual(['Tutte', 'Approvate · 1', 'Rifiutate · 1', 'Scadute · 1', 'Passate da sole · 1'])
    for (const p of pills) expectHasAll(p, ['rounded-full', 'h-control-sm', 'text-caption'])
  })

  it('«Consentiti sempre» (approvals-registro-grants): la spiegazione, un\'etichetta per bot (il bot prima, «Tutti i bot» per ultimo), le concessioni come righe a filo con Revoca — un bottone ghost (grant-revoke)', async () => {
    const root = renderRegistro()
    const sezione = byTestid(root, 'approvals-registro-grants')
    expect(sezione.tag).toBe('section')
    expect(textOf(first(sezione, (n) => n.tag === 'h2'))).toBe('Consentiti sempre')
    expect(ofText(sezione, 'Ciò che i bot possono fare senza chiedere. Revoca e la chiamata successiva torna a chiedere.')).toBeTruthy()
    const etichette = all(sezione, (n) => n.tag === 'h3')
    expect(etichette.map((e) => textOf(e))).toEqual(['Alloggio', 'Tutti i bot'])
    for (const e of etichette) expectHasAll(e, ['text-caption', 'font-medium', 'text-muted-foreground'])
    const righe = all(sezione, (n) => has(n, 'py-row-pad'))
    expect(righe).toHaveLength(2)
    for (const r of righe) expectHasAll(r, ['flex', 'w-full', 'items-center', 'gap-row-gap', 'min-h-row-text'])
    expect(textOf(first(righe[0]!, (n) => has(n, 'truncate')))).toBe('Letture di notion')
    // il comando: il nome del consenso e, in monospazio, il suo testo
    expect(has(first(sezione, (n) => n.tag === 'code'), 'font-mono')).toBe(true)
    expect(textOf(sezione)).toContain('git status')
    const revoche = withTestid(sezione, 'grant-revoke')
    expect(revoche.map((b) => textOf(b))).toEqual(['Revoca', 'Revoca'])
    for (const b of revoche) expectHasAll(b, ['h-control-sm', 'text-muted-foreground', 'rounded-control'])
    // il gruppo del bot viene prima: la prima Revoca è la sua; poi il registro si ricarica
    ;(nativeOf(root, (n) => n.tag === 'button' && textOf(n) === 'Revoca').onClick as () => void)()
    expect(callsOf('grantRevoke').slice(-1)[0]!.args).toEqual([8])
    await new Promise((r) => setTimeout(r, 0))
    expect(callsOf('approvalsLog').length).toBeGreaterThan(0)
  })

  it('senza concessioni lo dice; finché carica lo dice (i dati arrivano dall\'api: nel render statico non arrivano)', () => {
    expect(textOf(byTestid(renderRegistro([]), 'approvals-registro-grants'))).toContain('Nessun consenso sempre attivo.')
    expect(textOf(byTestid(renderCenter({ approvalsView: 'registro' }), 'approvals-registro'))).toContain('caricamento…')
  })
})

// ==================== la coda della squadra ====================

const squadra = (): Record<string, unknown> => ({
  id: 1, name: 'Weekend Torino', description: '', createdBy: 'user', coordinatorId: 'a1',
  members: [{ agentId: 'a1', name: 'Capo', coordinator: true }, { agentId: 'a2', name: 'Turismo', coordinator: false }],
  createdAt: 1, lastMessageAt: null, autonomy: 'box'
})
const pendente = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: 'a2', agentName: 'Turismo', approvalId: 'ap-1', tool: 'fill_credential',
  phrase: 'Compilare il modulo del Museo Egizio con nome ed email.',
  category: 'dati-tuoi', why: 'fisso', when: Date.now() - 120_000, fromSubagent: false, ...over
})

function renderCoda(pending: Array<Record<string, unknown>>): HtmlNode {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    openGroupId: 1, groups: [squadra()], groupPending: pending,
    groupActivity: [{ id: 'files', count: 14, who: ['Treni', 'Alloggio', 'Turismo'] }, { id: 'pages', count: 44, who: [] }],
    groupReviewerPassed: [{ agentId: 'a1', agentName: 'Treni', tool: 'browser_click', reason: 'serve alla tua richiesta', when: 1, grantId: 5 }],
    resolveGroupApproval: vi.fn(), setApprovalsQueueOpen: vi.fn(), refreshSquadData: vi.fn()
  })
  return parseHtml(renderHtml(createElement(ApprovalsQueue)))
}

describe('DS4: la coda «Da approvare» della squadra', () => {
  it('è il guscio di DS2 (approvals-queue, larghezza unica wide) con la testata: indietro «Torna al team» (approvals-back), l\'icona, il titolo e sotto la descrizione', () => {
    const root = renderCoda([])
    expectGuscio(root, 'approvals-queue', 'wide')
    const regione = byTestid(root, 'approvals-queue').parent!
    expect(regione.tag).toBe('section')
    expect(regione.attrs['aria-label']).toBe('Da approvare')
    const { head } = expectTestata(root, { testid: 'approvals-back', label: 'Torna al team' })
    expect(textOf(first(head, (n) => n.tag === 'h1'))).toBe('Da approvare')
    expect(has(first(head, (n) => (n.attrs.class ?? '').includes('lucide-shield-check')), 'size-5')).toBe(true)
    expectHasAll(ofText(slot(root, 'header'), 'Weekend Torino · tutte le richieste del team, in un posto'), ['text-small', 'text-muted-foreground'])
    // indietro chiude la coda
    ;(nativeOf(root, (n) => n.attrs['data-testid'] === 'approvals-back').onClick as () => void)()
    expect(useStore.getState().setApprovalsQueueOpen).toHaveBeenCalledWith(false)
  })

  it('K3 (fase conversione-chat): le tre sezioni del disegno sono ListGroup (il titolo di sezione del catalogo); le richieste sono ProposalCard (approval-row: il guscio delle card in chat, tone attesa) coi bottoni del sistema; «Consenti per questa missione» solo dove Q2 la permette', () => {
    const root = renderCoda([pendente(), pendente({ approvalId: 'ap-s', category: 'sito-interattivo', tool: 'browser_click', why: 'revisore', fromSubagent: true })])
    const titoli = all(root, (n) => n.tag === 'h3')
    expect(titoli.map((h) => textOf(h))).toEqual(['Solo tu puoi decidere', 'Fatto da soli, senza chiederti', 'Lasciato passare dal revisore'])
    for (const h of titoli) expectHasAll(h, ['text-caption', 'font-medium', 'text-muted-foreground'])
    const cards = withTestid(root, 'approval-row')
    expect(cards.map((c) => c.tag)).toEqual(['div', 'div'])
    // la superficie è quella di ChatCard: raggio di superficie, respiro 16, il fondo dell'attesa, nessun bordo (non è la Card con bordo delle pagine)
    for (const c of cards) {
      expectHasAll(c, ['rounded-surface', 'p-4', 'bg-waiting/10', 'flex-col', 'gap-2'])
      expect(has(c, 'border')).toBe(false)
      expect(has(c, 'bg-card')).toBe(false)
    }
    const card = cards[0]!
    expectHasAll(ofText(card, 'Turismo'), ['font-medium'])
    // l'etichetta di categoria è Tag (il raggio dei controlli, testo grigio), contro il bordo destro del titolo
    expectHasAll(ofText(card, 'i tuoi dati'), ['rounded-control', 'bg-muted', 'text-caption', 'text-muted-foreground'])
    // la riga grigia sotto il nome: il quando, poi via via chi chiede e perché arriva a te (prima: un pezzo per parola)
    expect(textOf(first(card, (n) => has(n, 'text-small') && textOf(n).startsWith('2 min')))).toBe('2 min · sempre a te')
    expectHasAll(first(card, (n) => has(n, 'text-small') && textOf(n).startsWith('2 min')), ['text-small', 'text-muted-foreground'])
    expectHasAll(first(card, (n) => n.tag === 'button' && textOf(n) === 'Consenti una volta'), ['h-control', 'rounded-full', 'bg-foreground'])
    expectHasAll(first(card, (n) => n.tag === 'button' && textOf(n) === 'Rifiuta'), ['h-control', 'rounded-control', 'bg-destructive'])
    expect(withTestid(card, 'approval-mission')).toHaveLength(0)
    // la seconda: sito interattivo → la missione c'è, secondaria, col suo titolo
    const missione = withTestid(cards[1]!, 'approval-mission')
    expect(missione).toHaveLength(1)
    expectHasAll(missione[0]!, ['h-control', 'rounded-control', 'bg-muted'])
    expect(missione[0]!.attrs.title).toBe('Un consenso di 8 ore per tutto il team, solo per questo')
    // il clic decide con la resolveGroupApproval di oggi
    const sola = renderCoda([pendente()])
    ;(nativeOf(sola, (n) => n.tag === 'button' && textOf(n) === 'Consenti una volta').onClick as () => void)()
    expect(useStore.getState().resolveGroupApproval).toHaveBeenCalledWith('a2', 'ap-1', 'allow', 'once')
  })

  it('K3: «Fatto da soli» e «Lasciato passare dal revisore» sono ListGroup con righe ListRow (il filetto del gruppo, il respiro e le misure della riga di elenco); l\'annullamento è il bottone della riga (secondary sm), come dice la regola del catalogo', async () => {
    const root = renderCoda([])
    // un gruppo per sezione: tre gruppi, tre contenitori col filetto
    expect(all(root, (n) => has(n, 'divide-y'))).toHaveLength(3)
    const righe = all(root, (n) => has(n, 'py-row-pad'))
    expect(righe).toHaveLength(3)
    for (const r of righe) expectHasAll(r, ['flex', 'w-full', 'items-center', 'gap-row-gap', 'min-h-row-text'])
    const titolo = (r: HtmlNode): string => textOf(first(r, (n) => has(n, 'truncate')))
    // K3: il conteggio è il titolo e chi l'ha fatto la riga grigia sotto (i nomi possono essere molti: si tronca il resto)
    const sotto = (r: HtmlNode): string => textOf(all(r, (n) => has(n, 'truncate'))[1]!)
    expect(righe.map(titolo)).toEqual(['14 file scritti nel computer', '44 pagine web lette', 'Treni · serve alla tua richiesta'])
    expect(sotto(righe[0]!)).toBe('Treni, Alloggio, Turismo')
    expect(sotto(righe[1]!)).toBe('—')
    const annulla = first(righe[2]!, (n) => n.tag === 'button')
    expect(textOf(annulla)).toBe('Annulla la concessione')
    expectHasAll(annulla, ['h-control-sm', 'bg-muted'])
    ;(nativeOf(root, (n) => n.tag === 'button' && textOf(n) === 'Annulla la concessione').onClick as () => void)()
    expect(callsOf('grantRevoke').slice(-1)[0]!.args).toEqual([5])
    await new Promise((r) => setTimeout(r, 0))
    expect(useStore.getState().refreshSquadData).toHaveBeenCalledWith({ forceBadges: true })
  })
})

// ==================== «Attività» ====================

const ATTIVITÀ = (): GlobalActivityData => ({
  tasks: [
    { id: 1, agentId: 'a-lavoro', title: 'Fatture ottobre', status: 'working', automatic: 0, createdAt: 100, updatedAt: Date.now(), summary: null },
    { id: 2, agentId: 'a-fatto', title: 'Rassegna stampa', status: 'done', automatic: 1, createdAt: 50, updatedAt: Date.now() - 3_600_000, summary: '3 link verificati e riassunti in una pagina' },
    { id: 3, agentId: 'a-fallito', title: 'Avviso Bitcoin', status: 'failed', automatic: 0, createdAt: 40, updatedAt: Date.now() - 60_000, summary: null }
  ],
  runs: [],
  waiting: ['a-attesa']
})

/** La vista aperta; senza dati iniziali mostra «caricamento…» (l'effect non gira nel render statico). */
function renderAttività(activityInitial?: GlobalActivityData): HtmlNode {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    activityOpen: true, select: vi.fn(), openTask: vi.fn(),
    agents: [agente('a-lavoro', 'Lavoro'), agente('a-fatto', 'Fatto'), agente('a-fallito', 'Fallito'), agente('a-attesa', 'Attesa')]
  })
  return parseHtml(renderHtml(createElement(ActivityPanel, activityInitial ? ({ activityInitial } as never) : undefined)))
}

describe('DS4: «Attività»', () => {
  it('chiusa non c\'è; aperta è il guscio di DS2 (activity-panel, largo wide: 1120) con la testata: indietro «Torna alla chat», l\'icona Activity di 20, il titolo «Attività»', () => {
    setStoreStateForRender(useStore, { activityOpen: false })
    expect(renderHtml(createElement(ActivityPanel))).toBe('')
    const root = renderAttività()
    expectGuscio(root, 'activity-panel', 'wide')
    const { head, back } = expectTestata(root, { label: 'Torna alla chat' })
    expect(back.attrs['data-testid']).toBeUndefined()
    const h1 = first(head, (n) => n.tag === 'h1')
    expect(textOf(h1)).toBe('Attività')
    expectHasAll(h1, ['font-display', 'font-semibold', 'text-page'])
    const icona = first(head, (n) => n.tag === 'svg' && (n.attrs.class ?? '').includes('lucide-activity'))
    expect(has(icona, 'size-5')).toBe(true)
    // indietro torna alla chat
    ;(nativeOf(root, (n) => n.attrs['aria-label'] === 'Torna alla chat').onClick as () => void)()
    expect(useStore.getState().activityOpen).toBe(false)
  })

  it('nel toolbar: la ricerca (36 px, rounded-control, placeholder «Cerca nei lavori» in text-body) e i filtri come pillole in text-caption, l\'attiva in primo piano', () => {
    const root = renderAttività()
    const toolbar = slot(root, 'toolbar')
    const input = first(toolbar, (n) => n.tag === 'input')
    expect(input.attrs.placeholder).toBe('Cerca nei lavori')
    expectHasAll(input, ['text-body', 'outline-none'])
    expectHasAll(input.parent!, ['h-control', 'rounded-control', 'bg-muted'])
    expect(has(first(toolbar, (n) => n.tag === 'svg'), 'size-4')).toBe(true)
    const pills = all(toolbar, (n) => n.tag === 'button')
    expect(pills.map((p) => textOf(p))).toEqual(['Tutti', 'Da te', 'Routine', 'Non riusciti'])
    for (const [i, p] of pills.entries()) {
      expectHasAll(p, ['rounded-full', 'h-control-sm', 'text-caption'])
      if (i === 0) expectHasAll(p, ['bg-foreground'])
      else expectHasAll(p, ['bg-muted'])
    }
  })

  it('le righe: la mascotte del bot nello slot da 32, il nome nel suo colore, lo stato (text-caption) a destra, sotto il titolo e l\'esito; il clic apre la chat del bot sul lavoro e chiude la vista', () => {
    const root = renderAttività(ATTIVITÀ())
    const righe = all(slot(root, 'scroll'), (n) => n.tag === 'button')
    // l'ordine è quello del modello (activityRows): chi aspetta te, chi lavora, poi per data
    expect(righe.map((r) => textOf(first(r, (n) => has(n, 'font-medium'))))).toEqual(['Attesa', 'Lavoro', 'Fallito', 'Fatto'])
    for (const r of righe) {
      expectHasAll(r, ['flex', 'w-full', 'gap-row-gap', 'py-row-pad', 'text-left', 'cursor-pointer'])
      expectHasAll(r.children[0]!, ['grid', 'size-8'])
      expect(first(r.children[0]!, (n) => n.tag === 'svg').attrs.width).toBe('32')
    }
    // il nome del bot nel suo colore
    const nome = ofText(righe[1]!, 'Lavoro')
    expectHasAll(nome, ['text-body', 'font-medium', 'truncate'])
    // C3 (fase linguaggio): il nome del bot nel COLORE DEL TESTO — il colore sta nel puntino (BotDot, palette --bot-dot-*)
    expect(nome.attrs.style).toBeUndefined()
    const dot = findAll(righe[1]!, (n) => (n.attrs.class ?? '').includes('size-2'))[0]!
    expect(dot.attrs.style).toMatch(/^background:var\(--bot-dot-c\d\)$/)
    // lo stato: in corso grigio, aspetta te nel colore dell'attesa, il motivo in rosso, l'ora di un lavoro finito col segno di spunta
    expectHasAll(ofText(righe[1]!, 'in corso'), ['text-caption', 'text-muted-foreground'])
    expectHasAll(ofText(righe[0]!, 'aspetta te'), ['text-caption', 'text-waiting', 'font-semibold'])
    // un compito fallito non dice il motivo (non lo ha: vale «non riuscito»); lo dice la routine fallita, col suo codice
    expectHasAll(ofText(righe[2]!, 'non riuscito'), ['text-caption', 'text-destructive'])
    expectHasAll(first(righe[3]!, (n) => n.children.length === 0 && textOf(n).endsWith(' ✓')), ['text-caption', 'text-muted-foreground'])
    // chi aspetta te lo dice al posto del titolo; le routine sono dette accanto al nome
    expectHasAll(ofText(righe[0]!, 'ha bisogno di te'), ['text-body', 'truncate'])
    expectHasAll(ofText(righe[3]!, '· routine'), ['text-small', 'text-muted-foreground'])
    // l'esito di un lavoro finito: text-small grigio, su una riga
    expectHasAll(ofText(righe[3]!, '3 link verificati e riassunti in una pagina'), ['text-small', 'text-muted-foreground', 'truncate'])
    // il clic: apre la chat del bot e il suo lavoro, e chiude
    ;(nativeOf(root, (n) => n.tag === 'button' && textOf(n).includes('Fatture ottobre')).onClick as () => void)()
    expect(useStore.getState().openTask).toHaveBeenCalledWith(1)
    expect(useStore.getState().activityOpen).toBe(false)
  })

  it('senza lavori lo dice (nel corpo nessuna riga: i bottoni restano quelli del toolbar); finché carica lo dice', () => {
    const vuota = renderAttività({ tasks: [], runs: [], waiting: [] })
    expect(all(slot(vuota, 'scroll'), (n) => n.tag === 'button')).toHaveLength(0)
    expect(all(slot(vuota, 'toolbar'), (n) => n.tag === 'button')).toHaveLength(4)
    expect(textOf(slot(vuota, 'scroll'))).toContain('Nessun lavoro qui: i compiti dei bot e le loro routine finiscono in questo elenco.')
    expect(textOf(slot(renderAttività(), 'scroll'))).toContain('caricamento…')
  })
})

// ==================== il riquadro «+N altrove» ====================

describe('DS4: il riquadro «+N altrove» in cima alle chat', () => {
  const altrove = (n: number): ApprovalsCenterRow[] => Array.from({ length: n }, (_, i) => row({ approvalId: `ap-${i}`, squad: null, botId: 'a-altro', botName: 'Altro', when: i + 1 }))

  function renderRiquadro(approvalsAll: ApprovalsCenterRow[], excludeBotId?: string, patch: Record<string, unknown> = {}): string {
    capture.els.length = 0
    setStoreStateForRender(useStore, { approvalsAll, approvalsSnoozed: {}, approvalsOpen: false, openGroupId: null, ...patch })
    // `as never` come in approvals-registro.test.ts: createElement non inferisce le prop di un componente che le ha tutte facoltative
    return renderHtml(createElement(ApprovalsBannerElsewhere, excludeBotId === undefined ? null : ({ excludeBotId } as never)))
  }

  it('è una riga compatta (un Notice in text-body, dentro una scheda rounded-surface) alla larghezza della colonna di lettura, con un\'azione Button; dentro approvals-banner c\'è un bottone (la sonda lo apre da lì)', () => {
    const root = parseHtml(renderRiquadro(altrove(2)))
    const riquadro = byTestid(root, 'approvals-banner')
    expectHasAll(riquadro, ['px-page-margin'])
    expect(first(riquadro, isContent).attrs.style).toBe('max-width:var(--w-reading)')
    const bottone = first(riquadro, (n) => n.tag === 'button')
    expect(textOf(bottone)).toBe('Apri «Da approvare»')
    expectHasAll(bottone, ['h-control-sm', 'bg-muted'])
    const avviso = first(riquadro, (n) => 'data-notice' in n.attrs)
    expectHasAll(avviso, ['rounded-surface', 'border', 'bg-card', 'p-3', 'text-body', 'text-waiting'])
    expect(textOf(avviso)).toBe('+2 altroveApri «Da approvare»')
    // l'icona: 16 px, nello slot di Notice
    expect(has(first(avviso, (n) => n.tag === 'svg'), 'size-4')).toBe(true)
  })

  it('il clic apre il centro; senza richieste altrove (o solo rinviate, o quelle del bot aperto) il riquadro non c\'è', () => {
    const root = parseHtml(renderRiquadro(altrove(3)))
    ;(nativeOf(root, (n) => n.tag === 'button').onClick as () => void)()
    expect(useStore.getState().approvalsOpen).toBe(true)
    expect(renderRiquadro(altrove(1))).not.toBe('')
    expect(renderRiquadro([])).toBe('')
    expect(renderRiquadro(altrove(1), undefined, { approvalsSnoozed: { 'ap-0': Date.now() + 60_000 } })).toBe('')
    expect(renderRiquadro(altrove(1), 'a-altro')).toBe('')
  })
})

// ==================== le classi: nessuna muta ====================

describe('DS4: le classi scritte nei file di queste pagine', () => {
  const FILES = ['components/ApprovalsCenter.tsx', 'components/ApprovalsQueue.tsx', 'components/ApprovalsBanner.tsx', 'components/ActivityPanel.tsx']

  it('nessuna classe morta: ogni classe genera la sua regola nel CSS compilato da styles.css (in node un nome sbagliato tace)', async () => {
    const tokens = new Set<string>()
    for (const f of FILES) {
      const source = readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), 'utf8')
      // le liste di classi lette dall'AST (la stessa lettura della guardia): i commenti non contano
      for (const value of stringsOf(source)) {
        if (!isClassList(value)) continue
        for (const token of value.split(/\s+/)) if (token !== '') tokens.add(token)
      }
    }
    expect(tokens.size).toBeGreaterThan(60)
    const css = await compileRenderer([...tokens])
    expect(deadClasses(css, tokens)).toEqual([])
    // il controllo non è vuoto: un nome sbagliato lo vede
    expect(deadClasses(css, [...tokens, 'h-controlsm'])).toEqual(['h-controlsm'])
  })
})
