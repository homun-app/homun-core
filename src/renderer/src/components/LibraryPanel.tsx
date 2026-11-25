// La LIBRERIA (fase 14, punti 1-5 → fase 16c C6, tavola 4 destra): la vista
// globale con i filtri «Tutti i bot ▾» e «Tutti i tipi ▾», la ricerca per
// titolo, la scelta griglia ▦ / elenco ☰ (ricordata in localStorage con
// try/catch), le schede con l'anteprima (le prime righe dei documenti, la
// miniatura dei grafici, l'estensione dei file), il titolo e «Tipo · Bot ·
// quando». Fase pagine (G5): le righe di DOCUMENTO aprono la PAGINA (G2) che
// torna qui, e l'etichetta dice «Pagina» (nei filtri pure); lo storico con
// versioni, esporta, rinomina e «Ripristina» resta la vista di oggi (ci porta
// la riga della versione della pagina). Il corpo del documento (Markdown +
// blocchi grafico, Vega-Lite e Mermaid SEMPRE <img>) vive in
// DocumentMarkdown, condiviso con la pagina aperta.
//
// B4 (fase b20-bug) — Elimina, Archivia, anteprime pulite:
//  · OGNI voce in griglia e in lista ha il menu «⋯» dell'app con le sei voci
//    della spec, in ordine: Apri · Rinomina · Fissa/Sblocca · Esporta ·
//    Archivia · Elimina. Lo stesso menu (LibraryItemMenu) sta nella pagina
//    aperta (PageView) e nella vista di una voce (LibraryItemView).
//  · Elimina NON usa il confirm() del browser: la finestra di conferma
//    dell'app, come l'«Elimina?» della barra — «Eliminare «titolo»? Non si
//    può annullare.». Anche la rinomina è una finestra (in griglia non c'è
//    una riga in cui scrivere).
//  · Archivia nasconde e basta: la voce resta (riga, file, versioni) e si
//    legge ancora; sparisce dalla vista normale e sta sotto il filtro
//    «Archiviati» in testa, da cui si ripristina («Ripristina» al posto di
//    «Archivia»). Il daemon decide la lista (library:list col terzo
//    argomento) e libraryRows la ripulisce lo stesso: una lista rimasta in
//    mano un istante non mostra mai le archiviate nella vista normale.
//  · Selezione multipla: ⌘/Ctrl-clic e Maiusc-clic in griglia e in lista, la
//    casella in lista; da DUE selezionate la barra «N selezionati» con
//    Archivia (Ripristina, tra gli archiviati) ed Elimina — UNA conferma che
//    dice quanti. Le funzioni pure stanno in lib/library-view.
//
// Fase design (DS4) — la Libreria passa al sistema, con una scheda sola:
//  · il guscio è PageShell (larghezza «page»): la testata di PageHeader —
//    indietro · icona · titolo · griglia/elenco — sulla riga dei 52 di OGNI
//    colonna; la ricerca e i filtri nella barra degli strumenti, ferma sotto
//    (prima stavano in testa e andavano a capo, la ricerca su una riga sua);
//    il corpo che scorre largo quanto l'area, col contenuto centrato. Addio
//    alla colonna max-w-4xl scritta a mano.
//  · la scheda (rounded-surface, bordo, bg-card): titolo, la zona
//    dell'anteprima ALTA QUATTRO RIGHE (LibraryPreview: il perché sta lì),
//    i metadati in fondo. Le righe sono quelle di DOC_CARD, le STESSE della
//    scheda in chat (LibraryCards): una scheda sola in tutto l'app.
//  · la lista è FlatList/FlatRow: l'icona del tipo nello slot da 32, il
//    titolo, i metadati come seconda riga, la data a destra.
//  · i «⋯», «Riprova», «Esci dalla selezione» e le azioni dei dialoghi sono
//    Button (il bottone unico); nella testata i controlli sono da 32.
//  · il «★» dei fissati e i glifi «⚠» e «↩» diventano icone lucide (DS1:
//    solo icone lucide nell'interfaccia). I testi perdono il glifo, non il
//    senso: «⚠ esterno» è l'icona dell'avviso e «esterno».
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLingui, Trans, Plural } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { formatDate } from '../lib/i18n'
import { BarChart3, File as FileIcon, FileText, LayoutGrid, Library, List, MoreHorizontal, Search, Star, TriangleAlert, Undo2, X } from 'lucide-react'
import { api, useStore } from '../store'
// fase pagine (G2): il corpo del documento, condiviso con la pagina aperta
import { DocumentBody, InlineChart, svgDataUrl } from './DocumentMarkdown'
// B4: le pure della vista (filtri, ordine, «Archiviati») e della selezione
import {
  libraryRows, libraryListArgs, libraryClickIntent, librarySelectionAfter, librarySelectionVisible,
  LIBRARY_SELECTION_EMPTY, type LibraryKindFilter, type LibrarySelection
} from '../lib/library-view'
// fase design (DS4): le righe di TESTO dell'anteprima di una scheda (mai
// markdown grezzo; il `# ` che è già il titolo non si ripete)
import { previewLines } from '../lib/page-view'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger
} from './ui/dropdown-menu'
import { FlatList, FlatRow } from './ui/flat-list'
import { PageHeader } from './ui/page-header'
import { PageShell } from './ui/page-shell'
import type { LibraryItemInfo, LibraryContentInfo, SandbotApi } from '../../../shared/types'

