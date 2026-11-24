// Fase pagine (G2): la pagina aperta — il documento della libreria letto a
// tutta larghezza al posto della chat (cattura 14). In alto ✕ (torna da dove
// era venuta: chat o lista della Libreria), il titolo del documento, a destra
// «Esporta» (md/html/pdf: le funzioni di oggi). Sotto, la colonna di lettura
// (720 px, tipografia da documento) con: riga «versione N · aggiornata …»
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
//
// Fase design (DS4) — la pagina passa al sistema:
//  · il guscio è PageShell alla larghezza «reading» (720): il corpo che scorre
//    largo quanto l'area, il contenuto centrato. Prima la colonna era una
//    max-w-[720px] scritta qui, dentro un corpo con 76 px di aria in testa
//    per non passare sotto la testata.
//  · la testata è PageHeader (indietro · titolo · azioni a destra), sulla
//    riga dei 52 di OGNI colonna. DS3: la riga dentro la testata è LARGA
//    QUANTO LA TESTATA — la colonna di PageColumn porta w-full — così il
//    titolo parte da sinistra e «Esporta» e il «⋯» arrivano al bordo destro.
//    Prima la riga interna era larga quanto il suo contenuto, figlia di una
//    testata flex in riga: le azioni restavano a metà.
//  · nel corpo: il titolo del documento in h1 (font-display, text-page), la
//    riga della versione text-caption grigia, gli avvisi come righe del
//    sistema (Notice: icona lucide + testo text-small) — il «⚠» è un'icona —,
//    l'indice in una scheda rounded-surface (le voci text-body).
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { Archive, FileDown, TriangleAlert } from 'lucide-react'
import { api, useStore } from '../store'
import { formatDate } from '../lib/i18n'
import { pageHeadings, pageBody } from '../lib/page-view'
import { cn } from '../lib/utils'
import { DocumentBody } from './DocumentMarkdown'
import { Button } from './ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Notice } from './ui/notice'
import { PageHeader } from './ui/page-header'
import { PageShell } from './ui/page-shell'
import { LibraryItemMenu } from './LibraryPanel'
import type { LibraryItemInfo, LibraryContentInfo } from '../../../shared/types'

/** Quante voci dell'indice si vedono prima di «Mostra tutti (N)». */
const TOC_PREVIEW = 12
/** L'indice si mostra da questo numero di titoli in su. */
const TOC_MIN_HEADINGS = 4

/**
 * L'anello del fuoco dei controlli di testo del corpo (la riga della versione,
 * le voci dell'indice), SOLO da tastiera (focus-visible: la variante è quella
 * di B5, che non scatta dopo un clic del mouse).
 */
