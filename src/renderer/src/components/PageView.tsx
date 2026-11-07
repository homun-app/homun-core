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
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { X, FileDown } from 'lucide-react'
import { api, useStore } from '../store'
import { formatDate } from '../lib/i18n'
import { pageHeadings } from '../lib/page-view'
import { DocumentBody } from './DocumentMarkdown'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import type { LibraryItemInfo, LibraryContentInfo } from '../../../shared/types'

/** Quante voci dell'indice si vedono prima di «Mostra tutti (N)». */
const TOC_PREVIEW = 12
/** L'indice si mostra da questo numero di titoli in su. */
const TOC_MIN_HEADINGS = 4

export function PageView() {
  const { t } = useLingui()
  const info = useStore((s) => s.openPageInfo)
  const closePage = useStore((s) => s.closePage)
  const openLibrary = useStore((s) => s.openLibrary)
  const setPageMeta = useStore((s) => s.setPageMeta)
  const [content, setContent] = useState<LibraryContentInfo | null>(null)
  const [item, setItem] = useState<LibraryItemInfo | null>(null)
  const [err, setErr] = useState('')
  const [allHeadings, setAllHeadings] = useState(false)
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
        const items = await api.libraryList(undefined, undefined)
        if (!alive) return
        const it = items.find((i) => i.id === info.id) ?? null
        setItem(it)
        // il compositore usa titolo e versione corrente nella riga per il modello
        setPageMeta({ title: it?.title ?? info.id, version: Math.max(...c.versions) })
      })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.id])

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
  const goTo = (id: string): void => {
    scrollRef.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <div data-testid="page-view" className="no-drag absolute inset-0 z-20 flex flex-col bg-background">
      {/* la fascia alta: trascina la finestra; ✕, pillola del titolo, Esporta */}
      <div className="drag-region absolute inset-x-0 top-0 z-10 flex h-[60px] flex-col">
        <div className="mt-3 flex h-9 items-center gap-3 px-4">
          <button
            className="no-drag grid size-9 shrink-0 place-items-center rounded-full bg-muted/60 text-muted-foreground transition hover:text-foreground"
            aria-label={info.from === 'library' ? t`Torna alla libreria` : t`Torna alla chat`}
            title={info.from === 'library' ? t`Torna alla libreria` : t`Torna alla chat`}
            data-testid="page-close"
            onClick={back}
          >
            <X className="size-4" />
          </button>
          <span className="flex min-w-0 flex-1 justify-center">
            <span className="max-w-full truncate rounded-full bg-card/95 px-4 py-1.5 text-[15px] font-medium shadow-soft" data-testid="page-title-pill">
              {title}
            </span>
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="no-drag flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-muted/60 px-3 text-sm text-muted-foreground transition hover:text-foreground"
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
            {headings.length >= TOC_MIN_HEADINGS && (
              <nav className="mt-5 rounded-[16px] bg-muted/60 px-4 py-3" aria-label={t`In questa pagina`} data-testid="page-toc">
                <p className="text-xs font-semibold text-muted-foreground"><Trans>In questa pagina</Trans></p>
                <ul className="mt-1.5 space-y-0.5">
                  {(allHeadings ? headings : headings.slice(0, TOC_PREVIEW)).map((h) => (
                    <li key={h.id} className={h.level === 3 ? 'pl-4' : ''}>
                      <button
                        className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[13px] text-foreground/80 transition hover:bg-muted hover:text-foreground"
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
              <DocumentBody markdown={markdown} headingIds={headings.map((h) => h.id)} typography="page" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
