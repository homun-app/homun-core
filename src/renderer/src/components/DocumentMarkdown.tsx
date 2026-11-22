// Fase pagine (G2): il corpo di un documento della libreria — Markdown reso
// (react-markdown + remark-gfm, come la vista di oggi) con i blocchi
// ```vega-lite / ```mermaid resi come <img> dagli STESSI renderer e con le
// STESSE difese di vega-render.ts (dati solo inline, niente url/href/loader,
// loader che rifiuta tutto). Un blocco non valido si mostra come codice con
// una riga d'errore. Estratto dalla vista della Libreria perché ora lo usa
// anche la pagina aperta; con `headingIds` i titoli ##/### prendono l'id
// STABILE dell'indice (clic = scorre alla sezione).
// D6 (fase deleghe): il componente `a` esiste SEMPRE (non solo con gli id)
// e la decisione è la funzione PURA docLinkTarget — lib_… apre il documento
// nella Libreria, #ancora scorre, http(s) va al browser esterno SENZA
// navigare, /workspace e /box restano percorsi, tutto il resto è testo: un
// link scritto in un documento non può ricaricare o svuotare la finestra.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { FileCog } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { renderVegaLiteInRenderer } from '../vega-render'
import { pageHeadings } from '../lib/page-view'

/** base64 → data URL per l'<img> (mai SVG nel DOM). */
export const svgDataUrl = (svg: string): string =>
  'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))

// ---- D6 (fase deleghe): la decisione dei link dei documenti (pura) ----

/** Cosa fare di un href trovato nel Markdown di un documento. */
export type DocLinkTarget =
  | { kind: 'doc'; id: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'external'; url: string }
  | { kind: 'path'; path: string }
  | { kind: 'none' }

const LIB_ID = /^lib_[A-Za-z0-9_-]+$/

/**
 * La tabella dei casi (pura, testata): lib_<id> (anche homun://app/lib_<id> e
 * #lib_<id>) apre quel documento; #<ancora> scorre alla sezione; http(s)/
 * mailto vanno al browser esterno; /workspace/… e /box/… sono percorsi del
 * computer dei bot (mostrati, mai navigati); TUTTO il resto — file:,
 * javascript:, schemi sconosciuti, percorsi relativi — è testo, mai
 * navigazione.
 */
