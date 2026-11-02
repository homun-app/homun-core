// La LIBRERIA (fase 14, punti 1-5 → fase 16c C6, tavola 4 destra): la vista
// globale con filtri «Tutti i bot ▾» e «Tutti i tipi ▾», la scelta griglia ▦ /
// elenco ☰ (ricordata in localStorage con try/catch), card senza bordo su
// bg-muted con anteprima (mini grafico dai dati salvati, prime righe dei
// documenti, badge dell'estensione per i file), titolo e «Tipo · Bot ·
// quando». La vista del documento col Markdown reso (react-markdown) e i
// blocchi grafico — Vega-Lite come <img> dell'SVG generato dal daemon,
// Mermaid in modalità strict, SEMPRE come <img> (mai nel DOM) — con versioni,
// esporta, rinomina e fissa resta quella di oggi.
import { useEffect, useMemo, useState } from 'react'
import { useLingui, Trans, Plural } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { formatDate } from '../lib/i18n'
import { ChevronLeft, LayoutGrid, List } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, useStore } from '../store'
import { renderVegaLiteInRenderer } from '../vega-render'
import { libraryRows, type LibraryKindFilter } from '../lib/library-view'
import type { LibraryItemInfo, LibraryContentInfo } from '../../../shared/types'

/** base64 → data URL per l'<img> (mai SVG nel DOM). */
const svgDataUrl = (svg: string): string =>
  'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))

/** Mermaid in modalità STRICT, reso dalla UI e mostrato come <img>. */
let mermaidReady: Promise<typeof import('mermaid').default> | null = null
async function renderMermaid(src: string): Promise<string | null> {
  try {
    mermaidReady ??= import('mermaid').then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false })
      return m.default
    })
    const mermaid = await mermaidReady
    const id = 'sandbot-mmd-' + Math.random().toString(36).slice(2, 10)
    const { svg } = await mermaid.render(id, src)
    return svg
  } catch {
    return null
  }
}

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
  document: msg`Documento`,
  chart: msg`Grafico`,
  file: msg`File`
}

export function LibraryPanel() {
  const openLibraryId = useStore((s) => s.openLibraryId)
  if (openLibraryId === null) return null
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background">
      {openLibraryId === '' ? <LibraryList /> : <LibraryItemView id={openLibraryId} />}
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
          : doc.split(/\n+/).filter((l) => l.trim()).slice(0, 4).map((line, i) => (
            <span key={i} className="line-clamp-1 text-[11px] leading-4 text-muted-foreground">{line.replace(/[#*_`>-]/g, '').slice(0, 90)}</span>
          ))}
      </div>
    )
  }
  // file: il badge dell'estensione
  const ext = (item.fileName ?? '').split('.').pop()?.toUpperCase() || 'FILE'
  return <div className="grid h-full w-full place-items-center text-2xl font-bold text-chart-2/80" aria-hidden="true">.{ext.toLowerCase()}</div>
}

