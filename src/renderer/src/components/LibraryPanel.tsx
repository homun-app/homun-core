// La LIBRERIA (fase 14, punti 1-5 → fase 16c C6, tavola 4 destra): la vista
// globale con filtri «Tutti i bot ▾» e «Tutti i tipi ▾», la scelta griglia ▦ /
// elenco ☰ (ricordata in localStorage con try/catch), card senza bordo su
// bg-muted con anteprima (mini grafico dai dati salvati, prime righe dei
// documenti, badge dell'estensione per i file), titolo e «Tipo · Bot ·
// quando». Fase pagine (G5): le righe di DOCUMENTO aprono la PAGINA (G2) con
// la ✕ che torna qui, e l'etichetta dice «Pagina» (nei filtri pure); lo
// storico con versioni, esporta, rinomina e «Ripristina» resta la vista di
// oggi (ci porta la riga della versione della pagina). Il corpo del documento
// (Markdown + blocchi grafico, Vega-Lite e Mermaid SEMPRE <img>) vive in
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
import { useEffect, useMemo, useState } from 'react'
import { useLingui, Trans, Plural } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { formatDate } from '../lib/i18n'
import { ChevronLeft, LayoutGrid, List, MoreHorizontal, X } from 'lucide-react'
import { api, useStore } from '../store'
// fase pagine (G2): il corpo del documento, condiviso con la pagina aperta
import { DocumentBody, InlineChart, svgDataUrl } from './DocumentMarkdown'
// B4: le pure della vista (filtri, ordine, «Archiviati») e della selezione
import {
  libraryRows, libraryListArgs, libraryClickIntent, librarySelectionAfter, librarySelectionVisible,
  LIBRARY_SELECTION_EMPTY, type LibraryKindFilter, type LibrarySelection
} from '../lib/library-view'
// R2 (fase ritocchi-beta18): il testo dell'anteprima dei documenti — la
// STESSA funzione pura delle card della Libreria (mai markdown grezzo)
import { previewLineText } from '../lib/page-view'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger
} from './ui/dropdown-menu'
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
  // verifica impostazioni: la vista sta SOPRA la fascia di trascinamento della
  // chat, che Electron calcola ignorando lo z-index — no-drag, o la freccia ‹
  // in alto cade dentro la fascia e il clic trascina la finestra
  return (
    <div className="no-drag absolute inset-0 z-20 flex flex-col bg-background" data-testid="library-panel">
      {openLibraryId === '' ? <LibraryList initial={initial} /> : <LibraryItemView id={openLibraryId} />}
    </div>
  )
}

/** L'anteprima di una card: mini grafico se lo si può disegnare, prime righe, o badge. */
function LibraryPreview({ item }: { item: LibraryItemInfo }) {
  const [doc, setDoc] = useState<string | null>(null)
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setDoc(null)
    setSvg(null)
    if (item.kind === 'document') {
      void api.libraryGet(item.id).then((c) => { if (alive) setDoc((c.content ?? '').slice(0, 400)) }).catch(() => undefined)
    } else if (item.kind === 'chart' && item.chartKind === 'vega-lite') {
      void api.libraryGet(item.id).then((c) => { if (alive) setSvg(c.svg ?? null) }).catch(() => undefined)
    }
    return () => { alive = false }
  }, [item.id, item.kind, item.chartKind, item.updatedAt])

  if (item.kind === 'chart') {
    if (svg) {
      return <img className="h-full w-full object-contain p-4" src={svgDataUrl(svg)} alt="" aria-hidden="true" />
    }
    return (
      <div className="grid h-full w-full place-items-center" aria-hidden="true">
        <svg width="72" height="48" viewBox="0 0 80 56"><path d="M4 48 L22 30 L36 38 L54 14 L76 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="text-muted-foreground/60" /></svg>
      </div>
    )
  }
  if (item.kind === 'document') {
    return (
      <div className="flex h-full w-full flex-col justify-center gap-2 px-6" aria-hidden="true">
        {doc === null
          ? [70, 90, 80].map((w, i) => <span key={i} className="h-2 rounded-full bg-muted-foreground/20" style={{ width: `${w}%` }} />)
          // B4: ogni riga passa da previewLineText — anche quelle di tabella (mai |---|---| né | Ricetta | Data |)
          : doc.split(/\n+/).map(previewLineText).filter(Boolean).slice(0, 4).map((line, i) => (
            <span key={i} className="line-clamp-1 text-[11px] leading-4 text-muted-foreground">{line.slice(0, 90)}</span>
          ))}
      </div>
    )
  }
  // file: il badge dell'estensione
  const ext = (item.fileName ?? '').split('.').pop()?.toUpperCase() || 'FILE'
  return <div className="grid h-full w-full place-items-center text-2xl font-bold text-chart-2/80" aria-hidden="true">.{ext.toLowerCase()}</div>
}

