// Fase design (DS4, Impostazioni): le pagine delle Impostazioni passano al
// sistema — le stesse regole per tutte (DS1 in styles.css), i pezzi di DS2 al
// posto di ciò che ogni pagina scriveva a mano. Qui si prova ciò che il render
// statico decide: il GUSCIO del dialogo (riga ferma col titolo e la ✕, corpo
// che scorre largo quanto l'area e colonna centrata con PageColumn), i pezzi
// delle impostazioni (SettingsGroup, SettingsRow, SettingsSegments), la
// Cassaforte (UnderlineTabs, FlatRow, icone lucide al posto delle emoji),
// «Uso e costi» (DataTable) e le sezioni interne. Senza DOM: i componenti
// veri resi con react-dom/server, l'HTML letto come albero; dove serve
// «cliccare» si invoca il VERO handler delle props catturate (capture.els).
import './render-helper-install'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, hasAncestor, dialogPassThroughMock, accessibleName, textOf, type HtmlNode } from './render-helper'
import { callsOf } from './render-helper-install'
import { scan } from './design-scan'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())

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

const { Settings, UsageTab } = await import('../components/Settings')
const { VaultTab } = await import('../components/VaultSettings')
const { SettingsGroup } = await import('../components/settings/SettingsGroup')
const { SettingsRow, SettingsSegments } = await import('../components/settings/SettingsRow')
const { SettingsPage } = await import('../components/settings/SettingsPage')
const { SettingsAdvanced } = await import('../components/settings/SettingsAdvanced')
const { DiskSpaceSection, PruneFeedback } = await import('../components/settings/DiskSpaceSection')
const { EngineSection } = await import('../components/settings/EngineSection')
const { ApprovalsPage, ModeSelect } = await import('../components/settings/ApprovalsPage')
const { ModelsPage, ProviderDetail } = await import('../components/settings/ModelsPage')
const { AddProviderSheet, ProviderMark } = await import('../components/settings/AddProviderSheet')
const { useStore } = await import('../store')

/** Le classi di un nodo come insieme. */
const classes = (n: HtmlNode): string[] => (n.attrs['class'] ?? '').split(/\s+/).filter((c) => c !== '')
const has = (n: HtmlNode, ...cls: string[]): boolean => cls.every((c) => classes(n).includes(c))
const htmlOf = (element: ReactElement): HtmlNode => parseHtml(renderHtml(element))
const byTag = (root: HtmlNode, tag: string): HtmlNode[] => findAll(root, (n) => n.tag === tag)
const byText = (root: HtmlNode, text: string): HtmlNode | null => findAll(root, (n) => n.tag !== '#root' && textOf(n) === text)[0] ?? null

/** Le sei dimensioni di DS1: l'unico `text-<taglia>` che può comparire. */
const TEXT_SIZES = ['text-caption', 'text-small', 'text-body', 'text-reading', 'text-title', 'text-page']
/** Una taglia di Tailwind o una dimensione libera, al posto delle sei di DS1 (le stringhe vietate si scrivono qui apposta: è un test). */
const OFF_SYSTEM_SIZE = /^(?:[\w-]+:)*!?text-(?:(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)(?:\/\S+)?|\[[^\]]*\])$/
/** Le classi `text-<taglia>` fuori dal sistema, in tutto l'albero. */
const textOffSystem = (root: HtmlNode): string[] =>
  findAll(root, () => true).flatMap((n) => classes(n).filter((c) => OFF_SYSTEM_SIZE.test(c)))
/**
 * Ciò che portano dentro Input e Select (components/ui), che non sono ancora migrati (non sono di questa
 * pagina): `md:text-sm` è la STESSA misura di text-body (14 px), e `file:text-sm` riguarda il bottone dei
 * campi file, che qui non ci sono. Le classi del campo passano da cn dentro il pezzo: alla pagina basta
 * passare le misure di DS1 (FIELD_ROW_CLS), e quando il pezzo sarà migrato queste spariscono da sole.
 */
const DEI_PEZZI_NON_MIGRATI = new Set(['md:text-sm', 'file:text-sm'])

/** Le classi `rounded-…` fuori dai tre raggi di DS1. */
const RADIUS_OFF_SYSTEM = /^(?:[\w-]+:)*!?rounded(?:-(?:ss|se|ee|es|[trbl]{1,2}))?(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|4xl|\[[^\]]*\]))?$/
const radiusOffSystem = (root: HtmlNode): string[] =>
  findAll(root, () => true).flatMap((n) => classes(n).filter((c) => RADIUS_OFF_SYSTEM.test(c)))
/** Le misure scritte a mano (h-, w-, p-, gap- con le parentesi quadre) e le interlinee: fuori dal sistema. */
const MEASURE_OFF_SYSTEM = /^(?:[\w-]+:)*!?(?:h|w|max-w|min-h|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap)-\[[^\]]*\]$|^(?:[\w-]+:)*!?leading-/
const measureOffSystem = (root: HtmlNode): string[] =>
  findAll(root, () => true).flatMap((n) => classes(n).filter((c) => MEASURE_OFF_SYSTEM.test(c)))
/** Ogni icona lucide (svg) con una misura diversa da 16 o 20 px — o senza misura scritta qui. */
const iconsOffSize = (root: HtmlNode): string[] =>
  byTag(root, 'svg')
    .filter((n) => (n.attrs.class ?? '').includes('lucide-'))
    .map((n) => `${n.attrs.class}: ${classes(n).filter((c) => /^(?:size-|-?[wh]-)/.test(c)).join(' ') || '(senza misura)'}`)
    .filter((c) => !/(?:^| )size-[45](?: |$)/.test(c))
/** Le classi di tutto ciò che c'è in un albero. */
const everyClass = (root: HtmlNode): string[] => findAll(root, () => true).flatMap(classes)

/** Le classi di un albero senza ciò che portano dentro Input e Select (non ancora migrati: DEI_PEZZI_NON_MIGRATI). */
const classiSenzaPezzi = (root: HtmlNode): string[] => everyClass(root).filter((c) => !DEI_PEZZI_NON_MIGRATI.has(c))

/** Il contenitore che scorre del dialogo: quello dei contenuti, a destra della navigazione. */
const settingsScroller = (root: HtmlNode): HtmlNode =>
  findAll(root, (n) => has(n, 'overflow-y-auto', 'scroll-thin') && n.tag !== 'nav' && !hasAncestor(n, (a) => a.tag === 'nav'))[0]!
/** La riga di un dialogo per testid. */
const byTestId = (root: HtmlNode, id: string): HtmlNode[] => findAll(root, (n) => n.attrs['data-testid'] === id)

/** Render del dialogo su una scheda (come lo apre il bottoncino del menu: la scheda è il valore iniziale). */
function renderTab(tab: string): HtmlNode {
  capture.els.length = 0
  setStoreStateForRender(useStore, { settingsOpen: true, settingsTab: tab })
  return htmlOf(createElement(Settings))
}