function LibraryList() {
  const { t, i18n } = useLingui()
  const [items, setItems] = useState<LibraryItemInfo[]>([])
  const [kind, setKind] = useState<LibraryKindFilter>('')
  const [author, setAuthor] = useState('')
  const [stats, setStats] = useState<{ bytes: number; warn: boolean } | null>(null)
  const [view, setView] = useState<LibraryView>(readLibraryView)
  // fase 16c correzioni (R1): un RPC che fallisce non è «libreria vuota» —
  // riga d'errore con Riprova, mai lo stato vuoto in silenzio
  const [failed, setFailed] = useState(false)
  const agents = useStore((s) => s.agents)
  const openLibrary = useStore((s) => s.openLibrary)
  const [q, setQ] = useState('')

  const refresh = async () => {
    try {
      setItems(await api.libraryList(q || undefined, undefined))
      setFailed(false)
    } catch {
      setFailed(true)
    }
    setStats(await api.libraryStats().catch(() => null))
  }
  useEffect(() => { void refresh() }, [q]) // eslint-disable-line react-hooks/exhaustive-deps

  // fase 16c (C6): filtro per bot e tipo e ordine (fissati in cima) — PURA
  const shown = useMemo(() => libraryRows(items, author, kind), [items, author, kind])
  const authors = useMemo(() => [...new Set(items.map((i) => i.authorAgentId))], [items])
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id

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
            <option value="document">{i18n.t(msg`Documento`)}</option>
            <option value="chart">{i18n.t(msg`Grafico`)}</option>
            <option value="file">{i18n.t(msg`File`)}</option>
          </select>
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
        ) : shown.length === 0 && <p className="pt-16 text-center text-sm text-muted-foreground"><Trans>La libreria è vuota: i documenti, i grafici e i file che i bot preparano finiscono qui.</Trans></p>}
        {/* la griglia (tavola 4): card senza bordo su bg-muted */}
        {view === 'grid' ? (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
            {shown.map((i) => (
              <button key={i.id} className="group overflow-hidden rounded-[18px] text-left transition hover:bg-muted/80" onClick={() => openLibrary(i.id)}>
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
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {shown.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-3 rounded-[14px] bg-muted/60 px-4 py-3">
                <button className="min-w-0 flex-1 text-left" onClick={() => openLibrary(i.id)}>
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
                <ItemActions item={i} onChanged={() => void refresh()} compact />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Esporta/Fissa/Rinomina/Cancella (azioni dell'UTENTE, mai dei bot). */
function ItemActions({ item, onChanged, compact }: { item: LibraryItemInfo; onChanged: () => void; compact?: boolean }) {
  const { t } = useLingui()
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(item.title)
  const formats = item.kind === 'document' ? ['md', 'html', 'pdf'] : item.kind === 'chart' ? (item.chartKind === 'mermaid' ? ['mmd'] : ['svg']) : ['file']
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try { await fn() } finally { setBusy(false); onChanged() }
  }
  if (renaming) {
    return (
      <div className="flex items-center gap-2">
        <input className="rounded-lg bg-muted px-2 py-1 text-xs outline-none" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <button className="rounded-lg bg-primary px-2 py-1 text-xs text-white" onClick={() => void act(async () => { await api.libraryRename(item.id, title); setRenaming(false) })}><Trans>Salva</Trans></button>
        <button className="text-xs text-muted-foreground" onClick={() => setRenaming(false)}><Trans>Annulla</Trans></button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1">
      {!compact && <span className="text-xs text-muted-foreground">{item.id}</span>}
      {formats.map((f) => (
        <button
          key={f}
          disabled={busy}
          className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40"
          title={t`Esporta in ~/Downloads/Homun (${f})`}
          onClick={() => void act(() => api.libraryExport(item.id, f))}
        >
          {f === 'file' ? <Trans>Esporta</Trans> : f}
        </button>
      ))}
      <button disabled={busy} className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted" onClick={() => void act(() => api.libraryPin(item.id, !item.pinned))}>
        {item.pinned ? <Trans>Sblocca</Trans> : <Trans>Fissa</Trans>}
      </button>
      <button disabled={busy} className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted" onClick={() => setRenaming(true)}><Trans>Rinomina</Trans></button>
      <button
        disabled={busy}
        className="rounded-lg px-2 py-1 text-xs text-destructive/80 hover:bg-red-950/40"
        onClick={() => {
          if (confirm(t`Cancellare «${item.title}» dalla libreria? Anche i file della voce vengono tolti.`)) void act(() => api.libraryDelete(item.id))
        }}
      >
        <Trans>Cancella</Trans>
      </button>
    </div>
  )
}

function LibraryItemView({ id }: { id: string }) {
  const { t } = useLingui()
  const openLibrary = useStore((s) => s.openLibrary)
  const [item, setItem] = useState<LibraryItemInfo | null>(null)
  const [content, setContent] = useState<LibraryContentInfo | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [err, setErr] = useState('')

  const refresh = async (v?: number) => {
    try {
      const c = await api.libraryGet(id, v)
      setContent(c)
      setVersion(v ?? Math.max(...c.versions))
      const items = await api.libraryList(undefined, undefined)
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
          {item && <ItemActions item={item} onChanged={() => void refresh(version ?? undefined)} />}
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
            <DocumentBody markdown={content.content ?? ''} />
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

/** Il corpo di un documento: Markdown reso; i blocchi vega-lite/mermaid diventano <img>. */
function DocumentBody({ markdown }: { markdown: string }) {
  const parts = useMemo(() => {
    const out: Array<{ kind: 'md'; text: string } | { kind: 'vega-lite'; spec: string } | { kind: 'mermaid'; src: string }> = []
    const re = /```(vega-lite|mermaid)[ \t]*\r?\n([\s\S]*?)```/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(markdown)) !== null) {
      if (m.index > last) out.push({ kind: 'md', text: markdown.slice(last, m.index) })
      out.push(m[1] === 'vega-lite' ? { kind: 'vega-lite', spec: m[2] ?? '' } : { kind: 'mermaid', src: m[2] ?? '' })
      last = m.index + m[0].length
    }
    if (last < markdown.length) out.push({ kind: 'md', text: markdown.slice(last) })
    return out
  }, [markdown])
  return (
    <div className="space-y-3 text-sm leading-relaxed text-foreground">
      {parts.map((p, i) =>
        p.kind === 'md' ? (
          <div key={i} className="max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.text}</ReactMarkdown>
          </div>
        ) : (
          <InlineChart key={i} lang={p.kind} source={p.kind === 'vega-lite' ? p.spec : p.src} />
        )
      )}
    </div>
  )
}

/** Un grafico: Vega-Lite (SVG dal daemon) o Mermaid (strict, reso dalla UI) — sempre <img>. */
function InlineChart({ lang, source }: { lang: 'vega-lite' | 'mermaid'; source: string }) {
  // fase 17a: alt tradotti (il contenuto del grafico è dato del bot)
  const { t } = useLingui()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setFailed(false)
    setUrl(null)
    ;(async () => {
      if (lang === 'vega-lite') {
        const svg = await renderVegaLiteInRenderer(source)
        if (alive && svg) setUrl(svgDataUrl(svg))
        else if (alive) setFailed(true)
      } else {
        const svg = await renderMermaid(source)
        if (alive && svg) setUrl(svgDataUrl(svg))
        else if (alive) setFailed(true)
      }
    })()
    return () => { alive = false }
  }, [lang, source])
  if (failed) return <pre className="overflow-x-auto rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">{source}</pre>
  if (!url) return <p className="text-xs text-muted-foreground"><Trans>…grafico…</Trans></p>
  return <img className="max-w-full rounded-xl border border-border bg-white" src={url} alt={t`grafico ${lang}`} />
}

function ChartBody({ content }: { content: LibraryContentInfo }) {
  const { t } = useLingui()
  if (content.svg) return <img className="max-w-full rounded-xl border border-border bg-white" src={svgDataUrl(content.svg)} alt={t`grafico`} />
  return <InlineChart lang="mermaid" source={content.content ?? ''} />
}