/** La scelta griglia/elenco resta nel localStorage (try/catch: può mancare). */
const LIBRARY_VIEW_KEY = 'sandbot:library.view'
type LibraryView = 'grid' | 'list'
function readLibraryView(): LibraryView {
  try {
    return localStorage.getItem(LIBRARY_VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}
function writeLibraryView(v: LibraryView): void {
  try {
    localStorage.setItem(LIBRARY_VIEW_KEY, v)
  } catch {
    // localStorage non disponibile: la scelta dura finché la finestra vive
  }
}

/** Il tipo di una voce in una riga («Grafico · Contabile · oggi»). */
const KIND_LABEL: Record<LibraryItemInfo['kind'], MessageDescriptor> = {
  // fase pagine (G5): il documento si chiama Pagina, ovunque
  document: msg`Pagina`,
  chart: msg`Grafico`,
  file: msg`File`
}

/**
 * Fase design (DS4): LE RIGHE DELLA SCHEDA DI UN DOCUMENTO — titolo, anteprima,
 * metadati — scritte UNA volta sola. La scheda della Libreria (la griglia,
 * qui sotto) e quella della chat (LibraryCards, DocumentCard) sono la stessa:
 * cambiare una riga qui le cambia insieme. `focus` è l'anello del fuoco della
 * superficie che si apre (solo da tastiera).
 */
export const DOC_CARD = {
  /** il titolo: due righe al massimo, il titolo di riga di DS1 (text-body, peso medio) */
  title: 'line-clamp-2 text-body font-medium break-words',
  /** l'anteprima: quattro righe al massimo, grigia; una riga del documento resta sulla sua riga (pre-line) */
  preview: 'line-clamp-4 whitespace-pre-line text-small text-muted-foreground',
  /** i metadati, in fondo alla scheda */
  meta: 'text-caption text-muted-foreground',
  /** l'anello del fuoco VERSO L'INTERNO: la scheda sta in una griglia che ritaglia, uno fuori dal bordo ai lati sparirebbe */
  focus: 'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'
} as const

/**
 * Il CAMPO di DS1 (la ricerca e i filtri della barra degli strumenti, il campo
 * della finestra di Rinomina): 36 px, il raggio dei campi, fondo tenue,
 * text-body.
 */
const FIELD = 'h-control shrink-0 rounded-control bg-muted px-3 text-body transition'

/**
 * L'anello del fuoco del campo, SOLO da tastiera (focus-visible: la variante è
 * quella di B5, che non scatta dopo un clic del mouse). Aderente, senza lo
 * stacco di 2 px che hanno i bottoni: nella barra degli strumenti la riga è
 * alta 40 e il campo 36, e l'anello con lo stacco finirebbe sotto la testata.
 */
const FIELD_FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** L'icona del tipo di una voce, da 16 px: va nello slot da 32 della riga (FlatRow). */
function kindIcon(kind: LibraryItemInfo['kind']): ReactNode {
  if (kind === 'chart') return <BarChart3 className="size-4" />
  if (kind === 'file') return <FileIcon className="size-4" />
  return <FileText className="size-4" />
}

/** I formati di esportazione di una voce (come prepareLibraryExport del daemon). */
function exportFormatsOf(item: LibraryItemInfo): string[] {
  if (item.kind === 'document') return ['md', 'html', 'pdf']
  if (item.kind === 'chart') return [item.chartKind === 'mermaid' ? 'mmd' : 'svg']
  return ['file']
}

/** Un'azione dell'utente su una o più voci (Elimina e Archivia dalla UI, mai dai bot). */
export type LibraryAction = 'archive' | 'restore' | 'delete'

/**
 * B4: esegue un'azione su più voci, una dopo l'altra — una che fallisce NON
 * ferma le altre, e gli errori tornano a chi li mostra (la riga d'errore
 * della lista, la pagina aperta). L'api entra come parametro: la funzione è
 * la stessa per la lista, la pagina e i test.
 */
export async function runLibraryAction(
  api: Pick<SandbotApi, 'libraryDelete' | 'libraryArchive'>,
  ids: readonly string[],
  action: LibraryAction
): Promise<Array<{ id: string; error: string }>> {
  const errors: Array<{ id: string; error: string }> = []
  for (const id of ids) {
    try {
      if (action === 'delete') await api.libraryDelete(id)
      else await api.libraryArchive(id, action === 'archive')
    } catch (e) {
      errors.push({ id, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return errors
}

/** Il testo degli errori di un'azione (separati da «; »), o null se è andata tutta liscia. */
function errorTextOf(errors: readonly { error: string }[]): string | null {
  return errors.length ? errors.map((e) => e.error).join('; ') : null
}

/**
 * Lo stato di partenza dei test (render statico, senza effect): il
 * componente vero non lo passa mai. Ogni campo è lo stato in cui sarebbe il
 * componente dopo un'azione — così le finestre e la barra si leggono nell'HTML.
 */
export interface LibraryPanelInitial {
  items?: LibraryItemInfo[]
  view?: LibraryView
  /** il filtro «Archiviati» acceso */
  archived?: boolean
  /** le voci selezionate */
  selected?: string[]
  /** la finestra di Elimina già aperta su UNA voce (dal suo «⋯») */
  confirmDeleteId?: string
  /** la finestra di Elimina già aperta su PIÙ voci (dalla barra) */
  confirmDeleteIds?: string[]
  /** la finestra di Rinomina già aperta su una voce, col titolo scritto */
  rename?: { id: string; title?: string }
  /** la riga d'errore di un'azione fallita */
  error?: string
}

export function LibraryPanel({ initial }: { initial?: LibraryPanelInitial } = {}) {
  const openLibraryId = useStore((s) => s.openLibraryId)
  if (openLibraryId === null) return null
  // fase design (DS4): ogni vista è un guscio intero, e tutte e due portano il
  // testid della radice (lo cercano le sonde). La radice di PageShell è
  // no-drag: la vista sta SOPRA la fascia di trascinamento della chat, che
  // Electron calcola ignorando lo z-index — senza, la freccia ‹ in alto cade
  // dentro la fascia e il clic trascina la finestra. «» è la lista; un id,
  // la vista di quella voce.
  return openLibraryId === '' ? <LibraryList initial={initial} /> : <LibraryItemView id={openLibraryId} />
}

/** Le larghezze delle righe spente dell'anteprima (in %), mentre il testo arriva. */
const PREVIEW_SKELETON = [70, 90, 80, 50]

/**
 * La zona dell'anteprima nella scheda (quattro righe: la misura la mette la
 * scheda, con h-18). PERCHÉ una zona di misura fissa: le schede di una riga
 * della griglia hanno così i metadati sulla STESSA linea, qualunque cosa
 * mostrino — un documento di quattro righe o di una sola, la miniatura di un
 * grafico, l'estensione di un file — e l'occhio le scorre senza saltare.
 * (L'altezza uguale fra sorelle la dà la griglia, che allunga ogni scheda
 * alla più alta: qui si allineano le righe DENTRO.)
 * Documenti: le prime righe di TESTO (previewLines), lette una volta per
 * voce; grafici Vega-Lite: la miniatura; file: l'estensione. Il contenuto è
 * aria-hidden: è un'anteprima, il titolo e i metadati dicono già tutto.
 */
function LibraryPreview({ item }: { item: LibraryItemInfo }) {
  const [lines, setLines] = useState<string[] | null>(null)
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setLines(null)
    setSvg(null)
    if (item.kind === 'document') {
      // B4: ogni riga passa da previewLineText — anche quelle di tabella (mai |---|---| né | Ricetta | Data |)
      void api.libraryGet(item.id).then((c) => { if (alive) setLines(previewLines(c.content ?? '', item.title)) }).catch(() => undefined)
    } else if (item.kind === 'chart' && item.chartKind === 'vega-lite') {
      void api.libraryGet(item.id).then((c) => { if (alive) setSvg(c.svg ?? null) }).catch(() => undefined)
    }
    return () => { alive = false }
  }, [item.id, item.kind, item.chartKind, item.updatedAt, item.title])

  if (item.kind === 'chart') {
    if (svg) return <img className="h-full w-full rounded-control object-contain p-2" src={svgDataUrl(svg)} alt="" aria-hidden="true" />
    return (
      <div className="grid h-full w-full place-items-center text-muted-foreground/60" aria-hidden="true">
        <svg width="72" height="48" viewBox="0 0 80 56"><path d="M4 48 L22 30 L36 38 L54 14 L76 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /></svg>
      </div>
    )
  }
  if (item.kind === 'document') {
    return (
      <span className="flex h-full w-full flex-col gap-1.5" aria-hidden="true">
        {lines === null
          // in attesa del testo: quattro righe spente, alte quanto quelle vere
          ? PREVIEW_SKELETON.map((w, i) => <span key={i} className="h-3 rounded-full bg-muted-foreground/20" style={{ width: `${w}%` }} />)
          : <span className={DOC_CARD.preview}>{lines.join('\n')}</span>}
      </span>
    )
  }
  // file: l'estensione
  const ext = (item.fileName ?? '').split('.').pop()?.toUpperCase() || 'FILE'
  return <span className="grid h-full w-full place-items-center text-title font-semibold text-chart-2/80" aria-hidden="true">.{ext.toLowerCase()}</span>
}

function LibraryList({ initial }: { initial?: LibraryPanelInitial }) {
  const { t, i18n } = useLingui()
  // fase pagine (G5): le righe di documento aprono la PAGINA (che torna qui)
  const openPage = useStore((s) => s.openPage)
  const [items, setItems] = useState<LibraryItemInfo[]>(initial?.items ?? [])
  const [kind, setKind] = useState<LibraryKindFilter>('')
  const [author, setAuthor] = useState('')
  const [stats, setStats] = useState<{ bytes: number; warn: boolean } | null>(null)
  const [view, setView] = useState<LibraryView>(initial?.view ?? readLibraryView)
  // fase 16c correzioni (R1): un RPC che fallisce non è «libreria vuota» —
  // riga d'errore con Riprova, mai lo stato vuoto in silenzio
  const [failed, setFailed] = useState(false)
  const agents = useStore((s) => s.agents)
  const openLibrary = useStore((s) => s.openLibrary)
  const [q, setQ] = useState('')
  // B4: il filtro «Archiviati» — la vista normale non ha le archiviate
  const [archived, setArchived] = useState(initial?.archived ?? false)
  // B4: la selezione multipla (le voci e l'ancora), la finestra di Elimina
  // della barra e la riga d'errore di un'azione
  const [selection, setSelection] = useState<LibrarySelection>(() => {
    const s = initial?.selected ?? []
    return s.length ? { selected: new Set(s), anchor: null } : LIBRARY_SELECTION_EMPTY
  })
  const [bulkConfirm, setBulkConfirm] = useState<{ ids: string[] } | null>(() => {
    const ids = initial?.confirmDeleteIds ?? []
    return ids.length ? { ids } : null
  })
  const [actionError, setActionError] = useState<string | null>(initial?.error ?? null)

  const refresh = async () => {
    try {
      setItems(await api.libraryList(...libraryListArgs(q, archived)))
      setFailed(false)
    } catch {
      setFailed(true)
    }
    setStats(await api.libraryStats().catch(() => null))
  }
  useEffect(() => { void refresh() }, [q, archived]) // eslint-disable-line react-hooks/exhaustive-deps

  // fase 16c (C6): filtro per bot e tipo e ordine (fissati in cima) — PURA.
  // B4: il filtro «Archiviati» decide la stessa funzione
  const shown = useMemo(() => libraryRows(items, author, kind, archived), [items, author, kind, archived])
  // B4: i bot dei quali ci sono voci in QUESTA vista (tra gli archiviati, solo quelli con voci archiviate)
  const authors = useMemo(
    () => [...new Set(items.filter((i) => (archived ? i.archived === true : i.archived !== true)).map((i) => i.authorAgentId))],
    [items, archived]
  )
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id

  // B4: valgono solo le voci che si vedono — una selezionata che il filtro o
  // la ricerca hanno nascosto non conta più (lo stato lo segue al giro dopo)
  const live = useMemo(() => librarySelectionVisible(selection, shown.map((i) => i.id)), [selection, shown])
  useEffect(() => {
    if (live.selected.size !== selection.selected.size || live.anchor !== selection.anchor) setSelection(live)
  }, [live, selection])
  /** Le selezionate che si vedono, nell'ordine della vista: valgono per le azioni della barra. */
  const bulkIds = useMemo(() => shown.filter((i) => live.selected.has(i.id)).map((i) => i.id), [shown, live])
  const clearSelection = (): void => setSelection(LIBRARY_SELECTION_EMPTY)
  const applyClick = (id: string, intent: 'toggle' | 'range'): void => {
    setSelection(librarySelectionAfter(shown.map((i) => i.id), live, id, intent))
  }
  // B4: il clic su una voce — normale apre; ⌘/Ctrl seleziona o deseleziona; Maiusc fa l'intervallo dall'ancora
  const onItemOpen = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }, i: LibraryItemInfo): void => {
    const intent = libraryClickIntent(e)
    if (intent !== 'open') { applyClick(i.id, intent); return }
    if (i.kind === 'document') { openLibrary(null); openPage(i.id, 'library') } else openLibrary(i.id)
  }
  // …e un clic di selezione non fa anche la selezione del TESTO del browser (Maiusc-clic non tinge mezza lista)
  const onItemMouseDown = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; preventDefault(): void }): void => {
    if (libraryClickIntent(e) !== 'open') e.preventDefault()
  }

  // B4: Esc esce dalla selezione — SOLO finché c'è una selezione, e solo se
  // nessun altro ha già consumato il tasto (l'Esc di un menu Radix o di una
  // finestra chiude QUELLO, come in PageView)
  useEffect(() => {
    if (live.selected.size === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target
      if (target instanceof Element && target.closest('[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]')) return
      e.preventDefault()
      clearSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [live.selected.size]) // eslint-disable-line react-hooks/exhaustive-deps

  // B4: le azioni della barra — per le selezionate che si vedono, una dopo l'altra; poi si esce dalla selezione
  const runBulk = async (action: LibraryAction, ids: string[] = bulkIds): Promise<void> => {
    setBulkConfirm(null)
    const errors = await runLibraryAction(api, ids, action)
    setActionError(errorTextOf(errors))
    clearSelection()
    await refresh()
  }
  const toggleArchived = (): void => {
    // la selezione non attraversa le due viste (le voci cambierebbero da sotto), e l'errore di un'azione resta nella vista in cui è nato
    setArchived((a) => !a)
    setActionError(null)
    clearSelection()
  }

  // fase design (DS4): l'interruttore griglia/elenco sta nella testata, a
  // destra — due bottoni tondi da 32 dentro una rotaia tonda, come le altre
  // icone delle testate. Stanno nella fascia che trascina la finestra: ognuno
  // porta no-drag, o il clic servirebbe a trascinarla.
  const viewToggle = (
    <div role="group" aria-label={t`Vista`} className="flex items-center rounded-full bg-muted p-0.5">
      <Button
        variant="ghost"
        icon
        size="sm"
        aria-label={t`Griglia`}
        className={cn('no-drag', view === 'grid' && 'bg-card text-foreground hover:text-foreground')}
        onClick={() => { setView('grid'); writeLibraryView('grid') }}
      >
        <LayoutGrid className="size-4" />
      </Button>
      <Button
        variant="ghost"
        icon
        size="sm"
        aria-label={t`Elenco`}
        className={cn('no-drag', view === 'list' && 'bg-card text-foreground hover:text-foreground')}
        onClick={() => { setView('list'); writeLibraryView('list') }}
      >
        <List className="size-4" />
      </Button>
    </div>
  )

  return (
    <PageShell
      width="wide"
      testId="library-panel"
      header={
        <PageHeader
          back={{ onClick: () => openLibrary(null), label: t`Torna alla chat` }}
          icon={<Library className="size-5" />}
          title={<Trans>Libreria</Trans>}
          actions={viewToggle}
        />
      }
      // la riga va a capo da sola dove l'area è stretta (il pannello del bot
      // agganciato accanto): la ricerca resta intera, i filtri passano sotto
      toolbar={
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              className={cn(FIELD, FIELD_FOCUS, 'w-full pl-10 placeholder:text-muted-foreground')}
              placeholder={t`Cerca per titolo…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select
            className={cn(FIELD, FIELD_FOCUS, 'max-w-48')}
            value={author}
            aria-label={t`Tutti i bot`}
            data-testid="library-filter-bot"
            onChange={(e) => setAuthor(e.target.value)}
          >
            <option value="">{t`Tutti i bot`}</option>
            {authors.map((a) => <option key={a} value={a}>{nameOf(a)}</option>)}
          </select>
          <select
            className={cn(FIELD, FIELD_FOCUS)}
            value={kind}
            aria-label={t`Tutti i tipi`}
            onChange={(e) => setKind(e.target.value as LibraryKindFilter)}
          >
            <option value="">{t`Tutti i tipi`}</option>
            <option value="document">{i18n.t(msg`Pagina`)}</option>
            <option value="chart">{i18n.t(msg`Grafico`)}</option>
            <option value="file">{i18n.t(msg`File`)}</option>
          </select>
          {/* B4: il filtro «Archiviati» — un interruttore; acceso, la vista mostra solo le archiviate.
              Il bordo c'è sempre (trasparente, da spento): così acceso e spento hanno la stessa misura */}
          <button
            type="button"
            aria-pressed={archived}
            data-testid="library-filter-archived"
            className={cn(FIELD, FIELD_FOCUS, 'border', archived ? 'border-border bg-card text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
            onClick={toggleArchived}
          >
            <Trans>Archiviati</Trans>
          </button>
        </div>
      }
      contentClassName="flex flex-col gap-block pt-4 pb-6"
    >
      {/* B4: le azioni sulle voci selezionate — da DUE in su */}
      {bulkIds.length >= 2 && (
        <div
          role="region"
          aria-label={t`Azioni sulle voci selezionate`}
          data-testid="library-bulk-bar"
          className="flex items-center gap-3 rounded-control border bg-card px-3 py-1.5"
        >
          <span className="text-body font-medium"><Trans>{bulkIds.length} selezionati</Trans></span>
          <span className="min-w-2 flex-1" />
          <Button
            variant="secondary"
            size="sm"
            data-testid={archived ? 'library-bulk-restore' : 'library-bulk-archive'}
            onClick={() => void runBulk(archived ? 'restore' : 'archive')}
          >
            {archived ? <Trans>Ripristina</Trans> : <Trans>Archivia</Trans>}
          </Button>
          <Button variant="destructive" size="sm" data-testid="library-bulk-delete" onClick={() => setBulkConfirm({ ids: bulkIds })}>
            <Trans>Elimina</Trans>
          </Button>
          <Button
            variant="ghost"
            icon
            size="sm"
            aria-label={t`Esci dalla selezione`}
            title={t`Esci dalla selezione`}
            data-testid="library-selection-clear"
            onClick={clearSelection}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}
      {/* B4: l'errore di un'azione (una voce che non c'è più, …): si mostra, non si ignora */}
      {actionError !== null && (
        <p role="alert" className={ALERT_ROW} data-testid="library-error">{actionError}</p>
      )}
      {stats?.warn && (
        <p className={ALERT_ROW}>
          <Trans>La libreria supera 2 GB: valuta cosa cancellare (nessun blocco automatico).</Trans>
        </p>
      )}
      {failed ? (
        <div className={cn('flex items-center gap-2 text-body text-muted-foreground', !items.length && 'justify-center pt-16')}>
          <Trans>Non riesco a leggere la libreria</Trans>
          <Button variant="ghost" size="sm" onClick={() => { void refresh() }}><Trans>Riprova</Trans></Button>
        </div>
      ) : shown.length === 0 && (
        <p className="pt-16 text-center text-body text-muted-foreground">
          {/* B4: tra gli archiviati la frase è sua — la libreria è vuota, non c'è niente di archiviato */}
          {archived
            ? <Trans>Nessun documento archiviato.</Trans>
            : <Trans>La libreria è vuota: i documenti, i grafici e i file che i bot preparano finiscono qui.</Trans>}
        </p>
      )}
      {/* la griglia: schede alte uguali (la griglia allunga ognuna alla più alta della sua riga).
          Due colonne, tre quando l'AREA passa i 768 px (una query sul contenitore di PageShell):
          il minimo dell'area è 520, e lì due colonne restano sopra i 220 px */}
      {view === 'grid' ? (
        <div className="grid grid-cols-2 gap-4 @3xl:grid-cols-3">
          {shown.map((i) => (
            <div
              key={i.id}
              data-testid="library-card"
              data-id={i.id}
              className={cn('relative flex flex-col rounded-surface border bg-card p-4 transition hover:bg-muted/50', live.selected.has(i.id) && 'ring-2 ring-primary')}
            >
              <button
                type="button"
                className={cn('flex w-full flex-1 flex-col gap-2 rounded-control text-left', DOC_CARD.focus)}
                data-testid={`library-open-${i.id}`}
                onClick={(e) => onItemOpen(e, i)}
                onMouseDown={onItemMouseDown}
              >
                {/* pr-10: lo spazio del «⋯» in alto a destra — il titolo non ci passa sotto.
                    L'asterisco dei fissati è un'icona lucide, rossa e piena come il glifo «★» di prima */}
                <span className="flex items-start gap-1.5 pr-10">
                  {i.pinned && <Star className="mt-0.5 size-4 shrink-0 fill-current text-destructive" aria-hidden="true" />}
                  <span className={DOC_CARD.title} title={i.title}>{i.title}</span>
                </span>
                <span className="flex h-18 w-full flex-col">
                  <LibraryPreview item={i} />
                </span>
                <span className={cn(DOC_CARD.meta, 'mt-auto truncate')}>
                  {i18n.t(KIND_LABEL[i.kind])} · {nameOf(i.authorAgentId)} · {formatDate(i.updatedAt)}
                </span>
              </button>
              {/* B4: il «⋯» della voce, in alto a destra della card (sempre visibile) */}
              <LibraryItemMenu
                item={i}
                where="grid"
                className="absolute top-2 right-2"
                onChanged={() => void refresh()}
                onError={setActionError}
                initialConfirmDelete={initial?.confirmDeleteId === i.id}
                initialRename={initial?.rename?.id === i.id ? initial.rename.title ?? i.title : undefined}
              />
            </div>
          ))}
        </div>
      ) : (
        <FlatList>
          {shown.map((i) => (
            <div
              key={i.id}
              data-testid="library-row"
              data-id={i.id}
              className={cn('flex items-center gap-2 rounded-control px-2 transition hover:bg-muted/50', live.selected.has(i.id) && 'ring-2 ring-primary')}
            >
              {/* B4: la casella di selezione (solo in lista: in griglia si seleziona con ⌘/Maiusc + clic) */}
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-primary"
                checked={live.selected.has(i.id)}
                aria-label={t`Seleziona ${i.title}`}
                data-testid={`library-select-${i.id}`}
                onChange={(e) => applyClick(i.id, (e.nativeEvent as MouseEvent).shiftKey ? 'range' : 'toggle')}
              />
              {/* il bottone che apre è un <button> vero e contiene la riga a filo: gli servono
                  l'EVENTO del clic (⌘/Ctrl/Maiusc) e il mousedown della selezione, che FlatRow
                  non passa — la riga è il suo contenuto, il bottone il clic */}
              <button
                type="button"
                className={cn('min-w-0 flex-1 rounded-control text-left', DOC_CARD.focus)}
                data-testid={`library-open-${i.id}`}
                onClick={(e) => onItemOpen(e, i)}
                onMouseDown={onItemMouseDown}
              >
                <FlatRow
                  leading={kindIcon(i.kind)}
                  title={
                    <span className="flex items-center gap-1.5">
                      {i.pinned && <Star className="size-4 shrink-0 fill-current text-destructive" aria-hidden="true" />}
                      <span className="min-w-0 truncate" title={i.title}>{i.title}</span>
                      {i.kind === 'document' && <span className="shrink-0 text-caption text-muted-foreground">v{i.currentVersion}</span>}
                      {i.tainted && (
                        <span className="flex shrink-0 items-center gap-1 text-caption text-destructive" title={t`Proveniente da dati esterni`}>
                          <TriangleAlert className="size-4" aria-hidden="true" />
                          {t`esterno`}
                        </span>
                      )}
                    </span>
                  }
                  subtitle={
                    <>
                      {i.kind === 'document' ? (
                        i18n.t(KIND_LABEL.document)
                      ) : i.kind === 'chart' ? (
                        i18n.t(KIND_LABEL.chart)
                      ) : (
                        <>{i.fileName ?? t`file`} · <Plural value={i.fileSize ?? 0} one="# byte" other="# byte" /></>
                      )}{' · '}{nameOf(i.authorAgentId)}
                    </>
                  }
                  trailing={<span className="shrink-0 text-caption text-muted-foreground">{formatDate(i.updatedAt)}</span>}
                />
              </button>
              <LibraryItemMenu
                item={i}
                where="list"
                onChanged={() => void refresh()}
                onError={setActionError}
                initialConfirmDelete={initial?.confirmDeleteId === i.id}
                initialRename={initial?.rename?.id === i.id ? initial.rename.title ?? i.title : undefined}
              />
            </div>
          ))}
        </FlatList>
      )}
      {/* B4: la conferma UNA per tutte le voci selezionate — dice quante sono */}
      {bulkConfirm && (
        <LibraryDeleteDialog
          ids={bulkConfirm.ids}
          title={null}
          onConfirm={() => void runBulk('delete', bulkConfirm.ids)}
          onClose={() => setBulkConfirm(null)}
        />
      )}
    </PageShell>
  )
}

/** La riga rossa di un errore o di un avviso (l'azione fallita, la libreria oltre 2 GB). */
const ALERT_ROW = 'rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive'

/**
 * B4: il «⋯» di una voce della Libreria — il menu dell'app (le sei voci della
 * spec, in ordine): Apri · Rinomina · Fissa/Sblocca · Esporta (per i
 * documenti i formati md · html · pdf) · Archivia (Ripristina, se è già
 * archiviata) · Elimina. Elimina chiede la conferma con la finestra dell'app
 * (mai il confirm() del browser); Rinomina apre la sua finestra. Le voci che
 * non hanno senso dove il menu sta si tolgono (`showOpen`, `showExport`).
 * `where` finisce nei data-testid: library-menu-<where>-<id> il bottone,
 * library-menu-content-<where>-<id> il menu, library-menu-<voce>-<id> le voci.
 */
export function LibraryItemMenu({
  item, where, onChanged, onError, onDeleted,
  showOpen = true, showExport = true, className = '',
  initialConfirmDelete = false, initialRename
}: {
  item: LibraryItemInfo
  /** dove sta il menu: finisce nei data-testid */
  where: 'grid' | 'list' | 'view' | 'page'
  /** dopo un'azione riuscita che cambia la voce (pin, archivia, ripristina, rinomina) */
  onChanged(): void
  /** un'azione è fallita: il messaggio lo mostra chi chiama */
  onError?(message: string): void
  /** dopo una cancellazione riuscita (chi chiama decide: la pagina aperta si chiude) */
  onDeleted?(): void
  /** la voce «Apri» (griglia e lista) */
  showOpen?: boolean
  /** la voce «Esporta» (nella pagina aperta c'è già il suo bottone) */
  showExport?: boolean
  /** la classe del contenitore (in griglia il «⋯» sta in alto a destra della card) */
  className?: string
  /** per i test: la finestra di Elimina già aperta */
  initialConfirmDelete?: boolean
  /** per i test: la finestra di Rinomina già aperta, col titolo scritto */
  initialRename?: string
}) {
  const { t } = useLingui()
  const openLibrary = useStore((s) => s.openLibrary)
  const openPage = useStore((s) => s.openPage)
  const [confirmDelete, setConfirmDelete] = useState(initialConfirmDelete)
  const [rename, setRename] = useState<string | null>(initialRename ?? null)
  const id = item.id
  const formats = exportFormatsOf(item)
  /** il formato dell'esportazione quando è uno solo (grafico svg/mmd, file): va nel suggerimento */
  const f = formats.length === 1 ? formats[0]! : null

  /** Un'azione sulla voce; riuscita → onChanged, fallita → onError (mai un rifiuto ignorato). */
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
      onChanged()
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    }
  }
  const open = (): void => {
    // come il clic sulla voce: un documento apre la PAGINA, il resto la sua vista
    if (item.kind === 'document') { openLibrary(null); openPage(item.id, 'library') } else openLibrary(item.id)
  }
  const saveRename = (): void => {
    const title = (rename ?? '').trim()
    setRename(null)
    // vuoto o uguale a quello di ora: niente da fare (la RPC metterebbe «Senza titolo»)
    if (!title || title === item.title) return
    void run(() => api.libraryRename(item.id, title))
  }
  const doDelete = async (): Promise<void> => {
    setConfirmDelete(false)
    const errors = await runLibraryAction(api, [item.id], 'delete')
    if (errors.length) { onError?.(errors[0]!.error); return }
    if (onDeleted) onDeleted()
    else onChanged()
  }

  return (
    <>
      <div className={className}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* fase design (DS4): il bottone tondo da 32 di Button (ghost, solo icona) —
                la misura delle icone delle testate. no-drag sta sul bottone: sta pure nella
                fascia che TRASCINA la finestra (nella pagina aperta), o il clic trascinerebbe
                la finestra; e lo è ovunque stia (griglia, lista, vista della voce) */}
            <Button
              variant="ghost"
              icon
              size="sm"
              className="no-drag"
              aria-label={t`Altre azioni`}
              title={t`Altre azioni`}
              aria-haspopup="menu"
              data-testid={`library-menu-${where}-${id}`}
              data-id={id}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid={`library-menu-content-${where}-${id}`}>
            {showOpen && (
              <DropdownMenuItem data-testid={`library-menu-open-${id}`} onClick={open}><Trans>Apri</Trans></DropdownMenuItem>
            )}
            <DropdownMenuItem data-testid={`library-menu-rename-${id}`} onClick={() => setRename(item.title)}><Trans>Rinomina</Trans></DropdownMenuItem>
            {/* «Fissa» o «Sblocca» secondo lo stato */}
            <DropdownMenuItem data-testid={`library-menu-pin-${id}`} onClick={() => void run(() => api.libraryPin(item.id, !item.pinned))}>
              {item.pinned ? <Trans>Sblocca</Trans> : <Trans>Fissa</Trans>}
            </DropdownMenuItem>
            {showExport && (formats.length > 1 ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid={`library-menu-export-${id}`}><Trans>Esporta</Trans></DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {formats.map((f) => (
                    <DropdownMenuItem
                      key={f}
                      data-testid={`library-export-${f}-${id}`}
                      onClick={() => void api.libraryExport(item.id, f).catch((e: unknown) => onError?.(e instanceof Error ? e.message : String(e)))}
                    >
                      {f}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              // un formato solo (grafico svg/mmd, file): la voce dice «Esporta», il formato sta nel suggerimento
              <DropdownMenuItem
                data-testid={`library-menu-export-${id}`}
                title={f === null ? undefined : t`Esporta in ~/Downloads/Homun (${f})`}
                onClick={() => void api.libraryExport(item.id, formats[0]!).catch((e: unknown) => onError?.(e instanceof Error ? e.message : String(e)))}
              >
                <Trans>Esporta</Trans>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {/* B4: «Archivia» nasconde la voce dalla vista normale; «Ripristina» la riporta */}
            <DropdownMenuItem
              data-testid={item.archived === true ? `library-menu-restore-${id}` : `library-menu-archive-${id}`}
              onClick={() => void run(() => api.libraryArchive(item.id, item.archived !== true))}
            >
              {item.archived === true ? <Trans>Ripristina</Trans> : <Trans>Archivia</Trans>}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" data-testid={`library-menu-delete-${id}`} onClick={() => setConfirmDelete(true)}>
              <Trans>Elimina</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {rename !== null && (
        <LibraryRenameDialog title={rename} onTitle={setRename} onConfirm={saveRename} onClose={() => setRename(null)} />
      )}
      {confirmDelete && (
        <LibraryDeleteDialog ids={[id]} title={item.title} onConfirm={() => void doDelete()} onClose={() => setConfirmDelete(false)} />
      )}
    </>
  )
}

/**
 * B4: la conferma di Elimina — lo schema dell'app (la finestra «Elimina?»
 * della barra: titolo, cosa succede, Annulla ed Elimina in rosso), mai il
 * confirm() del browser. Con UNA voce dice il titolo, con più voci QUANTE:
 * «Eliminare «titolo»? Non si può annullare.» / «Eliminare 3 voci? Non si
 * può annullare.».
 * Fase design (DS4): la larghezza è quella del dialogo (niente max-w scritto
 * a mano), le azioni sono Button — Annulla secondario, Elimina distruttivo.
 */
function LibraryDeleteDialog({ ids, title, onConfirm, onClose }: {
  ids: string[]
  /** il titolo della voce (una sola); null per più voci */
  title: string | null
  onConfirm(): void
  onClose(): void
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="library-delete-confirm">
        <DialogHeader>
          <DialogTitle className="text-title">
            {title !== null ? <Trans>Eliminare «{title}»?</Trans> : <Trans>Eliminare {ids.length} voci?</Trans>}
          </DialogTitle>
          <DialogDescription className="text-left text-small">
            <Trans>Non si può annullare.</Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" data-testid="library-delete-confirm-cancel" onClick={onClose}>
            <Trans>Annulla</Trans>
          </Button>
          <Button variant="destructive" data-testid="library-delete-confirm-ok" onClick={onConfirm}>
            <Trans>Elimina</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** B4: la finestra di Rinomina — il titolo di partenza nell'input, Invio salva, Annulla (o Esc) chiude. */
function LibraryRenameDialog({ title, onTitle, onConfirm, onClose }: {
  title: string
  onTitle(title: string): void
  onConfirm(): void
  onClose(): void
}) {
  const { t } = useLingui()
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="library-rename-dialog">
        <DialogHeader>
          <DialogTitle className="text-title"><Trans>Rinomina</Trans></DialogTitle>
        </DialogHeader>
        {/* il campo di DS1 (36 px, il raggio dei campi), con l'anello del fuoco da tastiera */}
        <input
          className={cn(FIELD, FIELD_FOCUS, 'w-full')}
          aria-label={t`Nuovo titolo`}
          data-testid="library-rename-input"
          value={title}
          autoFocus
          onChange={(e) => onTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onConfirm() } }}
        />
        <DialogFooter>
          <Button variant="secondary" data-testid="library-rename-cancel" onClick={onClose}>
            <Trans>Annulla</Trans>
          </Button>
          <Button data-testid="library-rename-save" onClick={onConfirm}>
            <Trans>Salva</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * La vista di UNA voce (un grafico, un file, lo storico delle versioni di un
 * documento): lo stesso guscio della lista — PageShell, larghezza «page» —
 * con la testata di PageHeader: indietro (torna alla lista), l'icona del
 * tipo, il titolo, a destra l'id e il «⋯» della voce; sotto la riga, chi l'ha
 * preparata (e l'avviso se viene da dati esterni).
 * Fase design (DS4): il «← Lista» di prima è la freccia indietro della
 * testata, come in ogni pagina; il suo nome accessibile è lo stesso testo di
 * oggi per il ritorno alla lista («torna alla lista»).
 */
function LibraryItemView({ id }: { id: string }) {
  const { t } = useLingui()
  const openLibrary = useStore((s) => s.openLibrary)
  const openPage = useStore((s) => s.openPage)
  const [item, setItem] = useState<LibraryItemInfo | null>(null)
  const [content, setContent] = useState<LibraryContentInfo | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [err, setErr] = useState('')
  // D6 (fase deleghe): gli id dei documenti che esistono, per i link lib_…
  const [docIds, setDocIds] = useState<Set<string>>(new Set())

  const refresh = async (v?: number) => {
    try {
      const c = await api.libraryGet(id)
      setContent(c)
      setVersion(v ?? Math.max(...c.versions))
      // B4: anche tra le archiviate ('all') — una voce archiviata aperta dalla
      // chat (la card di un grafico) tiene titolo, pin e il suo «Ripristina»
      const items = await api.libraryList(undefined, undefined, 'all')
      setDocIds(new Set(items.map((i) => i.id)))
      setItem(items.find((i) => i.id === id) ?? null)
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => { void refresh() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // l'errore vince sul contenuto (come prima: la vista dell'errore sostituiva tutto)
  const body = !err && content
  return (
    <PageShell
      width="wide"
      testId="library-panel"
      header={
        <PageHeader
          back={{ onClick: () => openLibrary(''), label: t`torna alla lista` }}
          icon={item?.kind === 'chart' ? <BarChart3 className="size-5" /> : item?.kind === 'file' ? <FileIcon className="size-5" /> : <FileText className="size-5" />}
          title={
            <span className="flex min-w-0 items-center gap-2">
              {item?.pinned && <Star className="size-5 shrink-0 fill-current text-destructive" aria-hidden="true" />}
              <span className="min-w-0 truncate">{item?.title ?? id}</span>
            </span>
          }
          description={content ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{content.authorName}</span>
              {/* il «⚠» di prima è l'icona dell'avviso; il testo dice il resto */}
              {item?.tainted && (
                <span className="flex items-center gap-1 text-destructive">
                  <TriangleAlert className="size-4" aria-hidden="true" />
                  {t`Proveniente da dati esterni`}
                </span>
              )}
            </span>
          ) : undefined}
          actions={item ? (
            <>
              <span className="text-caption text-muted-foreground">{item.id}</span>
              {/* B4: al posto dei bottoni (Esporta/Fissa/Rinomina/Cancella col confirm del browser) il «⋯» della voce; l'id resta */}
              <LibraryItemMenu item={item} where="view" showOpen={false} onChanged={() => void refresh(version ?? undefined)} onError={setErr} />
            </>
          ) : undefined}
        />
      }
      contentClassName="flex flex-col gap-block pt-4 pb-10"
    >
      {err && (
        <div className="flex flex-wrap items-center gap-2 text-body text-destructive">
          {err}
          <Button variant="ghost" size="sm" onClick={() => openLibrary('')}><Trans>torna alla lista</Trans></Button>
        </div>
      )}
      {!body && !err && <p className="text-body text-muted-foreground">…</p>}
      {body && (
        <>
          {body.kind === 'document' && (
            <>
              {/* le versioni: un interruttore a pastiglie (come griglia/elenco in testata); il ripristino è un'azione a parte */}
              <div className="flex flex-wrap items-center gap-2 text-small text-muted-foreground">
                <Trans>Versioni:</Trans>
                <div className="flex items-center rounded-full bg-muted p-0.5">
                  {body.versions.map((v) => (
                    <Button
                      key={v}
                      variant="ghost"
                      size="sm"
                      shape="pill"
                      className={cn('px-2', v === version && 'bg-card text-foreground hover:text-foreground')}
                      onClick={() => void refresh(v)}
                    >
                      v{v}
                    </Button>
                  ))}
                </div>
                {version !== null && version < Math.max(...body.versions) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void api.libraryRestoreVersion(id, version).then(() => refresh())}
                  >
                    {/* il «↩» di prima è l'icona */}
                    <Undo2 className="size-4" aria-hidden="true" />
                    <Trans>Ripristina v{version} come nuova versione</Trans>
                  </Button>
                )}
              </div>
              <DocumentBody
                markdown={body.content ?? ''}
                onOpenDoc={(docId) => openPage(docId, 'library')} docExists={(docId) => docIds.has(docId)}
              />
            </>
          )}

          {body.kind === 'chart' && <ChartBody content={body} />}

          {body.kind === 'file' && (
            body.fileBase64 ? (
              <img
                className="max-w-full rounded-surface border border-border"
                src={`data:${body.fileMime};base64,${body.fileBase64}`}
                alt={item?.title ?? id}
              />
            ) : (
              <p className="rounded-surface border border-border bg-muted/50 px-4 py-3 text-body text-foreground">
                <Trans>File: {item?.fileName} ({item?.fileSize} byte) — esportalo per vederlo.</Trans>
              </p>
            )
          )}
        </>
      )}
    </PageShell>
  )
}

function ChartBody({ content }: { content: LibraryContentInfo }) {
  const { t } = useLingui()
  if (content.svg) return <img className="max-w-full rounded-surface border border-border bg-white" src={svgDataUrl(content.svg)} alt={t`grafico`} />
  return <InlineChart lang="mermaid" source={content.content ?? ''} />
}
