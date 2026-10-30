// Grafici e documenti — modulo PURO della validazione (fase 14, punti 2-3-5):
// i grafici sono SOLO dichiarativi (Vega-Lite JSON o Mermaid), MAI HTML o
// JavaScript scritti dal modello. Qui vivono le regole:
// - Vega-Lite: JSON valido fino a 200 KB, NESSUNA chiave `url` né `href` a
//   qualunque profondità e nessun `loader`: i dati sono solo inline
//   (data.values / datasets), al massimo 5000 righe — un grafico non fa
//   richieste di rete né link cliccabili (P6 fase 14 correzioni);
// - Mermaid: sorgente fino a 50 KB (lo rende la UI in modalità strict);
// - i blocchi ```vega-lite / ```mermaid di un documento si validano PRIMA di
//   scrivere qualunque versione: un blocco non valido fa fallire la chiamata
//   con l'errore preciso;
// - l'HTML di esportazione è AUTONOMO: CSS in linea, SVG in linea, Mermaid
//   come blocco di codice, nessuno script e nessuna risorsa esterna (nemmeno
//   link cliccabili http/https).
// La RESA SVG (vega → view.toSVG() col loader che rifiuta ogni richiesta) sta
// in library.ts: qui niente dipendenze pesanti, i test girano in nodo puro.

// fase 17c (C3): l'esportazione che legge l'utente segue la lingua dell'interfaccia
import { uiLanguage, formatUi, ui } from '../ui-language'
import { UI } from '../../shared/ui-messages'

/** Tetto della spec Vega-Lite (JSON grezzo, punto 3). */
export const VEGA_SPEC_MAX_BYTES = 200 * 1024

/** Tetto delle righe di dati inline (data.values + datasets, punto 3). */
export const VEGA_MAX_ROWS = 5000

/** Tetto del sorgente Mermaid (punto 3). */
export const MERMAID_MAX_BYTES = 50 * 1024

/** Tetto del Markdown di un documento (punto 1). */
export const DOCUMENT_MAX_BYTES = 200 * 1024

