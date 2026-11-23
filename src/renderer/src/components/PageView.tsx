// Fase pagine (G2): la pagina aperta — il documento della libreria letto a
// tutta larghezza al posto della chat (cattura 14). In alto ✕ (torna da dove
// era venuta: chat o lista della Libreria), la pillola col titolo, a destra
// «Esporta» (md/html/pdf: le funzioni di oggi). Sotto, la colonna di lettura
// (≈720 px, tipografia da documento) con: riga «versione N · aggiornata …»
// che porta allo storico della Libreria («Ripristina»), l'avvertenza delle
// pagine tainted, l'indice «In questa pagina» (dai ##/###: con 4 titoli o
// più, i primi 12 e «Mostra tutti (N)») e il Markdown coi grafici incorporati
// (stessi renderer e difese della Libreria). Il compositore della chat resta
// SOSPESO in basso: chi ci scrive parla al bot della chat, che riceve la riga
// di contesto della pagina (G6). Si chiude con ✕ ed Esc.
//
// B4 (fase b20-bug): accanto a «Esporta» c'è anche il «⋯» del documento — lo
// stesso menu della Libreria (Rinomina · Fissa/Sblocca · Archivia · Elimina;
// Apri ed Esporta non servono: la pagina è già aperta e il bottone c'è). Una
// pagina ARCHIVIATA si legge ancora — niente viene cancellato dall'archiviare
// — e lo dice, con «Ripristina»; per questo la sua voce si cerca anche tra le
// archiviate (library:list … 'all'), così il titolo è sempre quello giusto.
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { X, FileDown } from 'lucide-react'
import { api, useStore } from '../store'
import { formatDate } from '../lib/i18n'
import { pageHeadings, pageBody } from '../lib/page-view'
import { DocumentBody } from './DocumentMarkdown'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { LibraryItemMenu } from './LibraryPanel'
import type { LibraryItemInfo, LibraryContentInfo } from '../../../shared/types'

/** Quante voci dell'indice si vedono prima di «Mostra tutti (N)». */
const TOC_PREVIEW = 12
/** L'indice si mostra da questo numero di titoli in su. */
const TOC_MIN_HEADINGS = 4

/**
 * B4: lo stato di partenza dei test (render statico, senza effect) — il
 * componente vero non lo passa mai.
 */
export interface PageViewInitial {
  id?: string
  content?: LibraryContentInfo | null
  item?: LibraryItemInfo | null
  /** la finestra di Elimina già aperta */
  confirmDelete?: boolean
  /** la finestra di Rinomina già aperta, col titolo scritto */
  renameTitle?: string
  error?: string
}

/** La voce del menu anche prima che la lista arrivi (o se manca): bastano id e titolo. */
function pageItem(info: { id: string; title: string }, item: LibraryItemInfo | null): LibraryItemInfo {
  if (item) return item
  return {
    id: info.id, kind: 'document', title: info.title || info.id, authorAgentId: '', createdAt: 0, updatedAt: 0,
    pinned: false, tainted: false, currentVersion: 1, chartKind: null
  }
}