/**
 * Il «⋯» del menu di una voce. `no-drag` sta sul bottone: nella pagina aperta
 * la testata è la fascia che trascina la finestra (come la ✕ e «Esporta»).
 */
const MENU_TRIGGER_CLASS = 'no-drag grid size-7 shrink-0 place-items-center rounded-full bg-card/80 text-muted-foreground shadow-soft transition hover:text-foreground'

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

  return (
    <div className="flex-1 overflow-y-auto scroll-thin px-8 py-6">
      <div className="mx-auto max-w-4xl space-y-4">
        {/* la testa della vista (tavola 4): titolo, filtri, griglia/elenco */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="grid size-8 place-items-center rounded-[10px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label={t`Torna alla chat`}
            onClick={() => openLibrary(null)}
          >
            <ChevronLeft className="size-4" />
          </button>
          <h1 className="flex-1 font-display text-2xl"><Trans>Libreria</Trans></h1>
          <select
            className="h-9 rounded-[10px] bg-muted px-3 text-sm outline-none"
            value={author}
            aria-label={t`Tutti i bot`}
            data-testid="library-filter-bot"
            onChange={(e) => setAuthor(e.target.value)}
          >
            <option value="">{t`Tutti i bot`}</option>
            {authors.map((a) => <option key={a} value={a}>{nameOf(a)}</option>)}
          </select>
          <select
            className="h-9 rounded-[10px] bg-muted px-3 text-sm outline-none"
            value={kind}
            aria-label={t`Tutti i tipi`}
            onChange={(e) => setKind(e.target.value as LibraryKindFilter)}
          >
            <option value="">{t`Tutti i tipi`}</option>
            <option value="document">{i18n.t(msg`Pagina`)}</option>
            <option value="chart">{i18n.t(msg`Grafico`)}</option>
            <option value="file">{i18n.t(msg`File`)}</option>
          </select>
          {/* B4: il filtro «Archiviati» — un interruttore; acceso, la vista mostra solo le archiviate */}
          <button
            type="button"
            aria-pressed={archived}
            data-testid="library-filter-archived"
            className={`h-9 rounded-[10px] px-3 text-sm transition ${archived ? 'bg-card text-foreground ring-1 ring-border' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
            onClick={toggleArchived}
          >
            <Trans>Archiviati</Trans>
          </button>
          <div role="group" aria-label={t`Vista`} className="flex rounded-[10px] bg-muted p-0.5">
            <button
              className={`grid size-8 place-items-center rounded-lg transition ${view === 'grid' ? 'bg-card text-foreground' : 'text-muted-foreground'}`}
              aria-label={t`Griglia`}
              onClick={() => { setView('grid'); writeLibraryView('grid') }}
            >
              <LayoutGrid className="size-4" />
            </button>
            <button
              className={`grid size-8 place-items-center rounded-lg transition ${view === 'list' ? 'bg-card text-foreground' : 'text-muted-foreground'}`}
              aria-label={t`Elenco`}
              onClick={() => { setView('list'); writeLibraryView('list') }}
            >
              <List className="size-4" />
            </button>
          </div>
        </div>
        <input
          className="h-10 w-full rounded-full bg-muted px-4 text-sm outline-none"
          placeholder={t`Cerca per titolo…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {/* B4: le azioni sulle voci selezionate — da DUE in su */}
        {bulkIds.length >= 2 && (
          <div
            role="region"
            aria-label={t`Azioni sulle voci selezionate`}
            data-testid="library-bulk-bar"
            className="flex flex-wrap items-center gap-2 rounded-[14px] bg-card px-3 py-2 shadow-soft"
          >
            <span className="text-sm font-medium"><Trans>{bulkIds.length} selezionati</Trans></span>
            <span className="min-w-2 flex-1" />
            <button
              type="button"
              className="rounded-[10px] bg-muted px-3 py-1.5 text-sm transition hover:bg-accent"
              data-testid={archived ? 'library-bulk-restore' : 'library-bulk-archive'}
              onClick={() => void runBulk(archived ? 'restore' : 'archive')}
            >
              {archived ? <Trans>Ripristina</Trans> : <Trans>Archivia</Trans>}
            </button>
            <button
              type="button"
              className="rounded-[10px] bg-destructive/10 px-3 py-1.5 text-sm font-medium text-destructive transition hover:bg-destructive/20"
              data-testid="library-bulk-delete"
              onClick={() => setBulkConfirm({ ids: bulkIds })}
            >
              <Trans>Elimina</Trans>
            </button>
            <button
              type="button"
              className="grid size-7 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label={t`Esci dalla selezione`}
              title={t`Esci dalla selezione`}
              data-testid="library-selection-clear"
              onClick={clearSelection}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        )}
        {/* B4: l'errore di un'azione (una voce che non c'è più, …): si mostra, non si ignora */}
        {actionError !== null && (
          <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="library-error">{actionError}</p>
        )}
        {stats?.warn && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <Trans>La libreria supera 2 GB: valuta cosa cancellare (nessun blocco automatico).</Trans>
          </p>
        )}
        {failed ? (
          <div className={`flex items-center gap-2 text-sm text-muted-foreground ${items.length ? 'justify-start' : 'pt-16 justify-center'}`}>
            <Trans>Non riesco a leggere la libreria</Trans>
            <button className="text-primary hover:underline" onClick={() => { void refresh() }}><Trans>Riprova</Trans></button>
          </div>
        ) : shown.length === 0 && (
          <p className="pt-16 text-center text-sm text-muted-foreground">
            {/* B4: tra gli archiviati la frase è sua — la libreria non è vuota, non c'è niente di archiviato */}
            {archived
              ? <Trans>Nessun documento archiviato.</Trans>
              : <Trans>La libreria è vuota: i documenti, i grafici e i file che i bot preparano finiscono qui.</Trans>}
          </p>
        )}
        {/* la griglia (tavola 4): card senza bordo su bg-muted */}
        {view === 'grid' ? (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
            {shown.map((i) => (
              <div
                key={i.id}
                data-testid="library-card"
                data-id={i.id}
                className={`group relative overflow-hidden rounded-[18px] transition hover:bg-muted/80 ${live.selected.has(i.id) ? 'ring-2 ring-primary' : ''}`}
              >
                <button
                  type="button"
                  className="block w-full text-left"
                  data-testid={`library-open-${i.id}`}
                  onClick={(e) => onItemOpen(e, i)}
                  onMouseDown={onItemMouseDown}
                >
                  <div className="h-32 rounded-[14px] bg-muted">
                    <LibraryPreview item={i} />
                  </div>
                  <div className="px-1 pt-2 pb-1">
                    <p className="truncate text-sm font-medium">{i.pinned && <span className="mr-1 text-destructive">★</span>}{i.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {i18n.t(KIND_LABEL[i.kind])} · {nameOf(i.authorAgentId)} · {formatDate(i.updatedAt)}
                    </p>
                  </div>
                </button>
                {/* B4: il «⋯» della voce, in alto a destra della card (sempre visibile) */}
                <LibraryItemMenu
                  item={i}
                  where="grid"
                  className="absolute top-2 right-2 z-10"
                  onChanged={() => void refresh()}
                  onError={setActionError}
                  initialConfirmDelete={initial?.confirmDeleteId === i.id}
                  initialRename={initial?.rename?.id === i.id ? initial.rename.title ?? i.title : undefined}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {shown.map((i) => (
              <div
                key={i.id}
                data-testid="library-row"
                data-id={i.id}
                className={`flex items-center gap-2 rounded-[14px] bg-muted/60 px-2 py-3 ${live.selected.has(i.id) ? 'ring-2 ring-primary' : ''}`}
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
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  data-testid={`library-open-${i.id}`}
                  onClick={(e) => onItemOpen(e, i)}
                  onMouseDown={onItemMouseDown}
                >
                  <p className="truncate text-sm">
                    {i.pinned && <span className="mr-1 text-destructive">★</span>}
                    {i.title}
                    {i.kind === 'document' && <span className="ml-2 text-xs text-muted-foreground">v{i.currentVersion}</span>}
                    {i.tainted && <span className="ml-2 text-xs text-destructive/80" title={t`Proveniente da dati esterni`}>{t`⚠ esterno`}</span>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {i.kind === 'document' ? (
                      i18n.t(KIND_LABEL.document)
                    ) : i.kind === 'chart' ? (
                      i18n.t(KIND_LABEL.chart)
                    ) : (
                      <>{i.fileName ?? t`file`} · <Plural value={i.fileSize ?? 0} one="# byte" other="# byte" /></>
                    )}{' · '}{nameOf(i.authorAgentId)} · {formatDate(i.updatedAt)}
                  </p>
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
          </div>
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
      </div>
    </div>
  )
}

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
            <button
              type="button"
              className={MENU_TRIGGER_CLASS}
              aria-label={t`Altre azioni`}
              title={t`Altre azioni`}
              aria-haspopup="menu"
              data-testid={`library-menu-${where}-${id}`}
              data-id={id}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </button>
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
      <DialogContent className="max-w-sm" data-testid="library-delete-confirm">
        <DialogHeader>
          <DialogTitle className="text-lg">
            {title !== null ? <Trans>Eliminare «{title}»?</Trans> : <Trans>Eliminare {ids.length} voci?</Trans>}
          </DialogTitle>
          <DialogDescription className="text-left text-[13px] leading-snug">
            <Trans>Non si può annullare.</Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            className="rounded-[10px] bg-muted px-3.5 py-1.5 text-sm transition hover:bg-accent"
            data-testid="library-delete-confirm-cancel"
            onClick={onClose}
          >
            <Trans>Annulla</Trans>
          </button>
          <button
            type="button"
            className="rounded-[10px] bg-destructive/10 px-3.5 py-1.5 text-sm font-medium text-destructive transition hover:bg-destructive/20"
            data-testid="library-delete-confirm-ok"
            onClick={onConfirm}
          >
            <Trans>Elimina</Trans>
          </button>
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
      <DialogContent className="max-w-sm" data-testid="library-rename-dialog">
        <DialogHeader>
          <DialogTitle className="text-lg"><Trans>Rinomina</Trans></DialogTitle>
        </DialogHeader>
        <input
          className="h-10 w-full rounded-[10px] bg-muted px-3 text-sm outline-none"
          aria-label={t`Nuovo titolo`}
          data-testid="library-rename-input"
          value={title}
          autoFocus
          onChange={(e) => onTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onConfirm() } }}
        />
        <DialogFooter>
          <button
            type="button"
            className="rounded-[10px] bg-muted px-3.5 py-1.5 text-sm transition hover:bg-accent"
            data-testid="library-rename-cancel"
            onClick={onClose}
          >
            <Trans>Annulla</Trans>
          </button>
          <button
            type="button"
            className="rounded-[10px] bg-primary px-3.5 py-1.5 text-sm font-medium text-white transition hover:opacity-90"
            data-testid="library-rename-save"
            onClick={onConfirm}
          >
            <Trans>Salva</Trans>
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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

  if (err) return <div className="flex-1 px-6 py-4 text-sm text-destructive">{err} <button className="underline" onClick={() => openLibrary('')}><Trans>torna alla lista</Trans></button></div>
  if (!content) return <div className="flex-1 px-6 py-4 text-sm text-muted-foreground">…</div>

  return (
    <div className="flex-1 overflow-y-auto scroll-thin px-6 py-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => openLibrary('')}><Trans>← Lista</Trans></button>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-semibold text-foreground">
              {item?.pinned && <span className="mr-1 text-destructive">★</span>}
              {item?.title ?? id}
            </h3>
            <p className="text-xs text-muted-foreground">
              {content.authorName}{item?.tainted ? t` · ⚠ proveniente da dati esterni` : ''}
            </p>
          </div>
          {/* B4: al posto dei bottoni (Esporta/Fissa/Rinomina/Cancella col confirm del browser) il «⋯» della voce; l'id resta */}
          {item && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{item.id}</span>
              <LibraryItemMenu item={item} where="view" showOpen={false} onChanged={() => void refresh(version ?? undefined)} onError={setErr} />
            </div>
          )}
        </div>

        {content.kind === 'document' && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Trans>Versioni:</Trans>
              {content.versions.map((v) => (
                <button
                  key={v}
                  className={`rounded px-2 py-0.5 ${v === version ? 'bg-accent text-foreground' : 'hover:bg-muted'}`}
                  onClick={() => void refresh(v)}
                >
                  v{v}
                </button>
              ))}
              {version !== null && version < Math.max(...content.versions) && (
                <button
                  className="rounded border border-border px-2 py-0.5 hover:bg-muted"
                  onClick={() => void api.libraryRestoreVersion(id, version).then(() => refresh())}
                >
                  <Trans>↩ Ripristina v{version} come nuova versione</Trans>
                </button>
              )}
            </div>
            <DocumentBody
              markdown={content.content ?? ''}
              onOpenDoc={(docId) => openPage(docId, 'library')} docExists={(docId) => docIds.has(docId)}
            />
          </>
        )}

        {content.kind === 'chart' && <ChartBody content={content} />}

        {content.kind === 'file' && (
          content.fileBase64 ? (
            <img
              className="max-h-[70vh] rounded-xl border border-border"
              src={`data:${content.fileMime};base64,${content.fileBase64}`}
              alt={item?.title ?? id}
            />
          ) : (
            <p className="rounded-xl border border-border bg-muted/50 px-4 py-3 text-sm text-foreground">
              <Trans>File: {item?.fileName} ({item?.fileSize} byte) — esportalo per vederlo.</Trans>
            </p>
          )
        )}
      </div>
    </div>
  )
}

function ChartBody({ content }: { content: LibraryContentInfo }) {
  const { t } = useLingui()
  if (content.svg) return <img className="max-w-full rounded-xl border border-border bg-white" src={svgDataUrl(content.svg)} alt={t`grafico`} />
  return <InlineChart lang="mermaid" source={content.content ?? ''} />
}