export type ChartSpecCheck =
  | { ok: true; spec: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * La validazione PURA di una spec Vega-Lite (punto 3 + P6 fase 14 correzioni):
 * JSON, tetto, NESSUNA chiave `url` né `href` a qualunque profondità, nessun
 * `loader`, dati solo inline col tetto delle righe. `url` si cerca ovunque
 * (anche in transform, layer, facet: un deep-link in una chiave ignota non
 * deve passare); P6: anche `href` (il link di mark/encoding che Vega-Lite
 * rende cliccabile) si rifiuta a qualunque profondità — arrivava alla resa e
 * falliva con `loader._loader.sanitize is not a function`, incomprensibile
 * per il modello.
 */
export function validateVegaLiteSpec(raw: string): ChartSpecCheck {
  if (!raw.trim()) return { ok: false, error: 'empty Vega-Lite spec' }
  if (Buffer.byteLength(raw, 'utf8') > VEGA_SPEC_MAX_BYTES) {
    return { ok: false, error: `spec too large (${Buffer.byteLength(raw, 'utf8')} bytes, limit ${VEGA_SPEC_MAX_BYTES}): reduce the data` }
  }
  let spec: unknown
  try {
    spec = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    return { ok: false, error: 'the Vega-Lite spec must be a JSON object' }
  }
  const forbidden = findKey(spec, 'url')
  if (forbidden) return { ok: false, error: `key "url" not allowed (${forbidden}): the chart data is inline only (data.values), the chart makes no network requests` }
  const href = findKey(spec, 'href')
  if (href) return { ok: false, error: `key "href" not allowed (links in charts) (${href})` }
  if (findKey(spec, 'loader')) return { ok: false, error: 'key "loader" not allowed: data loading is decided by the daemon, not the spec' }
  const rows = countInlineRows(spec)
  if (rows > VEGA_MAX_ROWS) {
    return { ok: false, error: `too much inline data (${rows} rows, limit ${VEGA_MAX_ROWS}): summarize or sample` }
  }
  return { ok: true, spec: spec as Record<string, unknown> }
}

/** La prima strada di una chiave vietata a qualunque profondità (puro). */
function findKey(value: unknown, key: string, path = ''): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findKey(value[i], key, `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === key) return path ? `${path}.${k}` : k
      const hit = findKey(v, key, path ? `${path}.${k}` : k)
      if (hit) return hit
    }
  }
  return null
}

/** Il totale delle righe dei dati inline: data.values di ogni nodo + datasets. */
function countInlineRows(spec: unknown): number {
  let rows = 0
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const obj = value as Record<string, unknown>
    const data = obj.data
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const values = (data as Record<string, unknown>).values
      if (Array.isArray(values)) rows += values.length
    }
    if (obj.datasets && typeof obj.datasets === 'object' && !Array.isArray(obj.datasets)) {
      for (const v of Object.values(obj.datasets as Record<string, unknown>)) {
        if (Array.isArray(v)) rows += v.length
      }
    }
    for (const v of Object.values(obj)) walk(v)
  }
  walk(spec)
  return rows
}

/** La validazione PURA di un sorgente Mermaid (punto 3): solo il tetto. */
export function validateMermaidSource(raw: string): { ok: true } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: false, error: 'empty Mermaid source' }
  if (Buffer.byteLength(raw, 'utf8') > MERMAID_MAX_BYTES) {
    return { ok: false, error: `diagram too large (${Buffer.byteLength(raw, 'utf8')} bytes, limit ${MERMAID_MAX_BYTES})` }
  }
  return { ok: true }
}

// ---- i blocchi grafico dentro un documento (punto 2) ----

export interface ChartBlock {
  /** vega-lite | mermaid */
  lang: 'vega-lite' | 'mermaid'
  /** il corpo del blocco (spec JSON o sorgente del diagramma) */
  body: string
}

/**
 * I blocchi grafico di un documento Markdown (PURO): ```vega-lite e
 * ```mermaid (info-string esatta, come la usa la UI per rendere il blocco).
 */
export function extractChartBlocks(markdown: string): ChartBlock[] {
  const blocks: ChartBlock[] = []
  const re = /^```(vega-lite|mermaid)[ \t]*\r?\n([\s\S]*?)^```\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    blocks.push({ lang: m[1]! as ChartBlock['lang'], body: m[2] ?? '' })
  }
  return blocks
}

/**
 * La validazione di TUTTI i blocchi grafico di un documento (punto 2): il
 * primo non valido vince e l'errore dice blocco e motivo — nessuna versione
 * viene scritta.
 */
export function validateDocumentCharts(markdown: string): { ok: true } | { ok: false; error: string } {
  const blocks = extractChartBlocks(markdown)
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    const check = b.lang === 'vega-lite' ? validateVegaLiteSpec(b.body) : validateMermaidSource(b.body)
    if (!check.ok) {
      return { ok: false, error: `block ${b.lang} no. ${i + 1} invalid: ${check.error}` }
    }
  }
  return { ok: true }
}

// ---- le sostituzioni esatte (punto 2, come il text editor di Anthropic) ----

export type EditCheck =
  | { ok: true; text: string }
  | { ok: false; error: string }

/**
 * Applica le modifiche esatte `old → new` in ordine (PURO, punto 2): ogni
 * `old` deve comparire ESATTAMENTE una volta nella versione corrente, altrimenti
 * l'errore dice quante volte compare e NESSUNA modifica si applica (mai
 * modifiche parziali).
 */
export function applyExactEdits(current: string, edits: Array<{ old: string; new: string }>): EditCheck {
  if (!edits.length) return { ok: false, error: 'no edits: edits [{old, new}] are required' }
  let text = current
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!
    if (!e.old) return { ok: false, error: `edit no. ${i + 1}: empty old` }
    const count = text.split(e.old).length - 1
    if (count === 0) {
      return { ok: false, error: `edit no. ${i + 1}: "${e.old.slice(0, 80)}${e.old.length > 80 ? '…' : ''}" does not appear in the document (0 times): no edit applied` }
    }
    if (count > 1) {
      return { ok: false, error: `edit no. ${i + 1}: "${e.old.slice(0, 80)}${e.old.length > 80 ? '…' : ''}" appears ${count} times (it must appear exactly once): no edit applied` }
    }
    text = text.replace(e.old, e.new)
  }
  return { ok: true, text }
}

// ---- l'HTML autonomo (punto 5) ----

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Un Markdown MINIMO per l'export HTML (PURO): titoli, paragrafi, grassetto/
 * corsivo/codice inline, blocchi di codice, liste, citazioni, tabelle GFM e
 * separatori. I LINK non diventano `<a href>` (nessuna risorsa esterna nel
 * file: il testo del link e il suo URL restano visibili come testo). Non è un
 * renderer GFM completo: l'HTML di esportazione deve essere autonomo e senza
 * risorse, non fedele al pixel.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      // [testo](url) → testo (url): il link resta LEGGIBILE ma non è una risorsa
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => `${text} (${url})`)

  while (i < lines.length) {
    const line = lines[i]!
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!)
      i++ // chiude il recinto
      out.push(`<pre data-lang="${escapeHtml(lang)}">${escapeHtml(body.join('\n'))}</pre>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      i++
      continue
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ''))
      out.push(`<blockquote><p>${inline(body.join(' '))}</p></blockquote>`)
      continue
    }
    // tabella GFM: riga | celle |, poi |---|---|
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
      const cells = (row: string): string[] => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!))
      out.push(
        '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      )
      continue
    }
    if (/^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      const ordered = /^\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && (ordered ? /^\d+[.)]\s+/.test(lines[i]!) : /^[-*+]\s+/.test(lines[i]!))) {
        const clean = lines[i++]!.replace(/^([-*+]|\d+[.)])\s+/, '')
        items.push(`<li>${inline(clean)}</li>`)
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|>|\||[-*+]\s|\d+[.)]\s|---)/.test(lines[i]!)) {
      para.push(lines[i++]!)
    }
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('\n')
}