describe('DS4 Impostazioni: i pezzi — SettingsGroup, SettingsRow, SettingsPage, SettingsAdvanced', () => {
  it('SettingsGroup: etichetta text-caption grigia 500 (niente 13 px, niente maiuscoletto), scheda rounded-surface, footer text-small, distanze di Section', () => {
    const root = htmlOf(createElement(SettingsGroup, { label: 'Aspetto', footer: 'una frase', children: createElement('div', null, 'riga') }))
    const section = byTag(root, 'section')[0]!
    expect(has(section, 'flex', 'flex-col', 'gap-section-head')).toBe(true)
    const [label, , footer] = section.children
    expect(label!.tag).toBe('h3')
    expect(has(label!, 'text-caption', 'font-medium', 'text-muted-foreground')).toBe(true)
    expect(textOf(label!)).toBe('Aspetto')
    const card = section.children[1]!
    expect(has(card, 'overflow-hidden', 'rounded-surface', 'bg-muted/60')).toBe(true)
    expect(card.attrs.class).not.toContain('rounded-2xl')
    expect(has(footer!, 'text-small', 'text-muted-foreground')).toBe(true)
    expect(textOffSystem(root)).toEqual([])
  })

  it('SettingsGroup senza etichetta e senza footer: solo la scheda', () => {
    const section = byTag(htmlOf(createElement(SettingsGroup, { children: createElement('div', null, 'x') })), 'section')[0]!
    expect(section.children.map((c) => c.tag)).toEqual(['div'])
  })

  it('SettingsRow: alta almeno 52 col respiro di 12, nome text-body 500, descrizione text-small grigia, filetto dalla seconda', () => {
    const root = htmlOf(createElement('div', null,
      createElement(SettingsRow, { title: 'Tema', description: 'una descrizione', control: createElement('span', null, 'ctrl') }),
      createElement(SettingsRow, { title: 'Lingua' })
    ))
    const rows = byTag(root, 'div').filter((n) => has(n, 'min-h-row'))
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(has(row, 'min-h-row', 'py-row-pad', 'px-4', 'flex', 'flex-col', 'gap-2')).toBe(true)
      expect(has(row, '@[420px]:flex-row', '@[420px]:items-center')).toBe(true)
      expect(row.attrs.class).toContain('[&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/40')
    }
    const name = byText(root, 'Tema')!
    expect(has(name, 'block', 'text-body', 'font-medium', 'truncate')).toBe(true)
    const desc = byText(root, 'una descrizione')!
    expect(has(desc, 'block', 'text-small', 'text-muted-foreground')).toBe(true)
    expect(desc.attrs.class).not.toContain('leading-')
    expect(textOffSystem(root)).toEqual([])
  })

  it('SettingsRow `stacked`: il nome va a capo e il controllo resta sotto (le righe del modulo di configurazione)', () => {
    const root = htmlOf(createElement(SettingsRow, { stacked: true, title: 'Variabili d\u2019ambiente', description: 'd', control: createElement('span', null, 'c') }))
    const row = byTag(root, 'div')[0]!
    expect(row.attrs.class).not.toContain('@[420px]:flex-row')
    expect(byText(root, 'Variabili d\u2019ambiente')!.attrs.class).not.toContain('truncate')
  })

  it('SettingsSegments: un radiogroup di bottoni, la voce attiva piena e la sola aria-checked, 32 px di default', () => {
    capture.els.length = 0
    const onChange = vi.fn()
    const root = htmlOf(createElement(SettingsSegments, {
      label: 'Tema',
      value: 'dark',
      onChange,
      options: [
        { value: 'system', label: 'Sistema', testId: 'theme-system' },
        { value: 'light', label: 'Chiaro' },
        { value: 'dark', label: 'Scuro' }
      ]
    }))
    const group = findAll(root, (n) => n.attrs.role === 'radiogroup')[0]!
    expect(group.attrs['aria-label']).toBe('Tema')
    expect(has(group, 'inline-flex', 'items-center', 'gap-1', 'rounded-full', 'border-border', 'bg-card', 'p-1')).toBe(true)
    expect(group.attrs.class).not.toContain('flex-wrap')
    const radios = findAll(group, (n) => n.tag === 'button')
    expect(radios.map((r) => [r.attrs.role, r.attrs['aria-checked'], textOf(r)])).toEqual([
      ['radio', 'false', 'Sistema'], ['radio', 'false', 'Chiaro'], ['radio', 'true', 'Scuro']
    ])
    for (const r of radios) {
      expect(has(r, 'h-control-sm', 'rounded-full', 'px-3', 'text-body', 'outline-none', 'focus-visible:ring-2')).toBe(true)
      expect(r.attrs.class).not.toMatch(/(?:^|\s)focus:/)
    }
    expect(radios.filter((r) => has(r, 'bg-foreground', 'text-background', 'font-medium')).map((r) => textOf(r))).toEqual(['Scuro'])
    expect(findAll(group, (n) => n.attrs['data-testid'] === 'theme-system')).toHaveLength(1)

    // il VERO handler: scegliere una voce chiama onChange col suo valore
    const scelta = capture.els.find((e) => e.type === 'button' && e.props['data-testid'] === 'theme-system')!
    ;(scelta.props.onClick as () => void)()
    expect(onChange).toHaveBeenCalledWith('system')
  })

  it('SettingsSegments `size="md"` e `fill`: 36 px e le voci si dividono la larghezza; `disabled` spegne tutte le voci', () => {
    const root = htmlOf(createElement(SettingsSegments<string>, {
      size: 'md', fill: true, disabled: true, value: 'a', onChange: () => undefined,
      options: [{ value: 'a', label: 'Uno' }, { value: 'b', label: 'Due' }]
    }))
    const group = findAll(root, (n) => n.attrs.role === 'radiogroup')[0]!
    expect(has(group, 'flex', 'w-full')).toBe(true)
    const radios = findAll(group, (n) => n.tag === 'button')
    expect(radios).toHaveLength(2)
    for (const r of radios) {
      expect(has(r, 'h-control', 'flex-1')).toBe(true)
      expect(r.attrs.class).not.toContain('h-control-sm')
      // nel markup statico un attributo booleano è vuoto: c'è, e vale
      expect(r.attrs.disabled).toBe('')
    }
  })

  it('SettingsPage: soltanto il ritmo (gap-section) — niente titolo, niente pr-12, niente max-w-3xl scritto a mano', () => {
    const html = renderHtml(createElement(SettingsPage, { children: createElement('p', null, 'x') }))
    expect(html).toBe('<div class="flex flex-col gap-section"><p>x</p></div>')
  })

  it('SettingsAdvanced: il bottone text-small con l\u2019icona da 16, e la freccia che gira quando è aperto', () => {
    capture.els.length = 0
    const chiuso = htmlOf(createElement(SettingsAdvanced, { children: createElement('p', null, 'dentro') }))
    const bottone = byTag(chiuso, 'button')[0]!
    expect(bottone.attrs['aria-expanded']).toBe('false')
    expect(has(bottone, 'h-control-sm', 'shrink-0', 'self-start', 'gap-1', 'rounded-control', 'text-small', 'text-muted-foreground', 'outline-none')).toBe(true)
    expect(textOf(bottone)).toBe('Avanzate')
    expect(byText(chiuso, 'dentro')).toBe(null)
    // il VERO handler: apre
    ;(capture.els.find((e) => e.type === 'button' && e.props['aria-expanded'] === false)!.props.onClick as () => void)()
    const svg = byTag(chiuso, 'svg')[0]!
    expect(classes(svg)).toContain('size-4')
    const aperto = htmlOf(createElement(SettingsAdvanced, { defaultOpen: true, label: 'Regole per strumento', children: createElement('p', null, 'dentro') }))
    expect(byTag(aperto, 'button')[0]!.attrs['aria-expanded']).toBe('true')
    // l'etichetta si può cambiare («Regole per strumento»)
    expect(textOf(byTag(aperto, 'button')[0]!)).toBe('Regole per strumento')
    const contenuto = byTag(aperto, 'p')[0]!.parent!
    expect(has(contenuto, 'flex', 'flex-col', 'gap-block')).toBe(true)
    expect(has(contenuto.parent!, 'flex', 'flex-col', 'gap-section-head')).toBe(true)
    // a girare è l'involucro dell'icona; la misura resta scritta fissa sull'icona
    expect(has(byTag(aperto, 'svg')[0]!.parent!, 'rotate-180')).toBe(true)
  })
})

/** Le classi di tutto ciò che sta DENTRO il dialogo (la cornice del dialogo è di ui/dialog: non è di questa pagina). */
const classesInsideDialog = (root: HtmlNode): string[] => {
  const frame = findAll(root, (n) => n.attrs['data-mock'] === 'dialog-content')[0]
  if (!frame) return findAll(root, () => true).flatMap(classes)
  return findAll(frame, () => true).filter((n) => n !== frame).flatMap(classes)
}

const TABS = [
  ['generale', 'Generali', 'page'],
  ['modelli', 'Modelli', 'page'],
  ['approvazioni', 'Approvazioni', 'page'],
  ['vault', 'Cassaforte', 'page'],
  ['routine', 'Routine', 'page'],
  ['uso', 'Uso e costi', 'wide']
] as const

