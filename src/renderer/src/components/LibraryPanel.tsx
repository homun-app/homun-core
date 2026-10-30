// La LIBRERIA (fase 14, punti 1-5): una voce nella barra laterale, la lista
// con filtro per tipo e bot (fissate in alto), la vista del documento col
// Markdown reso (react-markdown, senza HTML grezzo) e i blocchi grafico —
// Vega-Lite come <img> dell'SVG generato dal daemon, Mermaid reso in modalità
// strict dalla UI e mostrato SEMPRE come <img> (mai nel DOM). Bottoni:
// Esporta (md/html/pdf per i documenti, svg/mmd per i grafici), Fissa,
// Rinomina, Cancella; le versioni col "ripristina come nuova versione".
// L'avviso di spazio (> 2 GB) sta in cima, nessun blocco.
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, useStore } from '../store'
import { renderVegaLiteInRenderer } from '../vega-render'
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

export function LibraryPanel() {
  const openLibraryId = useStore((s) => s.openLibraryId)
  const openLibrary = useStore((s) => s.openLibrary)
  if (openLibraryId === null) return null
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background/95 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-chart-2/80">Libreria</p>
          <h2 className="text-base font-semibold text-foreground">Documenti, grafici e file dei tuoi bot</h2>
        </div>
        <button className="rounded-md px-2 py-1 text-muted-foreground hover:text-foreground" onClick={() => openLibrary(null)}>
          ✕
        </button>
      </header>
      {openLibraryId === '' ? <LibraryList /> : <LibraryItemView id={openLibraryId} />}
    </div>
  )
}