const TEXT_FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-ring'

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
  // B4: un giro di ricarica in più dopo un'azione del «⋯» (rinomina, pin, ripristino)
  const [reload, setReload] = useState(0)
  // D6 (fase deleghe): gli id dei documenti che esistono, per i link lib_…
  // nel corpo (il documento mancante diventa testo col tooltip)
  const [docIds, setDocIds] = useState<Set<string>>(new Set())
  // il contenitore dei titoli dell'indice: da qui si cerca la sezione da raggiungere
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
    <PageShell
      width="reading"
      z={20}
      testId="page-view"
      header={
        <PageHeader
          back={{
            onClick: back,
            label: info.from === 'library' ? t`Torna alla libreria` : t`Torna alla chat`,
            testId: 'page-close'
          }}
          // il titolo del documento nella testata, COMPATTO (lo cerca una sonda, deleghe, da questo
          // testid): il titolo vero è quello del documento, in cima al corpo (text-page in font-display).
          // Due titoli grandi a 60 px di distanza — la testata di pagina e l'h1 del documento — si
          // facevano concorrenza: qui resta la riga d'orientamento, text-body grigia, in Figtree
          // (font-display resta ai titoli). font-sans: dentro l'h1 della testata la famiglia sarebbe Bricolage
          title={<span data-testid="page-title-pill" className="font-sans text-body font-medium text-muted-foreground">{title}</span>}
          actions={
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  {/* no-drag: sta nella fascia che trascina la finestra, o il clic trascinerebbe la finestra */}
                  <Button variant="secondary" size="sm" className="no-drag" aria-label={t`Esporta`} data-testid="page-export">
                    <FileDown className="size-4" aria-hidden="true" />
                    <Trans>Esporta</Trans>
                  </Button>
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
            </>
          }
        />
      }
      // pt-6: 24 px di aria sotto la riga dei 52 — il titolo comincia dove cominciava prima (a 76 px)
      contentClassName="flex flex-col gap-block pt-6 pb-10"
    >
      {err && <p className="text-small text-destructive">{err}</p>}
      {!content && !err && <p className="text-small text-muted-foreground">…</p>}
      {content && (
        <div ref={scrollRef} className="flex flex-col gap-block">
          <div>
            <h1 className="font-display text-page font-semibold break-words" data-testid="page-title">{title}</h1>
            {/* la riga della versione porta allo storico della Libreria (Ripristina) */}
            <button
              type="button"
              className={cn('mt-1.5 rounded-control text-caption text-muted-foreground transition hover:text-foreground', TEXT_FOCUS)}
              data-testid="page-version"
              onClick={() => { closePage(); openLibrary(info.id) }}
            >
              <Trans>versione {version}</Trans> · <Trans>aggiornata {formatDate(item?.updatedAt ?? 0)}</Trans> ›
            </button>
          </div>
          {/* il «⚠» di prima è l'icona dell'avviso; la riga è quella del sistema (icona · testo text-small) */}
          {item?.tainted && (
            <Notice
              tone="destructive"
              icon={<TriangleAlert className="size-4" aria-hidden="true" />}
              className="rounded-control bg-destructive/10 px-3 py-2"
              testId="page-tainted"
            >
              <Trans>Proveniente da dati esterni</Trans>
            </Notice>
          )}
          {/* B4: la pagina è archiviata — si legge lo stesso; da qui si ripristina in Libreria */}
          {item?.archived === true && (
            <Notice
              icon={<Archive className="size-4" aria-hidden="true" />}
              className="rounded-control bg-muted/60 px-3 py-2"
              testId="page-archived-notice"
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="page-restore"
                  onClick={() => { void api.libraryArchive(info.id, false).then(reloadPage).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e))) }}
                >
                  <Trans>Ripristina</Trans>
                </Button>
              }
            >
              <Trans>Archiviata: non compare in Libreria finché non la ripristini.</Trans>
            </Notice>
          )}
          {headings.length >= TOC_MIN_HEADINGS && (
            <nav className="flex flex-col gap-2 rounded-surface bg-muted/60 p-4" aria-label={t`In questa pagina`} data-testid="page-toc">
              <div className="flex items-center gap-3 px-1.5">
                <p className="text-small font-medium text-muted-foreground"><Trans>In questa pagina</Trans></p>
                {/* più titoli di quanti se ne vedono: i primi TOC_PREVIEW, e «Mostra tutti (N)» sulla riga del titolo, a destra */}
                {headings.length > TOC_PREVIEW && !allHeadings && (
                  <button
                    type="button"
                    className={cn('ml-auto rounded-control py-0.5 text-small text-primary transition hover:underline', TEXT_FOCUS)}
                    data-testid="page-toc-all"
                    onClick={() => setAllHeadings(true)}
                  >
                    <Trans>Mostra tutti ({headings.length})</Trans>
                  </button>
                )}
              </div>
              <ul className="flex flex-col gap-0.5">
                {(allHeadings ? headings : headings.slice(0, TOC_PREVIEW)).map((h) => (
                  <li key={h.id} className={h.level === 3 ? 'pl-4' : undefined}>
                    {/* P5: righe più fitte (py-0.5) — con 12 voci l'indice non mangia mezza schermata prima del testo */}
                    <button
                      type="button"
                      className={cn('block w-full truncate rounded-control px-1.5 py-0.5 text-left text-body text-foreground/80 transition hover:bg-muted hover:text-foreground', TEXT_FOCUS)}
                      data-testid="page-toc-item"
                      onClick={() => goTo(h.id)}
                    >
                      {h.text}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {/* P2: il primo `# ` uguale al titolo non si riduplica nel corpo —
              il titolo lo mostra già la pagina; l'indice resta sul Markdown
              intero (un `# ` non c'è mai, gli id non cambiano) */}
          <DocumentBody
            markdown={pageBody(markdown, title)} headingIds={headings.map((h) => h.id)} typography="page"
            onOpenDoc={(id) => openPage(id, 'library')} docExists={(id) => docIds.has(id)}
          />
        </div>
      )}
    </PageShell>
  )
}