export function docLinkTarget(href: string | undefined): DocLinkTarget {
  const h = String(href ?? '').trim()
  if (!h) return { kind: 'none' }
  if (h.startsWith('#')) {
    const id = h.slice(1)
    return LIB_ID.test(id) ? { kind: 'doc', id } : { kind: 'anchor', id }
  }
  if (LIB_ID.test(h)) return { kind: 'doc', id: h }
  const appLib = /^homun:\/\/app\/(lib_[A-Za-z0-9_-]+)\/?$/.exec(h)
  if (appLib) return { kind: 'doc', id: appLib[1]! }
  if (/^https?:\/\//i.test(h) || /^mailto:/i.test(h)) return { kind: 'external', url: h }
  if (h.startsWith('/workspace/') || h === '/workspace' || h.startsWith('/box/') || h === '/box') {
    return { kind: 'path', path: h }
  }
  // javascript:, file:, homun://app/… non-doc, relativi, schemi sconosciuti
  return { kind: 'none' }
}

/** Il rendering di UN link di documento (la decisione è docLinkTarget). */
function DocLink({ href, children, onOpenDoc, docExists }: {
  href?: string
  children?: React.ReactNode
  onOpenDoc?: (id: string) => void
  docExists?: (id: string) => boolean
}) {
  const { t } = useLingui()
  const target = docLinkTarget(href)
  if (target.kind === 'doc') {
    const exists = docExists ? docExists(target.id) : true
    if (!exists) {
      return <span className="cursor-help underline decoration-dotted" title={t`documento non trovato`}>{children}</span>
    }
    return (
      <button
        type="button" data-testid="doc-link" data-doc={target.id}
        className="cursor-pointer text-left underline decoration-muted-foreground/50 hover:decoration-foreground"
        onClick={() => onOpenDoc?.(target.id)}
      >
        {children}
      </button>
    )
  }
  if (target.kind === 'anchor') {
    return (
      <a
        href={`#${target.id}`}
        onClick={(e) => {
          e.preventDefault()
          document.getElementById(target.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }}
      >
        {children}
      </a>
    )
  }
  if (target.kind === 'external') {
    // mai navigazione: window.open passa dal setWindowOpenHandler del main,
    // che lo manda al browser esterno SOLO dopo canOpenExternally
    return (
      <a
        href={target.url} target="_blank" rel="noopener noreferrer"
        onClick={(e) => {
          e.preventDefault()
          window.open(target.url, '_blank', 'noopener')
        }}
      >
        {children}
      </a>
    )
  }
  if (target.kind === 'path') {
    // il percorso del computer ISOLATO dei bot: il pannello Computer non sa
    // aprirsi SU un file, quindi il clic COPIA il percorso (scelta D6, nel
    // REPORT); mai navigazione
    return (
      <button
        type="button" data-testid="doc-path"
        className="inline-flex items-center gap-1 rounded-md bg-muted/70 px-1.5 py-0.5 font-mono text-[0.85em] text-muted-foreground hover:text-foreground"
        title={t`percorso del computer dei bot — clic per copiare`}
        onClick={() => { void navigator.clipboard?.writeText(target.path).catch(() => undefined) }}
      >
        <FileCog size={11} aria-hidden />
        {target.path}
      </button>
    )
  }
  return <span>{children}</span>
}

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
 * StrictMode non consuma due volte). D6: il componente `a` c'è SEMPRE, anche
 * senza id (prima `components` si passava solo con gli id e i link restavano
 * <a> nudi che navigavano).
 */
function MarkdownPart({ text, ids, onOpenDoc, docExists }: {
  text: string
  ids: string[] | null
  onOpenDoc?: (id: string) => void
  docExists?: (id: string) => boolean
}) {
  const queueRef = useRef<string[]>(ids ?? [])
  queueRef.current = ids ?? []
  const components = useMemo(() => ({
    ...(ids ? {
      h2: ({ children }: { children?: React.ReactNode }) => (
        <h2 id={queueRef.current.shift() ?? undefined}>{children}</h2>
      ),
      h3: ({ children }: { children?: React.ReactNode }) => (
        <h3 id={queueRef.current.shift() ?? undefined}>{children}</h3>
      )
    } : {}),
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <DocLink href={href} onOpenDoc={onOpenDoc} docExists={docExists}>{children}</DocLink>
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [onOpenDoc, docExists])
  return (
    <div className="max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  )
}

/**
 * Il corpo del documento. `headingIds`: quando la pagina lo usa, i titoli
 * ##/### prendono gli id dell'indice (pageHeadings) in ordine di documento —
 * così il clic sull'indice scorre alla sezione. D6: `onOpenDoc`/`docExists`
 * cablano i link lib_… all'apertura del documento (chi renderizza li passa
 * dallo store; senza, i link doc restano bottoni che non aprono nulla).
 */
export function DocumentBody({ markdown, headingIds, typography = 'compact', onOpenDoc, docExists }: {
  markdown: string
  headingIds?: string[]
  /** compact = la vista della Libreria di oggi; page = tipografia da documento */
  typography?: 'compact' | 'page'
  /** D6: apre il documento lib_… (stesso percorso del clic su una card) */
  onOpenDoc?: (id: string) => void
  /** D6: il documento esiste? (false → testo col tooltip «documento non trovato») */
  docExists?: (id: string) => boolean
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
          ? <MarkdownPart key={i} text={p.text} ids={ids} onOpenDoc={onOpenDoc} docExists={docExists} />
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