describe('DS4 Impostazioni: il guscio del dialogo', () => {
  it('la navigazione: sei voci alte 40 con l\u2019icona da 16 e testo text-body; l\u2019attiva è una voce rounded-control (non più una pillola)', () => {
    const root = renderTab('generale')
    const nav = byTag(root, 'nav')[0]!
    const voci = nav.children.filter((c) => c.tag === 'button')
    expect(voci.map((v) => textOf(v))).toEqual(['Generali', 'Modelli', 'Approvazioni', 'Cassaforte', 'Routine', 'Uso e costi'])
    for (const v of voci) {
      expect(has(v, 'h-row-text', 'gap-row-gap', 'rounded-control', 'text-body', 'text-left', 'outline-none', 'focus-visible:ring-2')).toBe(true)
      expect(v.attrs.class).not.toContain('rounded-full')
      expect(v.attrs.class).not.toMatch(/(?:^|\s)focus:/)
      const svg = byTag(v, 'svg')[0]!
      expect(has(svg, 'size-4')).toBe(true)
    }
    expect(voci.filter((v) => has(v, 'bg-muted', 'font-medium', 'text-foreground')).map((v) => textOf(v))).toEqual(['Generali'])
    expect(voci.filter((v) => has(v, 'text-muted-foreground'))).toHaveLength(5)
    expect(iconsOffSize(nav)).toEqual([])
  })

  it('il titolo «Impostazioni» della colonna è da 20 px (text-title), non nel font dei titoli di pagina, e resta il bersaglio del fuoco all\u2019apertura', () => {
    const nav = byTag(renderTab('generale'), 'nav')[0]!
    const titolo = nav.children[0]!
    expect(titolo.tag).toBe('strong')
    expect(titolo.attrs.id).toBe('sandbot-settings-title')
    expect(titolo.attrs.tabindex).toBe('-1')
    expect(has(titolo, 'text-title', 'font-semibold', 'outline-none')).toBe(true)
    expect(classes(titolo)).not.toContain('font-display')
    expect(textOf(titolo)).toBe('Impostazioni')
  })

  it('il titolo della sezione è un h2 text-page in font-display, nella riga FERMA sopra lo scorrimento — in ogni scheda, una volta sola', () => {
    for (const [tab, titolo] of TABS) {
      const root = renderTab(tab)
      const h2 = byTag(root, 'h2').filter((n) => textOf(n) === titolo)
      expect(h2, tab).toHaveLength(1)
      expect(has(h2[0]!, 'min-w-0', 'truncate', 'font-display', 'font-semibold', 'text-page'), tab).toBe(true)
      // se non ci sta, il nome intero si legge al passaggio (come il titolo di PageHeader)
      expect(h2[0]!.attrs.title, tab).toBe(titolo)
      expect(hasAncestor(h2[0]!, (a) => has(a, 'h-col-head', 'items-center')), tab).toBe(true)
      expect(hasAncestor(h2[0]!, (a) => has(a, 'shrink-0', 'px-1.5')), tab).toBe(true)
      expect(hasAncestor(h2[0]!, (a) => has(a, 'overflow-y-auto')), tab).toBe(false)
    }
  })

  it('la ✕ è un bottone da 32 (h-control-sm, prima 36) con l\u2019icona da 16, nella riga ferma: una sola, in ogni scheda, e chiude davvero', () => {
    for (const [tab] of TABS) {
      const root = renderTab(tab)
      const chiudi = byTag(root, 'button').filter((b) => accessibleName(b) === 'Chiudi')
      expect(chiudi, tab).toHaveLength(1)
      const x = chiudi[0]!
      expect(has(x, 'h-control-sm', 'w-control-sm', 'rounded-full', 'outline-none', 'focus-visible:ring-2'), tab).toBe(true)
      expect(classes(x), tab).not.toContain('size-9')
      expect(has(byTag(x, 'svg')[0]!, 'size-4'), tab).toBe(true)
      expect(hasAncestor(x, (a) => has(a, 'h-col-head')), tab).toBe(true)
      expect(hasAncestor(x, (a) => has(a, 'overflow-y-auto')), tab).toBe(false)
      expect(classes(x), tab).not.toContain('absolute')
    }
    setStoreStateForRender(useStore, { settingsOpen: true })
    renderTab('generale')
    ;(capture.els.find((e) => e.type === 'button' && e.props['aria-label'] === 'Chiudi')!.props.onClick as () => void)()
    expect(useStore.getState().settingsOpen).toBe(false)
  })

  it('il corpo che scorre: figlio diretto della colonna (arriva al bordo destro), barra riservata su tutti e due i lati, dentro un contenitore @container; dentro, la PageColumn', () => {
    for (const [tab, , width] of TABS) {
      const root = renderTab(tab)
      const scroller = settingsScroller(root)
      expect(has(scroller, 'min-h-0', 'flex-1', 'overflow-y-auto', 'overflow-x-hidden', 'scroll-thin', '[scrollbar-gutter:stable_both-edges]'), tab).toBe(true)
      // niente padding intorno allo scorrimento: la barra sta sul bordo del dialogo
      const colonna = scroller.parent!
      expect(has(colonna, '@container', 'min-w-0', 'flex-1', 'flex-col'), tab).toBe(true)
      expect(classes(colonna).filter((c) => /^(?:p|px|py|pr)-/.test(c)), tab).toEqual([])
      expect(colonna.parent!.attrs['data-mock'], tab).toBe('dialog-content')
      // la colonna: il gutter col margine della pagina (32, 24 sotto i 900 px di AREA) e il contenuto centrato
      const gutter = scroller.children[0]!
      expect(gutter.attrs['data-page-gutter'], tab).toBe('true')
      expect(has(gutter, 'w-full', 'min-w-0', 'px-page-margin', '@max-[900px]:px-page-margin-narrow'), tab).toBe(true)
      const content = gutter.children[0]!
      expect(content.attrs['data-page-content'], tab).toBe('true')
      expect(has(content, 'mx-auto', 'w-full', 'py-6'), tab).toBe(true)
      // «Uso e costi» ha le tabelle: la colonna larga (DS1)
      expect(content.attrs.style, tab).toBe(`max-width:var(--w-${width})`)
    }
  })

  it('la riga ferma è larga quanto l\u2019area, col contenuto alla stessa larghezza dello scorrimento (px-1.5: i 6 px della barra, come PageShell)', () => {
    for (const [tab, , width] of TABS) {
      const root = renderTab(tab)
      const h2 = byTag(root, 'h2')[0]!
      expect(hasAncestor(h2, (a) => has(a, 'px-1.5', 'shrink-0')), tab).toBe(true)
      const gutter = h2.parent!.parent!.parent!
      expect(gutter.attrs['data-page-gutter'], tab).toBe('true')
      expect(has(gutter, 'px-page-margin', '@max-[900px]:px-page-margin-narrow'), tab).toBe(true)
      expect(gutter.children[0]!.attrs.style, tab).toBe(`max-width:var(--w-${width})`)
      expect(hasAncestor(h2, (a) => has(a, 'overflow-y-auto')), tab).toBe(false)
    }
  })

  it('«Torna alla guida» (la guida aspetta il modello) sta fra le azioni della riga ferma — non più un bottone assoluto sopra il titolo', () => {
    setStoreStateForRender(useStore, {
      settingsOpen: true, settingsTab: null,
      onboarding: { needed: true, state: { step: 'model', done: ['welcome'], skipped: [], startedAt: 1 }, sequence: ['welcome', 'model', 'approvals', 'ready'], modelReady: false, guideOpen: false }
    } as never)
    const root = htmlOf(createElement(Settings))
    const [torna] = byTestId(root, 'settings-back-to-guide')
    expect(torna, 'il bottone dev\u2019esserci quando la guida aspetta il modello').toBeTruthy()
    expect(textOf(torna!)).toBe('Torna alla guida')
    expect(has(torna!, 'h-control-sm', 'bg-muted', 'text-foreground'), 'un\u2019azione secondaria da 32').toBe(true)
    expect(hasAncestor(torna!, (a) => has(a, 'h-col-head'))).toBe(true)
    expect(hasAncestor(torna!, (a) => has(a, 'overflow-y-auto'))).toBe(false)
    // e sta dopo il titolo, con la ✕ (le azioni a destra)
    const azioni = torna!.parent!
    expect(azioni.children.map((c) => c.tag)).toEqual(['button', 'button'])
    expect(accessibleName(azioni.children[1]!)).toBe('Chiudi')
    // senza la guida in attesa non c'è
    setStoreStateForRender(useStore, { onboarding: null })
    expect(byTestId(renderTab('generale'), 'settings-back-to-guide')).toHaveLength(0)
  })
})

