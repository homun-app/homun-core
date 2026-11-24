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
//
// Fase design (DS4, Chat): UN SOLO MARKDOWN. Prima qui c'erano due renderer
// con due insiemi di regole: BotMarkdown in Chat.tsx, nudo (i titoli e le
// tabelle prendevano quelle del browser, e con il reset di Tailwind un titolo
// usciva della stessa taglia del testo), e questo per i documenti. Le regole
// di DS1 stanno adesso in UN posto, PROSE qui sotto, e ci passa ogni testo
// reso: le bolle della chat, i messaggi della squadra, i pannelli di task e
// sottoagente (BotMarkdown) e i documenti (DocumentBody). Il documento APERTO
// (typography="page") mette sopra le sue regole .page-prose di styles.css —
// i titoli col carattere dei documenti — che, non essendo a livelli, vincono
// sulle utility: la pagina riusa lo stesso albero con la sua tipografia.
import { createElement, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { FileCog } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { renderVegaLiteInRenderer } from '../vega-render'
import { pageHeadings } from '../lib/page-view'
import { mapText } from '../lib/mentions'
import { cn } from '../lib/utils'

/*
 * LE REGOLE DEL TESTO RESO (DS1). La taglia la decide il contenitore — la
 * radice è text-reading (16/26: i messaggi della chat e il testo dei
 * documenti) — e la ereditano paragrafi, elenchi e citazioni. Una taglia
 * diversa si dichiara dove serve: i titoli (text-title, 20/28), il codice
 * (text-small), le celle di una tabella (text-body) e le sue intestazioni
 * (text-caption, grigie, in tono normale: nessun maiuscoletto).
 * A ogni elemento react-markdown passa anche `node` (il suo nodo dell'albero
 * del markdown): NON va sul DOM, si toglie prima di spargere le altre prop.
 */

/**
 * «Sono dentro un <pre>». Un <code> è di blocco quando sta in un <pre> e
 * inline altrimenti — lo dice il SUO POSTO, non una classe `language-*` (un
 * blocco senza lingua dichiarata è comunque un blocco). Il <pre> lo scrive
 * nel contesto e il <code> figlio lo legge: è l'unico modo affidabile, perché
 * a un componente react-markdown passa il suo nodo, non il padre.
 */
const DentroPre = createContext(false)

/** Le classi dei titoli: le stesse anche al documento che dà loro un id. */
const TITOLO = {
  h1: 'mt-2 text-title font-semibold first:mt-0',
  h2: 'mt-2 text-title font-semibold first:mt-0',
  h3: 'mt-1 font-semibold first:mt-0'
} as const

/** PROSE: le regole di DS1 per ogni elemento del markdown. L'unico posto. */
const PROSE: Components = {
  h1: ({ node: _n, ...p }) => <h1 {...p} className={TITOLO.h1} />,
  h2: ({ node: _n, ...p }) => <h2 {...p} className={TITOLO.h2} />,
  h3: ({ node: _n, ...p }) => <h3 {...p} className={TITOLO.h3} />,
  // da h4 in giù cambia solo il peso: restano della misura del testo
  h4: ({ node: _n, ...p }) => <h4 {...p} className="font-semibold" />,
  h5: ({ node: _n, ...p }) => <h5 {...p} className="font-semibold" />,
  h6: ({ node: _n, ...p }) => <h6 {...p} className="font-semibold" />,
  // un link si riconosce dalla sottolineatura: il colore resta quello del testo
  a: ({ node: _n, ...p }) => <a {...p} className="underline underline-offset-2" />,
  ul: ({ node: _n, ...p }) => <ul {...p} className="list-disc pl-6" />,
  ol: ({ node: _n, ...p }) => <ol {...p} className="list-decimal pl-6" />,
  // la voce resta una voce di elenco: il pallino vive sul <li>, e su un
  // elemento flex il marcatore sparisce. I blocchi dentro di lei (un elenco
  // «largo»: due paragrafi per voce) stanno in un involucro che li distanzia
  li: ({ node: _n, children, ...p }) => (
    <li {...p} className="my-0.5">
      <div className="flex flex-col gap-2">{children}</div>
    </li>
  ),
  blockquote: ({ node: _n, ...p }) => <blockquote {...p} className="border-l-2 border-border pl-3" />,
  // i pesi sono tre: il grassetto del browser (700) non esiste nella scala
  strong: ({ node: _n, ...p }) => <strong {...p} className="font-semibold" />,
  code: ({ node: _n, className, children, ...p }) => {
    const blocco = useContext(DentroPre)
    return (
      // nel blocco il fondo, il raggio e il respiro sono del <pre>: dentro, il codice è nudo
      <code {...p} className={cn('font-mono text-small', !blocco && 'rounded-control bg-muted px-1.5 py-0.5', className)}>
        {children}
      </code>
    )
  },
  // il blocco di codice scorre DENTRO se stesso: una riga lunga non allarga mai la bolla
  pre: ({ node: _n, children, ...p }) => (
    <DentroPre.Provider value={true}>
      <pre {...p} className="scroll-thin overflow-x-auto rounded-control bg-muted p-3 font-mono text-small">{children}</pre>
    </DentroPre.Provider>
  ),
  // la tabella sta in un contenitore che scorre in orizzontale: se è più
  // larga della colonna scorre lei, mai la pagina
  table: ({ node: _n, children, ...p }) => (
    <div className="w-full scroll-thin overflow-x-auto">
      <table {...p} className="w-full border-collapse text-left">{children}</table>
    </div>
  ),
  // intestazioni: taglia didascalia, grigie, in tono normale, nessuno sfondo;
  // filetti fra le righe come nelle tabelle dell'interfaccia. La prima
  // colonna parte in linea col testo (niente respiro a sinistra)
  th: ({ node: _n, ...p }) => (
    <th {...p} className="border-b border-border/50 px-3 py-2 text-left align-middle font-normal whitespace-nowrap text-caption text-muted-foreground first:pl-0" />
  ),
  td: ({ node: _n, ...p }) => (
    <td {...p} className="border-b border-border/50 px-3 py-2 text-left align-top text-body first:pl-0" />
  ),
  img: ({ node: _n, ...p }) => <img {...p} className="max-w-full rounded-surface" />,
  hr: ({ node: _n, ...p }) => <hr {...p} className="border-t border-border" />
}

/** Le regole di DS1 più ciò che chi chiama aggiunge o sostituisce (i link di un documento, gli id dei titoli). */
const proseWith = (extra?: Components): Components => ({ ...PROSE, ...extra })

/** Gli elementi del markdown che portano TESTO (dentro possono stare le @menzioni della squadra). */
const TAG_DI_TESTO = ['p', 'li', 'td', 'th', 'strong', 'em', 'del', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

/**
 * Le regole del markdown per gli elementi di testo, coi pezzi di TESTO
 * passati da `fn` PRIMA di essere resi: la squadra ci cerca le @menzioni
 * (lib/mentions.ts: mapText cambia il contenuto di un albero, mai la forma).
 * La forma resta quella di PROSE — per il tag che non ha una regola sua (p,
 * em, del) la base è il tag nudo. Si danno a `components` di BotMarkdown, e
 * sostituiscono la regola di PROSE per quel tag con la stessa, col testo
 * passato da `fn`.
 */
export function proseWithText(fn: (text: string) => ReactNode): Components {
  return Object.fromEntries(TAG_DI_TESTO.map((tag) => {
    const base = (PROSE as Record<string, unknown>)[tag] ?? tag
    return [tag, ({ node: _n, children, ...rest }: { node?: unknown; children?: ReactNode } & Record<string, unknown>) =>
      createElement(base as never, { ...rest, children: mapText(children, fn) } as never)]
  })) as Components
}

/**
 * Il markdown di un testo di bot — UN componente per tutte le risposte (B1,
 * fase b20-bug: titoli, grassetto, elenchi, codice e tabelle si vedono
 * uguali ovunque), con le regole di DS1. `components` aggiunge o sostituisce
 * un elemento (il documento: i suoi link, gli id dei titoli).
 * La radice è una colonna flex con gap-3: i blocchi stanno a 12 px l'uno
 * dall'altro. I margini dei paragrafi li azzera il reset di Tailwind: senza
 * questo, due paragrafi consecutivi si leggevano come righe consecutive.
 * min-w-0: dentro una bolla (una riga flex) il contenuto lungo non ne impone
 * la larghezza — cedono la tabella e il blocco di codice, che scorrono dentro.
 */
export function BotMarkdown({ text, components, className }: {
  text: string
  components?: Components
  className?: string
}): React.ReactNode {
  return (
    <div className={cn('flex min-w-0 flex-col gap-3 text-reading', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={proseWith(components)}>{text}</ReactMarkdown>
    </div>
  )
}

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
        className="inline-flex items-center gap-1 rounded-control bg-muted/70 px-1.5 py-0.5 font-mono text-small text-muted-foreground hover:text-foreground"
        title={t`percorso del computer dei bot — clic per copiare`}
        onClick={() => { void navigator.clipboard?.writeText(target.path).catch(() => undefined) }}
      >
        <FileCog className="size-4" aria-hidden />
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
 * Le regole sono quelle di PROSE, le stesse dei messaggi di bot. Il documento
 * APERTO (typography="page", la classe .page-prose) ci mette sopra le sue
 * differenze — i titoli col carattere dei documenti — che, non essendo a
 * livelli, vincono sulle utility.
 */
function MarkdownPart({ text, ids, onOpenDoc, docExists }: {
  text: string
  ids: string[] | null
  onOpenDoc?: (id: string) => void
  docExists?: (id: string) => boolean
}) {
  const queueRef = useRef<string[]>(ids ?? [])
  queueRef.current = ids ?? []
  const components = useMemo(() => proseWith({
    ...(ids ? {
      h2: ({ node: _n, ...p }) => <h2 {...p} id={queueRef.current.shift() ?? undefined} className={TITOLO.h2} />,
      h3: ({ node: _n, ...p }) => <h3 {...p} id={queueRef.current.shift() ?? undefined} className={TITOLO.h3} />
    } : {}),
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <DocLink href={href} onOpenDoc={onOpenDoc} docExists={docExists}>{children}</DocLink>
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [onOpenDoc, docExists])
  return <BotMarkdown text={text} components={components} />
}

/**
 * Il corpo del documento. `headingIds`: quando la pagina lo usa, i titoli
 * ##/### prendono l'id dell'indice (pageHeadings) in ordine di documento —
 * così il clic sull'indice scorre alla sezione. D6: `onOpenDoc`/`docExists`
 * cablano i link lib_… all'apertura del documento (chi renderizza li passa
 * dallo store; senza, i link doc restano bottoni che non aprono nulla).
 * Fase design (DS4): è testo di lettura come i messaggi della chat, con le
 * stesse regole (PROSE). I blocchi — le parti Markdown e i grafici — stanno a
 * 12 px l'uno dall'altro; a pagina lo fa .page-prose (styles.css).
 */
export function DocumentBody({ markdown, headingIds, typography = 'compact', onOpenDoc, docExists }: {
  markdown: string
  headingIds?: string[]
  /** compact = il documento nella Libreria; page = il documento aperto (i titoli col carattere dei documenti) */
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
    <div className={typography === 'page' ? 'page-prose' : 'flex flex-col gap-3 text-foreground'}>
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
      <figure className="rounded-surface border border-border bg-muted/60 p-3">
        <figcaption className="mb-1.5 text-small text-destructive">
          <Trans>Il blocco {lang} non si può rendere: resta il codice.</Trans>
        </figcaption>
        {/* il codice che resta è un blocco di codice: le stesse regole di PROSE */}
        <pre className="scroll-thin overflow-x-auto rounded-control bg-card p-3 font-mono text-small text-muted-foreground">{source}</pre>
      </figure>
    )
  }
  if (!url) return <p className="text-small text-muted-foreground"><Trans>…grafico…</Trans></p>
  return <img className="max-w-full rounded-surface border border-border bg-white" src={url} alt={t`grafico ${lang}`} />
}