/** Il CSS in linea del documento esportato (nessuna risorsa esterna). */
export const EXPORT_CSS = `body{font-family:-apple-system,"Segoe UI",sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1f2328;line-height:1.6}
h1,h2,h3{line-height:1.25}pre{background:#f5f6f8;border:1px solid #e2e4e8;border-radius:6px;padding:.75rem;overflow-x:auto;font-size:.85rem}
code{background:#f5f6f8;border-radius:4px;padding:.1rem .3rem}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #d9dbe0;padding:.4rem .6rem;text-align:left}blockquote{border-left:3px solid #d0d3d9;margin:0;padding-left:1rem;color:#59626e}
img{max-width:100%;height:auto}figure{margin:1rem 0;text-align:center}figcaption{font-size:.8rem;color:#59626e}`

export interface ExportChartSvg {
  /** l'SVG in linea che sostituisce il blocco vega-lite nel documento */
  svg: string
}

/**
 * L'HTML AUTONOMO di un documento (PURO, punto 5): CSS in linea, i blocchi
 * vega-lite sostituiti dall'SVG in linea generato dal daemon (via placeholder,
 * così il renderer markdown non li tocca), i blocchi mermaid lasciati come
 * blocco di codice, titoli e metadati in testa. Nessuno script, nessuna
 * risorsa esterna, nessun href/src http(s).
 */
export function documentToHtml(item: { title: string; authorName: string; version: number }, markdown: string, svgsByIndex: string[]): string {
  let svgIdx = 0
  const placeholders: string[] = []
  const replaced = markdown.replace(/^```(vega-lite|mermaid)[ \t]*\r?\n([\s\S]*?)^```\s*$/gm, (_m, lang: string, body: string) => {
    if (lang === 'vega-lite') {
      const token = `SANSBOT-CHART-${placeholders.length}-SANSBOT`
      placeholders.push(svgsByIndex[svgIdx++] ?? '')
      return token
    }
    return '```' + lang + '\n' + body + '```'
  })
  let body = markdownToHtml(replaced)
  // il SVG in linea entra DOPO la resa markdown (via placeholder): il
  // renderer non lo può né escapare né rompere
  for (let i = 0; i < placeholders.length; i++) {
    const svg = placeholders[i]!
    // l'SVG è phrasing content: sta bene dentro il <p> del paragrafo
    body = body.split(`SANSBOT-CHART-${i}-SANSBOT`).join(svg || formatUi(ui(UI.chartNotAvailable), uiLanguage()))
  }
  const meta = [
    `<title>${escapeHtml(item.title)}</title>`,
    `<meta charset="utf-8">`,
    `<meta name="generator" content="Homun">`
  ].join('\n    ')
  // fase 17c (C3): il documento esportato è per l'utente — lang e testi
  // nella lingua dell'interfaccia
  const lang = uiLanguage()
  return `<!DOCTYPE html>
<html lang="${lang}">
  <head>
    ${meta}
    <style>${EXPORT_CSS}</style>
  </head>
  <body>
    <h1>${escapeHtml(item.title)}</h1>
    <p class="meta">${formatUi(ui(UI.chartMetaLine, { author: escapeHtml(item.authorName), version: item.version }), lang)}</p>
${body}
  </body>
</html>`
}