export function PageView({ initial }: { initial?: PageViewInitial } = {}) {
  const { t } = useLingui()
  const info = useStore((s) => s.openPageInfo)
  const closePage = useStore((s) => s.closePage)
  const openLibrary = useStore((s) => s.openLibrary)
  const openPage = useStore((s) => s.openPage)
  const setPageMeta = useStore((s) => s.setPageMeta)
  const [content, setContent] = useState<LibraryContentInfo | null>(initial?.content ?? null)
  const [item, setItem] = useState<LibraryItemInfo | null>(initial?.item ?? null)
  const [err, setErr] = useState(initial?.error ?? '')
  const [allHeadings, setAllHeadings] = useState(false)
  // B4: un giro di ricarica in più dopo un'azione del «⋯» (rinomina, pin, ripristina)
  const [reload, setReload] = useState(0)
  // D6 (fase deleghe): gli id dei documenti che esistono, per i link lib_…
  // nel corpo (il documento mancante diventa testo col tooltip)
  const [docIds, setDocIds] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!info) return
    let alive = true
    setContent(null)
    setItem(null)
    setErr('')
    setAllHeadings(false)
    void api.libraryGet(info.id)
      .then(async (c) => {
        if (!alive) return
        setContent(c)
        // B4: anche tra le archiviate ('all') — una pagina archiviata (aperta da un link
        // o già aperta quando la si archivia) tiene titolo, avviso e «Ripristina»
        const items = await api.libraryList(undefined, undefined, 'all')
        if (!alive) return
        setDocIds(new Set(items.map((i) => i.id)))
        const it = items.find((i) => i.id === info.id) ?? null
        setItem(it)
        // il compositore usa titolo e versione corrente nella riga per il modello
        setPageMeta({ title: it?.title ?? info.id, version: Math.max(...c.versions) })
      })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.id, reload])

  // Esc chiude la pagina — in FASE BOLLA e SOLO se nessun altro l'ha già
  // consumato: l'Esc di un menu Radix, di un foglio o dell'elenco / chiude
  // QUELLO, non la pagina (il gestore guarda il target e defaultPrevented)
  useEffect(() => {
    if (!info) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target
      if (target instanceof Element && target.closest('[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]')) return
      e.preventDefault()
      closePage()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [info, closePage])

  if (!info) return null

  const markdown = content?.content ?? ''
  const headings = pageHeadings(markdown)
  const version = content ? Math.max(...content.versions) : item?.currentVersion ?? 1
  const title = item?.title ?? info.id
  const back = (): void => {
    if (info.from === 'library') openLibrary('')
    closePage()
  }
  // B4: dopo un'azione del «⋯» la pagina si rilegge (il titolo cambia, lo stato di pin o di archivio)
  const reloadPage = (): void => setReload((n) => n + 1)
  const goTo = (id: string): void => {
    scrollRef.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <div data-testid="page-view" className="no-drag absolute inset-0 z-20 flex flex-col bg-background">
      {/* la fascia alta: trascina la finestra; ✕, pillola del titolo, Esporta.
          Fase design (DS3): alta 52 come la testata di OGNI colonna (h-col-head, letta dalla sonda), i controlli da 32 */}
      <div data-col-head="pagina" className="drag-region absolute inset-x-0 top-0 z-10 flex h-col-head">
        <div className="flex h-full items-center gap-3 px-4">
          <button
            className="no-drag grid size-control-sm shrink-0 place-items-center rounded-full bg-muted/60 text-muted-foreground transition hover:text-foreground"
            aria-label={info.from === 'library' ? t`Torna alla libreria` : t`Torna alla chat`}
            title={info.from === 'library' ? t`Torna alla libreria` : t`Torna alla chat`}
            data-testid="page-close"
            onClick={back}
          >
            <X className="size-4" />
          </button>
          <span className="flex min-w-0 flex-1 justify-center">
            <span className="max-w-full truncate rounded-full bg-card/95 px-4 py-1.5 text-body font-medium shadow-soft" data-testid="page-title-pill">
              {title}
            </span>
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="no-drag flex h-control-sm shrink-0 items-center gap-2 rounded-full bg-muted/60 px-3 text-body text-muted-foreground transition hover:text-foreground"
              aria-label={t`Esporta`}
              data-testid="page-export"
            >
              <FileDown className="size-4" /> <Trans>Esporta</Trans>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(['md', 'html', 'pdf'] as const).map((f) => (
                <DropdownMenuItem key={f} onClick={() => { void api.libraryExport(info.id, f).catch(() => undefined) }}>
                  {f}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* B4: il «⋯» del documento — Rinomina · Fissa/Sblocca · Archivia/Ripristina · Elimina (con la conferma).
              Confermata una cancellazione la pagina si chiude e si torna da dove si era venuti */}
          <LibraryItemMenu
            item={pageItem(info, item)}
            where="page"
            showOpen={false}
            showExport={false}
            onChanged={reloadPage}
            onError={setErr}
            onDeleted={back}
            initialConfirmDelete={initial?.confirmDelete}
            initialRename={initial?.renameTitle}
          />
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-6 pb-10 pt-[76px]">
        {err && <p className="mx-auto max-w-[720px] text-sm text-destructive">{err}</p>}
        {!content && !err && <p className="mx-auto max-w-[720px] text-sm text-muted-foreground">…</p>}
        {content && (
          <div className="mx-auto max-w-[720px]">
            <h1 className="font-display text-[28px] leading-tight" data-testid="page-title">{title}</h1>
            {/* la riga della versione porta allo storico della Libreria (Ripristina) */}
            <button
              className="mt-1.5 text-[13px] text-muted-foreground transition hover:text-foreground"
              data-testid="page-version"
              onClick={() => { closePage(); openLibrary(info.id) }}
            >
              <Trans>versione {version}</Trans> · <Trans>aggiornata {formatDate(item?.updatedAt ?? 0)}</Trans> ›
            </button>
            {item?.tainted && (
              <p className="mt-3 rounded-[12px] bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="page-tainted">
                <Trans>⚠ proveniente da dati esterni</Trans>
              </p>
            )}
            {/* B4: la pagina è archiviata — si legge lo stesso; da qui si ripristina in Libreria */}
            {item?.archived === true && (
              <p className="mt-3 flex flex-wrap items-center gap-2 rounded-[12px] bg-muted/60 px-3 py-2 text-xs text-muted-foreground" data-testid="page-archived-notice">
                <span><Trans>Archiviata: non compare in Libreria finché non la ripristini.</Trans></span>
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  data-testid="page-restore"
                  onClick={() => { void api.libraryArchive(info.id, false).then(reloadPage).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e))) }}
                >
                  <Trans>Ripristina</Trans>
                </button>
              </p>
            )}
            {headings.length >= TOC_MIN_HEADINGS && (
              <nav className="mt-5 rounded-[16px] bg-muted/60 px-4 py-3" aria-label={t`In questa pagina`} data-testid="page-toc">
                <p className="text-xs font-semibold text-muted-foreground"><Trans>In questa pagina</Trans></p>
                <ul className="mt-1.5 space-y-0.5">
                  {(allHeadings ? headings : headings.slice(0, TOC_PREVIEW)).map((h) => (
                    <li key={h.id} className={h.level === 3 ? 'pl-4' : ''}>
                      {/* P5: righe più fitte (py-0, leading-6) — con 10 voci
                          l'indice non mangia mezza schermata prima del testo */}
                      <button
                        className="block w-full truncate rounded px-1.5 py-0 text-left text-[13px] leading-6 text-foreground/80 transition hover:bg-muted hover:text-foreground"
                        data-testid="page-toc-item"
                        onClick={() => goTo(h.id)}
                      >
                        {h.text}
                      </button>
                    </li>
                  ))}
                </ul>
                {headings.length > TOC_PREVIEW && !allHeadings && (
                  <button
                    className="mt-1.5 px-1.5 text-[13px] text-primary transition hover:underline"
                    data-testid="page-toc-all"
                    onClick={() => setAllHeadings(true)}
                  >
                    <Trans>Mostra tutti ({headings.length})</Trans>
                  </button>
                )}
              </nav>
            )}
            <div className="mt-6">
              {/* P2: il primo `# ` uguale al titolo non si riduplica nel corpo —
                  il titolo lo mostra già la pagina; l'indice resta sul Markdown
                  intero (un `# ` non c'è mai, gli id non cambiano) */}
              <DocumentBody
                markdown={pageBody(markdown, title)} headingIds={headings.map((h) => h.id)} typography="page"
                onOpenDoc={(id) => openPage(id, 'library')} docExists={(id) => docIds.has(id)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
