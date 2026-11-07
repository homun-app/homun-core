// Fase pagine (G2): il corpo di un documento della libreria — Markdown reso
// (react-markdown + remark-gfm, come la vista di oggi) con i blocchi
// ```vega-lite / ```mermaid resi come <img> dagli STESSI renderer e con le
// STESSE difese di vega-render.ts (dati solo inline, niente url/href/loader,
// loader che rifiuta tutto). Un blocco non valido si mostra come codice con
// una riga d'errore. Estratto dalla vista della Libreria perché ora lo usa
// anche la pagina aperta; con `headingIds` i titoli ##/### prendono l'id
// STABILE dell'indice (clic = scorre alla sezione).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { renderVegaLiteInRenderer } from '../vega-render'
import { pageHeadings } from '../lib/page-view'

/** base64 → data URL per l'<img> (mai SVG nel DOM). */
export const svgDataUrl = (svg: string): string =>
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

/** Un blocco del documento: Markdown, un grafico Vega-Lite o un diagramma Mermaid. */
type DocPart = { kind: 'md'; text: string } | { kind: 'vega-lite'; spec: string } | { kind: 'mermaid'; src: string }

/** I blocchi ```vega-lite / ```mermaid si spaccano dal Markdown (come la Libreria di oggi). */
export function docPartsOf(markdown: string): DocPart[] {
  const out: DocPart[] = []
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
}

/**
 * Una parte Markdown del documento: i titoli ##/### prendono gli id
 * dell'indice (la coda si inizializza a OGNI render: il doppio render di
 * StrictMode non consuma due volte).
 */
function MarkdownPart({ text, ids }: { text: string; ids: string[] | null }) {
  const queueRef = useRef<string[]>(ids ?? [])
  queueRef.current = ids ?? []
  const components = useMemo(() => ({
    h2: ({ children }: { children?: React.ReactNode }) => (
      <h2 id={queueRef.current.shift() ?? undefined}>{children}</h2>
    ),
    h3: ({ children }: { children?: React.ReactNode }) => (
      <h3 id={queueRef.current.shift() ?? undefined}>{children}</h3>
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])
  return (
    <div className="max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={ids ? components : undefined}>{text}</ReactMarkdown>
    </div>
  )
}

/**
 * Il corpo del documento. `headingIds`: quando la pagina lo usa, i titoli
 * ##/### prendono gli id dell'indice (pageHeadings) in ordine di documento —
 * così il clic sull'indice scorre alla sezione.
 */
export function DocumentBody({ markdown, headingIds, typography = 'compact' }: {
  markdown: string
  headingIds?: string[]
  /** compact = la vista della Libreria di oggi; page = tipografia da documento */
  typography?: 'compact' | 'page'
}) {
  const parts = useMemo(() => {
    const ps = docPartsOf(markdown)
    // gli id delle ancore si spartiscono fra le parti Markdown, in ordine
    let offset = 0
    return ps.map((p) => {
      if (!headingIds || p.kind !== 'md') return { part: p, ids: null as string[] | null }
      const n = pageHeadings(p.text).length
      const ids = headingIds.slice(offset, offset + n)
      offset += n
      return { part: p, ids }
    })
  }, [markdown, headingIds])
  return (
    <div className={typography === 'page' ? 'page-prose' : 'space-y-3 text-sm leading-relaxed text-foreground'}>
      {parts.map(({ part: p, ids }, i) =>
        p.kind === 'md'
          ? <MarkdownPart key={i} text={p.text} ids={ids} />
          : <InlineChart key={i} lang={p.kind} source={p.kind === 'vega-lite' ? p.spec : p.src} />
      )}
    </div>
  )
}

/**
 * Un grafico incorporato: Vega-Lite (stesso renderer e stesse difese di
 * vega-render.ts) o Mermaid (strict) — sempre <img>, mai SVG nel DOM. Un
 * blocco non valido si mostra come CODICE con una riga d'errore.
 */
export function InlineChart({ lang, source }: { lang: 'vega-lite' | 'mermaid'; source: string }) {
  const { t } = useLingui()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setFailed(false)
    setUrl(null)
    ;(async () => {
      const svg = lang === 'vega-lite' ? await renderVegaLiteInRenderer(source) : await renderMermaid(source)
      if (!alive) return
      if (svg) setUrl(svgDataUrl(svg))
      else setFailed(true)
    })()
    return () => { alive = false }
  }, [lang, source])
  if (failed) {
    return (
      <figure className="rounded-xl border border-border bg-muted/60 px-3 py-2">
        <figcaption className="mb-1.5 text-xs text-destructive/90">
          <Trans>Il blocco {lang} non si può rendere: resta il codice.</Trans>
        </figcaption>
        <pre className="overflow-x-auto text-xs text-muted-foreground">{source}</pre>
      </figure>
    )
  }
  if (!url) return <p className="text-xs text-muted-foreground"><Trans>…grafico…</Trans></p>
  return <img className="max-w-full rounded-xl border border-border bg-white" src={url} alt={t`grafico ${lang}`} />
}

/** Gli id dei titoli ##/### di un documento, nell'ordine (per le ancore). */
export function docHeadingIds(markdown: string): string[] {
  return pageHeadings(markdown).map((h) => h.id)
}