function LibraryList() {
  const [items, setItems] = useState<LibraryItemInfo[]>([])
  const [kind, setKind] = useState<'' | 'document' | 'chart' | 'file'>('')
  const [author, setAuthor] = useState('')
  const [stats, setStats] = useState<{ bytes: number; warn: boolean } | null>(null)
  const agents = useStore((s) => s.agents)
  const openLibrary = useStore((s) => s.openLibrary)
  const [q, setQ] = useState('')

  const refresh = async () => {
    setItems(await api.libraryList(q || undefined, kind || undefined))
    setStats(await api.libraryStats().catch(() => null))
  }
  useEffect(() => { void refresh() }, [q, kind]) // eslint-disable-line react-hooks/exhaustive-deps

  const authors = useMemo(() => [...new Set(items.map((i) => i.authorAgentId))], [items])
  const shown = author ? items.filter((i) => i.authorAgentId === author) : items
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id

  return (
    <div className="flex-1 overflow-y-auto scroll-thin px-6 py-4">
      <div className="mx-auto max-w-3xl space-y-3">
        {stats?.warn && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            La libreria supera 2 GB: valuta cosa cancellare (nessun blocco automatico).
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="flex-1 rounded-lg bg-muted px-3 py-1.5 text-sm outline-none"
            placeholder="Cerca per titolo…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {(['', 'document', 'chart', 'file'] as const).map((k) => (
            <button
              key={k || 'tutti'}
              className={`rounded-lg px-2 py-1 text-xs ${kind === k ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted'}`}
              onClick={() => setKind(k)}
            >
              {k === '' ? 'Tutti' : k === 'document' ? 'Documenti' : k === 'chart' ? 'Grafici' : 'File'}
            </button>
          ))}
          <select
            className="rounded-lg bg-muted px-2 py-1 text-xs text-foreground"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          >
            <option value="">Tutti i bot</option>
            {authors.map((a) => <option key={a} value={a}>{nameOf(a)}</option>)}
          </select>
        </div>
        {shown.length === 0 && <p className="mt-16 text-center text-sm text-muted-foreground">La libreria è vuota: i documenti, i grafici e i file che i bot preparano finiscono qui.</p>}
        <div className="space-y-2">
          {shown.map((i) => (
            <div key={i.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/50 px-4 py-3">
              <button className="min-w-0 flex-1 text-left" onClick={() => openLibrary(i.id)}>
                <p className="truncate text-sm text-foreground">
                  {i.pinned && <span className="mr-1 text-destructive">★</span>}
                  {i.title}
                  {i.kind === 'document' && <span className="ml-2 text-xs text-muted-foreground">v{i.currentVersion}</span>}
                  {i.tainted && <span className="ml-2 text-xs text-destructive/80" title="Proveniente da dati esterni">⚠ esterno</span>}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {i.kind === 'document' ? 'documento' : i.kind === 'chart' ? `grafico ${i.chartKind ?? ''}` : `${i.fileName ?? 'file'} · ${i.fileSize ?? 0} byte`} · di {nameOf(i.authorAgentId)} · {new Date(i.updatedAt).toLocaleString('it-IT')}
                </p>
              </button>
              <ItemActions item={i} onChanged={() => void refresh()} compact />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Esporta/Fissa/Rinomina/Cancella (azioni dell'UTENTE, mai dei bot). */
function ItemActions({ item, onChanged, compact }: { item: LibraryItemInfo; onChanged: () => void; compact?: boolean }) {
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
        <button className="rounded-lg bg-primary px-2 py-1 text-xs text-white" onClick={() => void act(async () => { await api.libraryRename(item.id, title); setRenaming(false) })}>Salva</button>
        <button className="text-xs text-muted-foreground" onClick={() => setRenaming(false)}>Annulla</button>
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
          title={`Esporta in ~/Downloads/Homun (${f})`}
          onClick={() => void act(() => api.libraryExport(item.id, f))}
        >
          {f === 'file' ? 'Esporta' : f}
        </button>
      ))}
      <button disabled={busy} className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted" onClick={() => void act(() => api.libraryPin(item.id, !item.pinned))}>
        {item.pinned ? 'Sblocca' : 'Fissa'}
      </button>
      <button disabled={busy} className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted" onClick={() => setRenaming(true)}>Rinomina</button>
      <button
        disabled={busy}
        className="rounded-lg px-2 py-1 text-xs text-destructive/80 hover:bg-red-950/40"
        onClick={() => {
          if (confirm(`Cancellare «${item.title}» dalla libreria? Anche i file della voce vengono tolti.`)) void act(() => api.libraryDelete(item.id))
        }}
      >
        Cancella
      </button>
    </div>
  )
}

function LibraryItemView({ id }: { id: string }) {
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

  if (err) return <div className="flex-1 px-6 py-4 text-sm text-destructive">{err} <button className="underline" onClick={() => openLibrary('')}>torna alla lista</button></div>
  if (!content) return <div className="flex-1 px-6 py-4 text-sm text-muted-foreground">…</div>

  return (
    <div className="flex-1 overflow-y-auto scroll-thin px-6 py-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => openLibrary('')}>← Lista</button>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-semibold text-foreground">
              {item?.pinned && <span className="mr-1 text-destructive">★</span>}
              {item?.title ?? id}
            </h3>
            <p className="text-xs text-muted-foreground">
              {content.authorName}{item?.tainted ? ' · ⚠ proveniente da dati esterni' : ''}
            </p>
          </div>
          {item && <ItemActions item={item} onChanged={() => void refresh(version ?? undefined)} />}
        </div>

        {content.kind === 'document' && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              Versioni:
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
                  ↩ Ripristina v{version} come nuova versione
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
              File: {item?.fileName} ({item?.fileSize} byte) — esportalo per vederlo.
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
  if (!url) return <p className="text-xs text-muted-foreground">…grafico…</p>
  return <img className="max-w-full rounded-xl border border-border bg-white" src={url} alt={`grafico ${lang}`} />
}

function ChartBody({ content }: { content: LibraryContentInfo }) {
  if (content.svg) return <img className="max-w-full rounded-xl border border-border bg-white" src={svgDataUrl(content.svg)} alt="grafico" />
  return <InlineChart lang="mermaid" source={content.content ?? ''} />
}