describe('DS4 Impostazioni: Generali', () => {
  const renderGenerale = (): HtmlNode => {
    setStoreStateForRender(useStore, {
      settingsOpen: true, settingsTab: null,
      updaterStatus: { current: '0.3.1001', canUpdate: true, needsMove: false, channel: 'stable' },
      onboarding: { needed: true, state: { step: 'ready', done: ['welcome', 'model'], skipped: ['model'], startedAt: 1 }, sequence: ['welcome', 'model', 'approvals', 'ready'], modelReady: true, guideOpen: false }
    } as never)
    return htmlOf(createElement(Settings))
  }

  it('«Tema» è un segmento: il radiogroup «Tema» con tre voci, l\u2019attiva piena e la sola scelta', () => {
    const root = renderGenerale()
    const group = findAll(root, (n) => n.attrs.role === 'radiogroup' && n.attrs['aria-label'] === 'Tema')[0]
    expect(group, 'il segmento del tema').toBeTruthy()
    expect(findAll(group!, (n) => n.tag === 'button').map((b) => [textOf(b), b.attrs['aria-checked']])).toEqual([
      ['Sistema', 'true'], ['Chiaro', 'false'], ['Scuro', 'false']
    ])
    expect(findAll(group!, (n) => n.tag === 'button' && has(n, 'bg-foreground'))).toHaveLength(1)
  })

  it('i campi sono Input e Select da 32 (h-control-sm, rounded-control, text-body); il testid della lingua resta', () => {
    const root = renderGenerale()
    const campi = [...byTag(root, 'input'), ...byTag(root, 'select')]
    expect(campi.length).toBeGreaterThanOrEqual(4)
    for (const el of campi) {
      expect(has(el, 'h-control-sm', 'rounded-control', 'text-body'), `${el.tag} ${el.attrs['aria-label'] ?? el.attrs.placeholder ?? ''}`).toBe(true)
      expect(el.attrs['data-slot'], el.tag).toBe(el.tag === 'input' ? 'input' : 'select')
    }
    expect(byTestId(root, 'ui-language-select')).toHaveLength(1)
    expect(campi.map((c) => c.attrs.class).join(' ')).not.toMatch(/rounded-\[|h-9(?: |$)/)
  })

  it('le azioni delle righe sono Button da 32: «Controlla aggiornamenti» la pillola piena, «Rifai da capo» secondaria; «Riprendi» resta nella riga della guida', () => {
    const root = renderGenerale()
    const dentro = (nome: string): HtmlNode => byTag(settingsScroller(root), 'button').filter((b) => textOf(b) === nome)[0]!
    const controlla = dentro('Controlla aggiornamenti')
    expect(has(controlla, 'h-control-sm', 'rounded-full', 'bg-foreground', 'text-background')).toBe(true)
    const rifai = dentro('Rifai da capo')
    expect(has(rifai, 'h-control-sm', 'rounded-control', 'bg-muted', 'text-foreground')).toBe(true)
    const riprendi = dentro('Riprendi')
    expect(has(riprendi, 'h-control-sm', 'rounded-full', 'bg-foreground')).toBe(true)
    // la riga della versione porta LEI il testid (prima un div intorno: la riga era il primo figlio di quel div, e sopra non c'era il filetto)
    const versione = byTestId(root, 'settings-update-row')[0]!
    expect(has(versione, 'min-h-row', '[&:not(:first-child)]:border-t')).toBe(true)
    expect(has(versione.parent!, 'rounded-surface', 'bg-muted/60'), 'figlia diretta della scheda').toBe(true)
    // i due della guida stanno nella riga con il testid di sempre
    const [rigaGuida] = byTestId(root, 'settings-guide-row')
    expect(rigaGuida!.children.map((c) => textOf(c))).toEqual(['Riprendi', 'Rifai da capo'])
    // OGNI controllo del contenuto è alto 32 (h-control-sm): niente più pillole scritte a mano
    // (l'interruttore no: è un interruttore, alto 24)
    for (const b of findAll(settingsScroller(root), (n) => n.tag === 'button')) {
      if (b.attrs.role === 'switch') continue
      expect(has(b, 'h-control-sm'), `${textOf(b)} (${b.attrs['aria-label'] ?? ''})`).toBe(true)
    }
  })

  it('tutto alle sei dimensioni, tre raggi, nessuna misura o interlinea scritta a mano; le icone lucide da 16 o 20', () => {
    const root = renderGenerale()
    const classi = classesInsideDialog(root).filter((c) => !DEI_PEZZI_NON_MIGRATI.has(c))
    expect(classi.filter((c) => OFF_SYSTEM_SIZE.test(c))).toEqual([])
    expect(classi.filter((c) => RADIUS_OFF_SYSTEM.test(c))).toEqual([])
    expect(classi.filter((c) => MEASURE_OFF_SYSTEM.test(c))).toEqual([])
    expect(classi.filter((c) => /(?:^|\s)uppercase$|tracking-/.test(c))).toEqual([])
    expect(iconsOffSize(root)).toEqual([])
    // niente più lo spazio per la ✕ dentro il contenuto, né la colonna scritta a mano
    expect(classi).not.toContain('pr-12')
    expect(classi).not.toContain('max-w-3xl')
  })

  it('«Spazio su disco» e «Computer dei bot» sono gruppi come gli altri: etichetta text-caption grigia 500 (prima in maiuscoletto), scheda rounded-surface senza bordo', () => {
    const root = renderGenerale()
    for (const id of ['disk-space-section', 'engine-section']) {
      const [sezione] = byTestId(root, id)
      expect(sezione, id).toBeTruthy()
      const gruppo = sezione!.children[0]!
      expect(gruppo.tag, id).toBe('section')
      const etichetta = gruppo.children[0]!
      expect(has(etichetta, 'text-caption', 'font-medium', 'text-muted-foreground'), id).toBe(true)
      const scheda = gruppo.children[1]!
      expect(has(scheda, 'rounded-surface', 'bg-muted/60', 'overflow-hidden'), id).toBe(true)
      expect(classes(scheda), id).not.toContain('border')
    }
    expect(byText(root, 'Spazio su disco')).not.toBe(null)
    expect(byText(root, 'Computer dei bot')).not.toBe(null)
  })
})

describe('DS4 Impostazioni: Routine', () => {
  it('«Suggerisci dal transcript»: l\u2019icona Sparkles al posto dell\u2019emoji, in un bottone secondario da 36; il testo non ha più l\u2019emoji', () => {
    const root = renderTab('routine')
    const bottone = byTag(settingsScroller(root), 'button').filter((b) => textOf(b) === 'Suggerisci dal transcript')[0]
    expect(bottone, 'il bottone degli suggerimenti').toBeTruthy()
    expect(has(bottone!, 'h-control', 'rounded-control', 'bg-muted', 'text-foreground')).toBe(true)
    const svg = byTag(bottone!, 'svg')[0]!
    expect(has(svg, 'size-4')).toBe(true)
    expect(classes(svg).some((c) => c.includes('sparkles'))).toBe(true)
    const classi = classesInsideDialog(root).filter((c) => !DEI_PEZZI_NON_MIGRATI.has(c))
    expect(classi.filter((c) => OFF_SYSTEM_SIZE.test(c))).toEqual([])
    expect(classi.filter((c) => RADIUS_OFF_SYSTEM.test(c))).toEqual([])
    expect(classi.filter((c) => MEASURE_OFF_SYSTEM.test(c))).toEqual([])
    expect(iconsOffSize(root)).toEqual([])
  })
})

describe('DS4 Impostazioni: «Spazio su disco» e «Computer dei bot» in Generali', () => {
  it('«Spazio su disco»: un gruppo come gli altri; ogni riga ha nome e misura (i due <p> che legge la sonda di box-container) e un Button da 32; i testid restano', () => {
    const root = htmlOf(createElement(DiskSpaceSection, {
      initial: {
        engine: 'apple', freeBytes: 5_000_000_000, marginBytes: 1,
        rows: [{ id: 'model', bytes: 2_500_000_000, destructive: true }, { id: 'reclaimable', bytes: null, destructive: false }]
      } as never
    }))
    const sezione = byTestId(root, 'disk-space-section')[0]!
    const gruppo = sezione.children[0]!
    expect(gruppo.tag).toBe('section')
    expect(has(gruppo, 'flex', 'flex-col', 'gap-section-head')).toBe(true)
    expect(has(gruppo.children[0]!, 'text-caption', 'font-medium', 'text-muted-foreground')).toBe(true)
    expect(textOf(gruppo.children[0]!)).toBe('Spazio su disco')
    const scheda = gruppo.children[1]!
    // niente più la scheda bordata col respiro di 4: la scheda tenue di ogni gruppo
    expect(has(scheda, 'overflow-hidden', 'rounded-surface', 'bg-muted/60')).toBe(true)
    expect(classes(scheda)).not.toContain('border')
    expect(classes(scheda)).not.toContain('p-1')

    const modello = byTestId(root, 'disk-space-model')[0]!
    expect(byTag(modello, 'p').map(textOf), 'il nome e la misura: due <p>, in quest\u2019ordine').toEqual(['Modello locale', '2.5 GB'])
    expect(has(modello, 'min-h-row', 'py-row-pad', 'px-4')).toBe(true)
    const bottone = byTag(modello, 'button')[0]!
    expect(textOf(bottone)).toBe('Rimuovi')
    expect(has(bottone, 'h-control-sm', 'rounded-full', 'bg-foreground', 'text-background', 'text-body')).toBe(true)

    // la riga senza misura: il bottone c\u2019è lo stesso, spento
    const recuperabile = byTestId(root, 'disk-space-reclaimable')[0]!
    const libera = byTag(recuperabile, 'button')[0]!
    expect(textOf(libera)).toBe('Libera spazio')
    expect(libera.attrs.disabled).toBe('')

    // il filetto sta TRA le righe (mai sotto l\u2019ultima)
    expect(has(modello, '[&:not(:last-child)]:border-b', '[&:not(:last-child)]:border-border/40')).toBe(true)
    expect(has(recuperabile, '[&:not(:last-child)]:border-b')).toBe(true)
    // la frase sullo spazio libero è il footer del gruppo (sotto la scheda, grigio)
    expect(has(gruppo.children[2]!, 'text-small', 'text-muted-foreground')).toBe(true)
    expect(textOf(gruppo.children[2]!)).toBe('Spazio libero sul Mac: 5.0 GB — prima di costruire o scaricare ne restano sempre 5 GB.')
    expect(textOffSystem(root)).toEqual([])
    expect(radiusOffSystem(root)).toEqual([])
    expect(iconsOffSize(root)).toEqual([])
  })

  it('«Spazio su disco» mentre lavora: spinner da 16 e «Libero spazio…»; senza dati la scheda resta vuota', () => {
    const root = htmlOf(createElement(DiskSpaceSection))
    const lavoro = htmlOf(createElement(PruneFeedback, { working: true, outcome: null }))
    expect(has(byTag(lavoro, 'svg')[0]!, 'size-4', 'animate-spin')).toBe(true)
    expect(has(byTestId(lavoro, 'disk-space-prune-working')[0]!, 'text-small', 'text-muted-foreground')).toBe(true)
    // senza dati la scheda c'è, vuota: nessuna riga (solo il testid della sezione) e nessun bottone
    const sezione = byTestId(root, 'disk-space-section')[0]!
    expect(findAll(root, (n) => n !== sezione && (n.attrs['data-testid'] ?? '').startsWith('disk-space-'))).toEqual([])
    expect(byTag(root, 'button')).toEqual([])
    // nessun footer finché non si conosce lo spazio libero
    expect(sezione.children[0]!.children).toHaveLength(2)
  })

  it('«Computer dei bot»: lo stato in parole, l\u2019azione un Button da 32 (col testid engine-install), le due scelte sono segmenti con i testid di sempre', () => {
    const root = htmlOf(createElement(EngineSection, {
      initial: { setting: 'auto', chosen: 'apple', appleState: 'not-installed', dockerRunning: false }
    }))
    const gruppo = byTestId(root, 'engine-section')[0]!.children[0]!
    expect(gruppo.tag).toBe('section')
    expect(has(gruppo.children[0]!, 'text-caption', 'font-medium', 'text-muted-foreground')).toBe(true)
    expect(textOf(gruppo.children[0]!)).toBe('Computer dei bot')
    expect(has(gruppo.children[1]!, 'rounded-surface', 'bg-muted/60')).toBe(true)

    // lo stato: la riga di stato è la stessa di sempre (testid), il testo in primo piano
    const stato = byTestId(root, 'engine-status-text')[0]!
    expect(textOf(byTag(stato, 'p')[0]!)).toBe('Da installare: serve macOS 26 o successivo')
    expect(has(byTag(stato, 'p')[0]!, 'text-body', 'font-medium', 'truncate')).toBe(true)
    const installa = byTestId(root, 'engine-install')[0]!
    expect(textOf(installa)).toBe('Installa')
    expect(has(installa, 'h-control-sm', 'rounded-full', 'bg-foreground')).toBe(true)
    expect(textOf(byTestId(root, 'engine-install-hint')[0]!)).toContain('Dettagli')

    // «Dove girano i comandi»: un radiogroup, le due voci coi testid di sempre; finché non si è letto il valore nessuna è scelta
    const scelta = byTestId(root, 'sandbox-mode-choice')[0]!
    expect(scelta.attrs.role).toBe('radiogroup')
    expect(scelta.attrs['aria-label']).toBe('Dove girano i comandi')
    const voci = byTag(scelta, 'button')
    expect(voci.map((v) => v.attrs['data-testid'])).toEqual(['sandbox-mode-box', 'sandbox-mode-host'])
    expect(voci.map((v) => [textOf(v), v.attrs['aria-checked']])).toEqual([['Sul computer del bot', 'false'], ['Direttamente sul Mac', 'false']])
    // il motore: tre voci, «Automatico» attiva (lo legge la sonda di box-container dai bottoni della sezione)
    const motori = findAll(root, (n) => n.attrs.role === 'radiogroup' && n.attrs['aria-label'] === 'Motore')
    expect(motori).toHaveLength(1)
    expect(byTag(motori[0]!, 'button').map((v) => [textOf(v), v.attrs['aria-checked']])).toEqual([
      ['Automatico', 'true'], ['Apple container', 'false'], ['Docker', 'false']
    ])
    // i bottoni della sezione: «Installa», «Sul computer del bot», «Direttamente sul Mac», «Automatico», «Apple container», «Docker» — tutti da 32
    for (const b of byTag(byTestId(root, 'engine-section')[0]!, 'button')) expect(has(b, 'h-control-sm'), textOf(b)).toBe(true)
    expect(textOffSystem(root)).toEqual([])
    expect(radiusOffSystem(root)).toEqual([])
    expect(iconsOffSize(root)).toEqual([])
  })

  it('«Computer dei bot» installato e acceso: nessuna azione sulla riga, «Disinstalla lo strumento di Apple» è un\u2019azione distruttiva quieta', () => {
    const root = htmlOf(createElement(EngineSection, {
      initial: { setting: 'docker', chosen: 'docker', appleState: 'ready', dockerRunning: true }
    }))
    expect(textOf(byTag(byTestId(root, 'engine-status-text')[0]!, 'p')[0]!)).toBe('Pronto (Docker)')
    expect(byTestId(root, 'engine-install')).toHaveLength(0)
    const disinstalla = byTestId(root, 'engine-uninstall')[0]!
    expect(has(disinstalla, 'h-control-sm', 'text-destructive')).toBe(true)
    expect(has(disinstalla, 'bg-destructive'), 'quieta: non è la conferma').toBe(false)
  })
})

describe('DS4 Impostazioni: la Cassaforte', () => {
  const PLUGINS = {
    names: [{ id: 'srv-token', bearer: true, headers: [], env: [] }, { id: 'srv-h', bearer: false, headers: ['X-Api-Key'], env: [] }],
    servers: [{ id: 'srv-token', name: 'token' }, { id: 'srv-h', name: 'registro' }]
  }
  it('le schede sono UnderlineTabs: UNA riga (tablist, mai a capo) con le cinque schede, l\u2019attiva selezionata, il testid vault-tabs', () => {
    for (const [tab, attiva] of [['login', 'Login'], ['plugins', 'Dei plugin'], ['concessioni', 'Concessioni']] as const) {
      const root = htmlOf(createElement(VaultTab, { initial: { tab } }))
      const lista = byTestId(root, 'vault-tabs')[0]
      expect(lista, tab).toBeTruthy()
      expect(lista!.attrs.role, tab).toBe('tablist')
      expect(has(lista!, 'flex-nowrap', 'overflow-x-auto'), tab).toBe(true)
      expect(classes(lista!), tab).not.toContain('flex-wrap')
      expect(byTag(lista!, 'button').map((b) => [b.attrs.role, textOf(b), b.attrs['aria-selected']]), tab).toEqual([
        ['tab', 'Login', 'false'], ['tab', 'Segreti', 'false'], ['tab', 'Dei plugin', 'false'], ['tab', 'Contatti', 'false'], ['tab', 'Concessioni', 'false']
      ].map(([role, nome]) => [role, nome, nome === attiva ? 'true' : 'false']))
      // una sola scheda piena
      expect(byTag(lista!, 'button').filter((b) => has(b, 'border-foreground', 'text-foreground')), tab).toHaveLength(1)
    }
  })

  it('«Dei plugin»: le righe sono FlatRow in un FlatList (alte almeno 52, il logo nello slot da 32), coi testid di sempre; «Apri nella scheda ›» è un Button da 32 che apre QUELLA scheda', () => {
    setStoreStateForRender(useStore, { settingsOpen: true, pluginOpen: false, pluginAt: null })
    capture.els.length = 0
    const root = htmlOf(createElement(VaultTab, { initial: { tab: 'plugins', plugins: PLUGINS } as never }))
    const pannello = byTestId(root, 'vault-plugins')[0]!
    const lista = pannello.children.find((c) => has(c, 'divide-y'))!
    expect(lista, 'l\u2019elenco a filo').toBeTruthy()
    expect(has(lista, 'divide-y', 'divide-border/50')).toBe(true)
    const riga = byTestId(root, 'vault-plugin-row-srv-token')[0]!
    expect(riga.parent).toBe(lista)
    // a filo: la riga non è un riquadro (niente fondo, niente raggio, niente bordo) — solo il filetto dell'elenco
    expect(classes(riga).filter((c) => /^(?:bg-|rounded-|border)/.test(c)), 'a filo: niente riquadri intorno alle righe').toEqual([])
    // sola lettura: la riga NON si apre
    expect(riga.attrs.role).toBeUndefined()
    expect(riga.attrs.tabindex).toBeUndefined()
    expect(has(riga, 'flex', 'min-h-row', 'py-row-pad', 'gap-row-gap')).toBe(true)
    expect(textOf(byTestId(riga, 'vault-plugin-name-srv-token')[0]!)).toBe('token')
    expect(textOf(byTestId(riga, 'vault-plugin-type-srv-token')[0]!)).toBe('token')
    // il logo di ripiego (nessun file per questo nome): l\u2019iniziale in una piastrella da 32
    expect(has(byTag(riga, 'span')[0]!, 'size-8', 'shrink-0', 'place-items-center')).toBe(true)
    const apri = byTestId(root, 'vault-plugin-open-srv-token')[0]!
    expect(riga.children.map((c) => c.tag).includes('span')).toBe(true)
    expect(hasAncestor(apri, (a) => a === riga)).toBe(true)
    expect(textOf(apri)).toBe('Apri nella scheda ›')
    expect(has(apri, 'h-control-sm', 'text-body', 'outline-none')).toBe(true)
    expect(byTestId(root, 'vault-plugin-open-srv-h')).toHaveLength(1)
    // il VERO handler: chiude le Impostazioni e apre la pagina Plugin su quel server, «Account e bot»
    const choisie = capture.els.find((e) => e.type === 'button' && e.props['data-testid'] === 'vault-plugin-open-srv-h')
    expect(choisie, 'il bottone della seconda riga').toBeTruthy()
    ;(choisie!.props.onClick as () => void)()
    const s = useStore.getState() as unknown as { settingsOpen: boolean; pluginOpen: boolean; pluginAt: unknown }
    expect(s.settingsOpen).toBe(false)
    expect(s.pluginAt).toEqual({ kind: 'server', serverId: 'srv-h', tab: 'accounts' })
    expect(textOffSystem(root)).toEqual([])
    expect(radiusOffSystem(root)).toEqual([])
    expect(measureOffSystem(root)).toEqual([])
    expect(iconsOffSize(root)).toEqual([])
  })

  it('i segreti: la riga è FlatRow con l\u2019icona lucide KeyRound da 16 al posto dell\u2019emoji; «elimina» è un\u2019azione quieta rossa; i campi sono Input da 36', () => {
    const root = htmlOf(createElement(VaultTab, {
      initial: { tab: 'segreti', secrets: [{ kind: 'secret', key: 'API_KEY', label: 'API_KEY', createdAt: 1 }] } as never
    }))
    const svg = byTag(root, 'svg').find((n) => classes(n).some((c) => c.includes('key-round')))
    expect(svg, 'l\u2019icona del segreto').toBeTruthy()
    expect(has(svg!, 'size-4')).toBe(true)
    expect(svg!.parent!.parent!.attrs['data-testid'] ?? '').toBe('')
    expect(textOf(root)).toContain('API_KEY')
    expect(has(svg!.parent!.parent!, 'min-h-row', 'py-row-pad')).toBe(true)
    const elimina = byTag(root, 'button').filter((b) => textOf(b) === 'elimina')[0]!
    // com'era: grigia a riposo, rossa solo al passaggio — e mai un fondo rosso (non è una conferma)
    expect(has(elimina, 'h-control-sm', 'rounded-control', 'text-muted-foreground', 'hover:text-destructive')).toBe(true)
    expect(has(elimina, 'bg-destructive', 'text-destructive'), 'quieta: non è una conferma').toBe(false)
    for (const campo of byTag(root, 'input')) expect(has(campo, 'h-control', 'rounded-control', 'text-body'), campo.attrs.placeholder ?? '').toBe(true)
    const salva = byTag(root, 'button').filter((b) => textOf(b) === 'Salva')[0]!
    expect(has(salva, 'h-control', 'rounded-full', 'bg-foreground')).toBe(true)
    expect(iconsOffSize(root)).toEqual([])
  })

  it('le azioni della scheda (Aggiungi, Annulla, Salva) sono Button; i segni + restano nel testo, dove li cercano le sonde', () => {
    const root = htmlOf(createElement(VaultTab))
    const aggiungi = byTag(root, 'button').filter((b) => textOf(b) === '+ Aggiungi login')[0]!
    expect(has(aggiungi, 'h-control', 'rounded-control', 'bg-muted', 'w-full')).toBe(true)
    expect(byTag(aggiungi, 'svg')).toEqual([])
    const contatti = htmlOf(createElement(VaultTab, { initial: { tab: 'contatti' } }))
    expect(byTag(contatti, 'button').map((b) => textOf(b))).toContain('+ Aggiungi contatto')
    expect(textOffSystem(root)).toEqual([])
    expect(radiusOffSystem(root)).toEqual([])
    expect(measureOffSystem(root)).toEqual([])
  })

  it('nel sorgente della Cassaforte non c\u2019è più nessuna emoji (le icone sono lucide) — e nessuna regola di DS6 è rotta', () => {
    expect(scan().filter((v) => v.file === 'components/VaultSettings.tsx')).toEqual([])
  })
})

describe('DS4 Impostazioni: Approvazioni', () => {
  const renderApprovals = (initial?: { mode?: unknown; cfg?: unknown; grants?: unknown }): HtmlNode => {
    capture.els.length = 0
    setStoreStateForRender(useStore, {
      settingsOpen: true,
      permissions: { default: 'needs_approval', rules: [{ tool: 'run-command', pattern: 'ls', mode: 'always_allow' }] }
    } as never)
    return htmlOf(createElement(ApprovalsPage, { initial } as never))
  }

  it('senza dati la pagina dice «caricamento…» (come prima)', () => {
    const root = renderApprovals()
    expect(textOf(root)).toBe('caricamento…')
    expect(has(byTag(root, 'p')[0]!, 'text-small', 'text-muted-foreground')).toBe(true)
  })

  it('«Quando chiedere»: un segmento largo quanto la scheda (36 px, le voci si dividono lo spazio) — radiogroup, tre voci, aria-checked', () => {
    capture.els.length = 0
    const root = renderApprovals({ mode: 'auto', cfg: { enabled: true, providerId: 'p', model: 'm', allowRules: ['ls e cat'], blockRules: [] }, grants: [] })
    const gruppi = findAll(root, (n) => n.attrs.role === 'radiogroup')
    // su questa pagina c'è UN solo radiogroup (lo cercano le sonde: «[role="radiogroup"] button», tre)
    expect(gruppi).toHaveLength(1)
    expect(gruppi[0]!.attrs['aria-label']).toBe('Quando chiedere')
    expect(has(gruppi[0]!, 'flex', 'w-full')).toBe(true)
    const voci = byTag(gruppi[0]!, 'button')
    expect(voci.map((v) => [textOf(v), v.attrs['aria-checked']])).toEqual([['Chiedi', 'false'], ['Automatico', 'true'], ['Non chiedere', 'false']])
    for (const v of voci) expect(has(v, 'h-control', 'flex-1', 'text-body'), textOf(v)).toBe(true)
    // il VERO handler: scegliere «Chiedi» salva il modo (senza conferma)
    ;(capture.els.find((e) => e.type === 'button' && e.props.role === 'radio' && e.props.children === 'Chiedi')!.props.onClick as () => void)()
    expect(callsOf('settingsSet')).toContainEqual({ method: 'settingsSet', args: ['approvals.mode', 'ask'] })

    // in Automatico: la riga del modello col suo rimando, e le due liste di regole
    expect(textOf(root)).toContain('Cambia in Modelli ›')
    expect(textOf(root)).toContain('Continua da solo quando')
    expect(textOf(root)).toContain('Fermati e chiedimi sempre quando')
    expect(textOf(root)).toContain('ls e cat')
    // togliere una regola: un bottone solo-icona da 32, col suo nome accessibile
    const togli = byTag(root, 'button').filter((b) => b.attrs['aria-label'] === 'Rimuovi')
    expect(togli).toHaveLength(1)
    expect(has(togli[0]!, 'h-control-sm', 'w-control-sm', 'rounded-full')).toBe(true)
    ;(capture.els.find((e) => e.type === 'button' && e.props['aria-label'] === 'Rimuovi')!.props.onClick as () => void)()
    expect(callsOf('settingsSet')).toContainEqual({ method: 'settingsSet', args: ['autoReview', { enabled: true, providerId: 'p', model: 'm', allowRules: [], blockRules: [] }] })
    // «Aggiungi» della regola: secondario, da 32
    const aggiungi = byTag(root, 'button').filter((b) => textOf(b) === 'Aggiungi')
    expect(aggiungi).toHaveLength(2)
    for (const b of aggiungi) expect(has(b, 'h-control-sm', 'rounded-control', 'bg-muted')).toBe(true)
    const classi = classiSenzaPezzi(root)
    expect(classi.filter((c) => OFF_SYSTEM_SIZE.test(c))).toEqual([])
    expect(classi.filter((c) => RADIUS_OFF_SYSTEM.test(c))).toEqual([])
    expect(classi.filter((c) => MEASURE_OFF_SYSTEM.test(c))).toEqual([])
    expect(iconsOffSize(root)).toEqual([])
  })

  it('«Consensi salvati»: un gruppo per bot (intestazione grigia in tono normale, col testid), ogni concessione una SettingsRow con «Revoca» quieta', () => {
    const root = renderApprovals({
      mode: 'ask', cfg: { enabled: false, providerId: null, model: null, allowRules: [], blockRules: [] },
      grants: [
        { id: 1, tool: 'run-command', target: 'ls', createdAt: 1, agentId: null },
        { id: 2, tool: 'use-app', target: 'app:Posta', createdAt: 2, agentId: 'bot-a' }
      ]
    })
    expect(byTestId(root, 'grants-bot-group')).toHaveLength(2)
    const tutti = byTestId(root, 'grants-bot-all')[0]!
    expect(has(tutti, 'text-caption', 'font-medium', 'text-muted-foreground')).toBe(true)
    expect(classes(tutti)).not.toContain('uppercase')
    expect(classes(tutti).filter((c) => c.startsWith('tracking-'))).toEqual([])
    const revoca = byTag(root, 'button').filter((b) => textOf(b) === 'Revoca')
    expect(revoca).toHaveLength(2)
    for (const b of revoca) {
      expect(has(b, 'h-control-sm', 'rounded-control', 'text-muted-foreground'), 'quieta: grigia finché non ci si passa sopra').toBe(true)
      expect(has(b, 'hover:text-destructive')).toBe(true)
    }
    // i nomi tecnici in monospazio, alla misura dei dettagli (il gruppo «Tutti i bot» viene per ultimo)
    expect(byTag(root, 'code').map(textOf)).toEqual(['use-app · app:Posta', 'ls'])
    for (const c of byTag(root, 'code')) expect(has(c, 'font-mono', 'text-caption')).toBe(true)
    // le righe sono SettingsRow (alte almeno 52)
    for (const r of revoca) expect(hasAncestor(r, (a) => has(a, 'min-h-row', 'py-row-pad'))).toBe(true)
  })

  it('«Regole per strumento» sta chiuso sotto Avanzate (com’era), e il selettore dei modi è una pillola da 32', () => {
    const root = renderApprovals({ mode: 'ask', cfg: { enabled: false, providerId: null, model: null, allowRules: [], blockRules: [] }, grants: [] })
    // chiuso: c'\u00e8 il bottone «Regole per strumento», e la scheda non c'\u00e8
    const bottone = byTag(root, 'button').filter((b) => textOf(b) === 'Regole per strumento')[0]!
    expect(bottone.attrs['aria-expanded']).toBe('false')
    expect(byText(root, 'Politica predefinita')).toBe(null)
    // e il selettore dei modi è un Select a pillola (lo legge il render del pezzo)
    const sel = htmlOf(createElement(ModeSelect, { value: 'blocked', onChange: () => undefined }))
    const select = byTag(sel, 'select')[0]!
    expect(has(select, 'h-control-sm', 'rounded-full', 'text-body')).toBe(true)
    expect(byTag(select, 'option').map(textOf)).toEqual(['Consenti sempre', 'Chiedi approvazione', 'Blocca'])
  })
})

describe('DS4 Impostazioni: Modelli', () => {
  const PROVIDERS = [
    { id: 'ollama', name: 'Ollama (locale)', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', enabled: true, hasKey: false },
    { id: 'custom_1', name: 'Finto locale', kind: 'custom', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '', enabled: false, hasKey: true }
  ]
  beforeEach(() => { setStoreStateForRender(useStore, { providers: PROVIDERS } as never) })

  it('ogni provider è una riga a filo che si apre (FlatRow): alta almeno 52, il logo nello slot da 32, nome e riga grigia, lo stato, la freccia', () => {
    const root = renderTab('modelli')
    const righe = findAll(settingsScroller(root), (n) => n.attrs.role === 'button')
    expect(righe).toHaveLength(2)
    for (const [i, riga] of righe.entries()) {
      expect(has(riga, 'min-h-row', 'py-row-pad', 'px-4', 'gap-row-gap', 'cursor-pointer'), String(i)).toBe(true)
      expect(riga.attrs.tabindex, String(i)).toBe('0')
      // l'anello del fuoco verso l'interno (la scheda ritaglia ai suoi angoli), e mai `focus:`
      expect(has(riga, 'outline-none', 'focus-visible:outline-2', 'focus-visible:-outline-offset-2', 'focus-visible:outline-ring'), String(i)).toBe(true)
      expect(classes(riga).filter((c) => /(?:^|\s)focus:/.test(c)), String(i)).toEqual([])
      expect(has(byTag(riga, 'span')[0]!, 'size-8', 'shrink-0', 'place-items-center'), String(i)).toBe(true)
    }
    expect(textOf(righe[0])).toContain('Ollama (locale)')
    expect(textOf(righe[0])).toContain('Sul tuo Mac · … modelli · gratis e privato')
    // il nome intero si legge al passaggio (prima: title sul bottone)
    expect(byTag(righe[0], 'span').some((s) => s.attrs.title === 'Ollama (locale)')).toBe(true)
    // le azioni in fondo alla scheda: «Aggiungi provider», «Aggiungi riserva» e la riga che porta a «Uso e costi»
    // con la catena delle riserve letta compare «Aggiungi riserva» (fino al tetto K4): un bottone da 32 con l'icona da 16
    const conCatena = htmlOf(createElement(ModelsPage, { initial: { chain: [] } }))
    const riserva = byTag(conCatena, 'button').filter((b) => textOf(b) === 'Aggiungi riserva')[0]
    expect(riserva, '«Aggiungi riserva» con la catena letta').toBeTruthy()
    expect(has(riserva!, 'min-h-row', 'py-row-pad', 'px-4', 'text-body', 'text-muted-foreground', 'outline-none')).toBe(true)
    expect(has(byTag(riserva!, 'svg')[0]!, 'size-4')).toBe(true)
    // con una riserva: il suo posto è un dettaglio grigio, e il menu «Altre azioni» è un'icona lucide (non più il segno «⋯»)
    const conRiserva = htmlOf(createElement(ModelsPage, { initial: { chain: [{ providerId: 'ollama', model: 'x' }] } }))
    expect(findAll(conRiserva, (n) => n.attrs['aria-label'] === 'Altre azioni')).toHaveLength(1)
    expect(textOf(conRiserva)).toContain('1.')
    expect(iconsOffSize(conRiserva)).toEqual([])
    expect(textOf(conRiserva)).not.toContain('⋯')
    const bottoni = byTag(settingsScroller(root), 'button').map(textOf)
    expect(bottoni).toContain('Aggiungi provider')
    expect(bottoni.some((t) => t.startsWith('Uso e costi'))).toBe(true)
    // senza la catena letta la riga dice «…» e «Aggiungi riserva» non c'è (come prima)
    expect(bottoni).not.toContain('Aggiungi riserva')
    // la scheda dei provider: tutto ai token (dentro c'\u00e8 solo ciò che è di questa pagina)
    const scheda = righe[0]!.parent!.parent!
    expect(has(scheda, 'rounded-surface', 'bg-muted/60', 'overflow-hidden')).toBe(true)
    const classi = findAll(scheda, () => true).flatMap(classes)
    expect(classi.filter((c) => OFF_SYSTEM_SIZE.test(c))).toEqual([])
    expect(classi.filter((c) => RADIUS_OFF_SYSTEM.test(c))).toEqual([])
    expect(classi.filter((c) => MEASURE_OFF_SYSTEM.test(c))).toEqual([])
    expect(classi.filter((c) => /(?:^|\s)uppercase$|tracking-/.test(c))).toEqual([])
    expect(iconsOffSize(scheda)).toEqual([])
  })

  it('il provider aperto sul posto: i campi sono Input da 36, «Salva» la pillola piena, «Scollega» quieta rossa, la chiusura un bottone tondo da 32', () => {
    const root = htmlOf(createElement(ProviderDetail, { provider: PROVIDERS[1] as never, onDone: () => undefined }))
    for (const campo of byTag(root, 'input')) expect(has(campo, 'h-control', 'rounded-control', 'text-body'), campo.attrs.placeholder ?? '').toBe(true)
    expect(findAll(root, (n) => n.attrs.placeholder === 'Nome')).toHaveLength(1)
    const salva = byTag(root, 'button').filter((b) => textOf(b) === 'Salva')[0]!
    expect(has(salva, 'h-control', 'rounded-full', 'bg-foreground')).toBe(true)
    const scollega = byTag(root, 'button').filter((b) => textOf(b) === 'Scollega')[0]!
    expect(has(scollega, 'h-control-sm', 'text-destructive')).toBe(true)
    expect(has(scollega, 'bg-destructive'), 'quieta: la conferma viene dopo').toBe(false)
    const chiudi = byTag(root, 'button').filter((b) => b.attrs['aria-label'] === 'Chiudi')[0]!
    expect(has(chiudi, 'h-control-sm', 'w-control-sm', 'rounded-full')).toBe(true)
    expect(has(byTag(chiudi, 'svg')[0]!, 'size-4')).toBe(true)
    const classi = classiSenzaPezzi(root)
    expect(classi.filter((c) => OFF_SYSTEM_SIZE.test(c))).toEqual([])
    expect(classi.filter((c) => RADIUS_OFF_SYSTEM.test(c))).toEqual([])
    expect(classi.filter((c) => MEASURE_OFF_SYSTEM.test(c))).toEqual([])
    expect(iconsOffSize(root)).toEqual([])
  })

  it('ProviderMark: il logo da 40 nelle testate e da 32 nelle righe (DS1: prima 44 e 28), l\u2019icona Server 20 o 16', () => {
    const md = htmlOf(createElement(ProviderMark, { kind: 'custom', name: 'Il mio gateway' }))
    const sm = htmlOf(createElement(ProviderMark, { kind: 'custom', name: 'Il mio gateway', size: 'sm' }))
    expect(has(byTag(md, 'span')[0]!, 'size-10')).toBe(true)
    expect(has(byTag(sm, 'span')[0]!, 'size-8')).toBe(true)
    expect(has(byTag(md, 'svg')[0]!, 'size-5')).toBe(true)
    expect(has(byTag(sm, 'svg')[0]!, 'size-4')).toBe(true)
    expect(iconsOffSize(md)).toEqual([])
    expect(iconsOffSize(sm)).toEqual([])
    const lettera = htmlOf(createElement(ProviderMark, { kind: 'lmstudio', name: 'LM Studio' }))
    expect(textOf(byTag(lettera, 'span')[0]!)).toBe('L')
    expect(has(byTag(lettera, 'span')[0]!, 'font-semibold', 'text-title')).toBe(true)
    const letteraSm = htmlOf(createElement(ProviderMark, { kind: 'lmstudio', name: 'LM Studio', size: 'sm' }))
    expect(has(byTag(letteraSm, 'span')[0]!, 'text-reading')).toBe(true)
  })
})

describe('DS4 Impostazioni: il foglio «Aggiungi provider»', () => {
  beforeEach(() => { setStoreStateForRender(useStore, { providers: [], agents: [{ id: 'a_1', name: 'Bot', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }], mainAgentId: 'a_1' } as never) })

  it('passo 1: titolo text-title (non nel font dei titoli di pagina), ricerca in una pillola da 36, gruppi con l\u2019etichetta text-caption e righe a filo (logo da 32, «Collega» a destra)', () => {
    const root = htmlOf(createElement(AddProviderSheet, { onClose: () => undefined, onSaved: () => undefined }))
    const foglio = byTag(root, 'strong')[0]!.parent!.parent!
    expect(has(foglio, 'rounded-surface', 'bg-card')).toBe(true)
    expect(classes(foglio)).not.toContain('rounded-3xl')
    const titolo = byTag(root, 'strong')[0]!
    expect(has(titolo, 'text-title', 'font-semibold')).toBe(true)
    expect(classes(titolo)).not.toContain('font-display')
    expect(textOf(titolo)).toBe('Aggiungi provider')
    // la ricerca: una pillola alta 36 col campo dentro (senza bordi suoi)
    const cerca = byTag(root, 'input')[0]!
    expect(cerca.attrs.placeholder).toBe('Cerca (Ollama, Anthropic…)')
    expect(has(cerca.parent!, 'h-control', 'rounded-full')).toBe(true)
    expect(has(cerca, 'text-body', 'outline-none', 'bg-transparent')).toBe(true)
    // le etichette di gruppo: l\u2019intestazione di gruppo del sistema
    for (const nome of ['Sul tuo Mac', 'Con una chiave', 'Un altro server']) {
      const etichetta = byTag(root, 'h3').filter((n) => textOf(n) === nome)[0]
      expect(etichetta, nome).toBeTruthy()
      expect(has(etichetta!, 'text-caption', 'font-medium', 'text-muted-foreground'), nome).toBe(true)
    }
    // le righe: FlatRow che si aprono, col logo nello slot da 32 e «Collega» a destra
    const righe = findAll(root, (n) => n.attrs.role === 'button')
    expect(righe.length).toBeGreaterThanOrEqual(5)
    for (const riga of righe) {
      expect(has(riga, 'min-h-row', 'py-row-pad', 'gap-row-gap'), textOf(riga)).toBe(true)
      expect(has(byTag(riga, 'span')[0]!, 'size-8', 'shrink-0', 'place-items-center')).toBe(true)
      expect(textOf(riga)).toContain('Collega')
    }
    // il nome è il titolo della riga (le sonde leggono i bottoni per nome: qui è un nodo suo)
    const titoli = righe.map((r) => byTag(r, 'span').map(textOf))
    expect(titoli.some((t) => t.includes('Ollama'))).toBe(true)
    expect(titoli.some((t) => t.includes('Anthropic'))).toBe(true)
    // a filo: niente riquadri intorno alle righe
    expect(findAll(righe[0]!.parent!, () => true).filter((n) => n !== righe[0]).length).toBeGreaterThan(0)
    const classi = classiSenzaPezzi(root)
    expect(classi.filter((c) => OFF_SYSTEM_SIZE.test(c))).toEqual([])
    expect(classi.filter((c) => RADIUS_OFF_SYSTEM.test(c))).toEqual([])
    expect(classi.filter((c) => MEASURE_OFF_SYSTEM.test(c))).toEqual([])
    expect(iconsOffSize(root)).toEqual([])
  })

  it('passo 2 (tipi con una chiave): i campi sono Input da 36 (l\u2019id della chiave resta), «Collega …» la pillola piena larga quanto il foglio, «Indietro» un bottone tondo da 32', () => {
    const root = htmlOf(createElement(AddProviderSheet, { initialKind: 'anthropic', onClose: () => undefined, onSaved: () => undefined }))
    const chiave = findAll(root, (n) => n.attrs.id === 'sandbot-addprovider-key')[0]!
    expect(has(chiave, 'h-control', 'rounded-control', 'text-body')).toBe(true)
    const indietro = byTag(root, 'button').filter((b) => b.attrs['aria-label'] === 'Indietro')[0]!
    expect(has(indietro, 'h-control-sm', 'w-control-sm', 'rounded-full')).toBe(true)
    expect(has(byTag(indietro, 'svg')[0]!, 'size-4')).toBe(true)
    const collega = byTag(root, 'button').filter((b) => textOf(b).startsWith('Collega Anthropic'))[0]!
    expect(has(collega, 'h-control', 'rounded-full', 'bg-foreground', 'w-full')).toBe(true)
    expect(textOf(root)).toContain('La chiave resta nel Portachiavi del Mac.')
    const classi = classiSenzaPezzi(root)
    expect(classi.filter((c) => OFF_SYSTEM_SIZE.test(c))).toEqual([])
    expect(classi.filter((c) => RADIUS_OFF_SYSTEM.test(c))).toEqual([])
    expect(classi.filter((c) => MEASURE_OFF_SYSTEM.test(c))).toEqual([])
    expect(iconsOffSize(root)).toEqual([])
  })

  it('passo 2 (sul tuo Mac): «Cerca di nuovo» la pillola piena; i risultati righe a filo con «Collegato»', () => {
    const root = htmlOf(createElement(AddProviderSheet, { initialKind: 'ollama', onClose: () => undefined, onSaved: () => undefined }))
    const cerca = byTag(root, 'button').filter((b) => textOf(b) === 'Cerca di nuovo')[0]!
    expect(has(cerca, 'h-control', 'rounded-full', 'bg-foreground', 'w-full')).toBe(true)
    expect(textOf(root)).toContain('Cerco Ollama sul tuo Mac (porta 11434).')
  })
})

describe('DS4 Impostazioni: «Uso e costi»', () => {
  const ROWS = [
    { providerId: 'p1', providerKind: 'openai-compatible', model: 'finto', calls: 69, input: 2496, output: 336, cacheRead: 0, cacheWrite: 0, costUsd: 0.0123, costPartial: true, source: 'turn', agentId: 'a1', agentName: 'Bot' },
    { providerId: 'p2', providerKind: 'ollama', model: 'locale-x', calls: 3, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: null, costPartial: false, source: 'routine-suggest', agentId: null, agentName: null }
  ]

  it('nel dialogo: due segmenti (il periodo, la vista) e i quattro numeri — etichette text-caption, numeri a 20 px', () => {
    const root = renderTab('uso')
    const gruppi = findAll(root, (n) => n.attrs.role === 'radiogroup')
    expect(gruppi).toHaveLength(2)
    expect(byTag(gruppi[0]!, 'button').map(textOf)).toEqual(['Oggi', '7 giorni', '30 giorni', 'Questo mese'])
    expect(byTag(gruppi[0]!, 'button').map((b) => b.attrs['aria-checked'])).toEqual(['false', 'true', 'false', 'false'])
    expect(byTag(gruppi[1]!, 'button').map(textOf)).toEqual(['per modello', 'per bot', 'per origine'])
    const dentro = settingsScroller(root)
    // niente maiuscoletto: le etichette restano scritte come sono (minuscole comprese)
    expect(findAll(dentro, (n) => has(n, 'truncate', 'text-caption')).map(textOf)).toEqual(['chiamate', 'token in', 'token out', 'costo totale'])
    const numeri = findAll(dentro, (n) => has(n, 'text-title', 'tabular-nums'))
    expect(numeri.map(textOf)).toEqual(['0', '0', '0', '$0,000'])
    for (const n of numeri) expect(has(n, 'truncate')).toBe(true)
    expect(classes(numeri[3]!.parent!).some((c) => c === 'bg-foreground')).toBe(true)
    expect(textOf(dentro)).toContain('caricamento…')
    // DENTRO il contenuto: niente maiuscoletto, e il font dei titoli di pagina non compare (è solo del titolo, nella riga ferma)
    const classi = everyClass(dentro).filter((c) => !DEI_PEZZI_NON_MIGRATI.has(c))
    expect(classi.filter((c) => OFF_SYSTEM_SIZE.test(c))).toEqual([])
    expect(classi.filter((c) => /(?:^|\s)uppercase$|tracking-|font-display/.test(c)), 'niente maiuscoletto, e il font dei titoli solo sul titolo').toEqual([])
    expect(classi.filter((c) => RADIUS_OFF_SYSTEM.test(c))).toEqual([])
    expect(classi.filter((c) => MEASURE_OFF_SYSTEM.test(c))).toEqual([])
  })

  it('la tabella è DataTable: intestazioni text-caption grigie in tono normale e su una riga, i numeri a destra, «parziale» il dettaglio grigio, «locale» una cella secondaria', () => {
    setStoreStateForRender(useStore, { providers: [] } as never)
    const root = htmlOf(createElement(UsageTab, { initial: { rows: ROWS, modelRows: [], prices: {} } as never }))
    const table = byTag(root, 'table')[0]!
    // se non ci sta scorre DENTRO la tabella: mai la pagina
    expect(has(table.parent!, 'overflow-x-auto', 'scroll-thin')).toBe(true)
    expect(has(table, 'w-full', 'table-fixed', 'text-left')).toBe(true)
    const th = byTag(table, 'th')
    expect(th.map(textOf)).toEqual(['modello', 'chiamate', 'token in', 'token out', 'cache', 'costo'])
    for (const h of th) {
      expect(has(h, 'text-caption', 'text-muted-foreground', 'font-normal', 'whitespace-nowrap'), textOf(h)).toBe(true)
      expect(classes(h), textOf(h)).not.toContain('uppercase')
    }
    expect(th.map((h) => classes(h).includes('text-right'))).toEqual([false, true, true, true, true, true])
    const righe = byTag(byTag(table, 'tbody')[0]!, 'tr')
    expect(righe).toHaveLength(2)
    for (const r of righe) expect(has(r, 'h-row', 'border-t', 'border-border/50')).toBe(true)
    const celle = byTag(righe[0]!, 'td')
    expect(celle.map((c) => classes(c).includes('text-right'))).toEqual([false, true, true, true, true, true])
    for (const c of celle) expect(has(c, 'py-row-pad')).toBe(true)
    expect(textOf(celle[0]!)).toBe('openai-compatible:finto')
    expect(has(byTag(celle[0]!, 'span')[1]!, 'font-mono')).toBe(true)
    // i numeri come li scrive la lingua dell'interfaccia (in italiano: 2.496)
    expect(celle.slice(1, 5).map(textOf)).toEqual(['69', (2496).toLocaleString('it'), '336', '0'])
    // «parziale» (qualche chiamata senza prezzo) è il dettaglio grigio accanto al costo
    expect(byTag(celle[5]!, 'span').map(textOf)).toEqual(['$0,012parziale', '$0,012', 'parziale'])
    expect(has(byTag(celle[5]!, 'span')[2]!, 'text-small', 'text-muted-foreground')).toBe(true)
    // una riga per cella: le righe restano da 52
    for (const c of celle) expect(byTag(c, 'span')[0]!.children.every((n) => n.tag === 'span')).toBe(true)
    const celleLocali = byTag(righe[1]!, 'td')
    // «locale» (un modello senza prezzo) non è una cifra: cella secondaria
    expect(textOf(celleLocali[5]!)).toBe('locale')
    expect(has(byTag(celleLocali[5]!, 'span')[0]!, 'text-small', 'text-muted-foreground')).toBe(true)
    expect(textOf(celleLocali[0]!)).toContain('locale-x')
    expect(textOffSystem(root)).toEqual([])
    expect(radiusOffSystem(root)).toEqual([])
    expect(measureOffSystem(root)).toEqual([])
  })

  /** Le celle di una tabella resa: per riga, il testo di ogni cella. */
  const celleDi = (root: HtmlNode): string[][] => byTag(byTag(root, 'tbody')[0]!, 'tr').map((tr) => byTag(tr, 'td').map((td) => textOf(td)))
  const intestazioniDi = (root: HtmlNode): string[] => byTag(byTag(root, 'table')[0]!, 'th').map(textOf)

  it('le tre viste cambiano l\u2019intestazione e il nome della prima colonna; senza chiamate lo dice, senza tabella', () => {
    const perBot = htmlOf(createElement(UsageTab, { initial: { view: 'agent', rows: ROWS, modelRows: [], prices: {} } as never }))
    expect(intestazioniDi(perBot)[0]).toBe('bot')
    expect(celleDi(perBot).map((riga) => riga[0])).toEqual(['Bot', 'Sistema'])
    const perOrigine = htmlOf(createElement(UsageTab, { initial: { view: 'source', rows: ROWS, modelRows: [], prices: {} } as never }))
    expect(intestazioniDi(perOrigine)[0]).toBe('origine')
    expect(celleDi(perOrigine).map((riga) => riga[0])).toEqual(['turno', 'suggerimento routine'])
    const senza = htmlOf(createElement(UsageTab, { initial: { rows: [], modelRows: [], prices: {} } as never }))
    expect(byTag(senza, 'table')).toEqual([])
    expect(textOf(senza)).toContain('Nessuna chiamata nel periodo.')
  })
})
