// La LIBRERIA (fase 14, punti 1-6): un posto solo per tutto ciò che i bot
// producono per l'utente — documenti con VERSIONI mai sovrascritte (v1.md,
// v2.md, …), grafici (Vega-Lite resi in SVG dal daemon, Mermaid resi dalla UI)
// e file consegnati dal box. Le regole di validazione pure stanno in charts.ts;
// qui l'IO: il DB (store/library), i file in <dataDir>/library/<id>/ e le
// copie dal box (docker cp come copy_from_box).
//
// Punto 6 (contaminazione): una scrittura in un turno contaminato rende la
// voce tainted; tornare puliti richiede una scrittura da un turno pulito
// DELL'UTENTE. read_document di una voce tainted restituisce il contenuto col
// meta libraryTainted: il loop lo incarta nel blocco dato esterno e contamina
// il turno che legge.
//
// Il bot NON cancella: delete/rename/pin sono della UI (store/library).
import { createHash } from 'node:crypto'
import { join, extname, basename } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, createReadStream, existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { getAgent, dataDir } from '../store/db'
import {
  getLibraryItem, insertLibraryItem, updateLibraryItem, listLibraryItems, libraryItemDir, newLibraryId,
  type LibraryItem, type LibraryKind
} from '../store/library'
import {
  validateVegaLiteSpec, validateMermaidSource, validateDocumentCharts, applyExactEdits,
  extractChartBlocks, documentToHtml, DOCUMENT_MAX_BYTES
} from './charts'

/** Tetto di un file consegnato dal box (punto 1). */
export const LIBRARY_FILE_MAX_BYTES = 50 * 1024 * 1024

/** Soglia dell'avviso di spazio nelle Impostazioni (nessun blocco, punto 1). */
export const LIBRARY_TOTAL_WARN_BYTES = 2 * 1024 * 1024 * 1024

/** Il nome del file SVG di un grafico Vega-Lite (punto 1). */
export const CHART_SVG = 'chart.svg'
export const CHART_SPEC = 'spec.json'
export const CHART_MERMAID = 'diagram.mmd'

export type LibraryOp<T> = { ok: true; value: T } | { ok: false; error: string }

// ---- il contesto del turno che scrive (punto 6) ----

export interface LibraryWriteContext {
  /** il turno è contaminato (web, email, MCP letti nel turno) */
  contaminated?: boolean
  /** il turno è nato da un messaggio diretto dell'utente in chat */
  userTurn?: boolean
}

/**
 * Il tainted della prossima versione (punto 6, puro): una scrittura da un
 * turno contaminato rende tainted la voce; SOLO una scrittura da un turno
 * pulito DELL'UTENTE la ripulisce (le routine e le catene non puliscono mai).
 */
export function nextTainted(current: boolean, ctx: LibraryWriteContext): boolean {
  if (ctx.userTurn && !ctx.contaminated) return false
  return current || ctx.contaminated === true
}

// ---- documenti (punto 2) ----

function versionFile(id: string, v: number): string {
  return join(libraryItemDir(id), `v${v}.md`)
}

export interface DocumentWriteResult {
  id: string
  title: string
  version: number
  created: boolean
}

/**
 * write_document (punto 2): senza id crea (v1), con id scrive una NUOVA
 * VERSIONE intera. Il contenuto è Markdown GFM; i blocchi ```vega-lite /
 * ```mermaid si validano PRIMA di scrivere: un blocco non valido fa fallire
 * la chiamata e NESSUNA versione viene scritta.
 */
export function writeDocument(agentId: string, input: { title?: unknown; content?: unknown; id?: unknown }, ctx: LibraryWriteContext = {}): LibraryOp<DocumentWriteResult> {
  const content = String(input.content ?? '')
  const title = String(input.title ?? '').trim()
  if (!title) return { ok: false, error: 'serve un title (il titolo del documento)' }
  if (!content.trim()) return { ok: false, error: 'serve il content (Markdown GFM del documento)' }
  if (Buffer.byteLength(content, 'utf8') > DOCUMENT_MAX_BYTES) {
    return { ok: false, error: `documento troppo grande (${Buffer.byteLength(content, 'utf8')} byte, limite ${DOCUMENT_MAX_BYTES} di Markdown)` }
  }
  const charts = validateDocumentCharts(content)
  if (!charts.ok) return { ok: false, error: charts.error }

  const id = input.id !== undefined && input.id !== null && String(input.id).trim() ? String(input.id).trim() : null
  const now = Date.now()
  if (id) {
    const item = getLibraryItem(id)
    if (!item) return { ok: false, error: `documento "${id}" non trovato nella libreria: scrivi senza id per crearne uno nuovo` }
    if (item.kind !== 'document') return { ok: false, error: `"${id}" non è un documento (è ${item.kind === 'chart' ? 'un grafico' : 'un file'}): non si riscrive con write_document` }
    const version = item.currentVersion + 1
    writeFileSync(versionFile(id, version), content)
    updateLibraryItem(id, { currentVersion: version, updatedAt: now, tainted: nextTainted(item.tainted, ctx), ...(title !== item.title ? { title } : {}) })
    return { ok: true, value: { id, title, version, created: false } }
  }
  const newId = newLibraryId()
  mkdirSync(libraryItemDir(newId), { recursive: true })
  writeFileSync(versionFile(newId, 1), content)
  insertLibraryItem({
    id: newId, kind: 'document', title, authorAgentId: agentId, createdAt: now, updatedAt: now,
    pinned: false, tainted: ctx.contaminated === true, currentVersion: 1,
    chartKind: null, fileName: null, fileSha256: null, fileSize: null, fileMime: null
  })
  return { ok: true, value: { id: newId, title, version: 1, created: true } }
}

/**
 * edit_document (punto 2): le modifiche ESATTE old → new in ordine; ogni old
 * deve comparire ESATTAMENTE una volta nella versione corrente, altrimenti
 * l'errore dice quante volte compare e NESSUNA modifica si applica. Le
 * modifiche valide producono UNA nuova versione.
 */
export function editDocument(agentId: string, input: { id?: unknown; edits?: unknown }, ctx: LibraryWriteContext = {}): LibraryOp<DocumentWriteResult> {
  const id = String(input.id ?? '').trim()
  if (!id) return { ok: false, error: 'serve l\'id del documento (lib_…)' }
  const item = getLibraryItem(id)
  if (!item || item.kind !== 'document') return { ok: false, error: `documento "${id}" non trovato nella libreria` }
  const rawEdits = Array.isArray(input.edits) ? input.edits : []
  const edits: Array<{ old: string; new: string }> = []
  for (const e of rawEdits) {
    if (!e || typeof e !== 'object') return { ok: false, error: 'edits non validi: servono oggetti {old, new}' }
    const rec = e as Record<string, unknown>
    if (typeof rec.old !== 'string' || typeof rec.new !== 'string') {
      return { ok: false, error: 'edits non validi: old e new devono essere stringhe' }
    }
    edits.push({ old: rec.old, new: rec.new })
  }
  const current = readFileSync(versionFile(id, item.currentVersion), 'utf8')
  const applied = applyExactEdits(current, edits)
  if (!applied.ok) return { ok: false, error: applied.error }
  const next = applied.text
  if (Buffer.byteLength(next, 'utf8') > DOCUMENT_MAX_BYTES) {
    return { ok: false, error: `documento troppo grande dopo le modifiche (${Buffer.byteLength(next, 'utf8')} byte, limite ${DOCUMENT_MAX_BYTES})` }
  }
  const charts = validateDocumentCharts(next)
  if (!charts.ok) return { ok: false, error: charts.error }
  const version = item.currentVersion + 1
  writeFileSync(versionFile(id, version), next)
  updateLibraryItem(id, { currentVersion: version, updatedAt: Date.now(), tainted: nextTainted(item.tainted, ctx) })
  return { ok: true, value: { id, title: item.title, version, created: false } }
}

export interface DocumentReadResult {
  id: string
  title: string
  version: number
  authorName: string
  content: string
  tainted: boolean
  /** versioni disponibili */
  versions: number[]
}

/** read_document (punto 2): il Markdown con title, versione e autore. */
export function readDocument(input: { id?: unknown; version?: unknown }): LibraryOp<DocumentReadResult> {
  const id = String(input.id ?? '').trim()
  if (!id) return { ok: false, error: 'serve l\'id del documento (lib_…)' }
  const item = getLibraryItem(id)
  if (!item || item.kind !== 'document') return { ok: false, error: `documento "${id}" non trovato nella libreria (vedi list_library)` }
  const wanted = input.version !== undefined && input.version !== null ? Number(input.version) : item.currentVersion
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > item.currentVersion) {
    return { ok: false, error: `versione ${String(input.version)} non valida: il documento ha versioni da 1 a ${item.currentVersion}` }
  }
  let content = ''
  try {
    content = readFileSync(versionFile(id, wanted), 'utf8')
  } catch {
    return { ok: false, error: `il file della versione ${wanted} non si legge (libreria incoerente)` }
  }
  return {
    ok: true,
    value: {
      id, title: item.title, version: wanted,
      authorName: getAgent(item.authorAgentId)?.name ?? item.authorAgentId,
      content, tainted: item.tainted, versions: Array.from({ length: item.currentVersion }, (_v, k) => k + 1)
    }
  }
}

// ---- grafici (punto 3) ----

/** Il LOADER di vega che rifiuta OGNI richiesta (punto 3): nessuna rete. */
export const REJECTING_LOADER = {
  load(): Promise<never> {
    return Promise.reject(new Error('caricamento dati vietato: la spec valida ammette solo dati inline'))
  },
  http(): Promise<never> {
    return Promise.reject(new Error('richiesta di rete vietata: il grafico non naviga'))
  }
}

/**
 * La resa Vega-Lite → SVG nel daemon (punto 3): vega-lite → vega →
 * view.toSVG() col loader che rifiuta ogni richiesta. Nessun DOM.
 */
export async function renderVegaLiteSvg(spec: Record<string, unknown>): Promise<string> {
  const vegaLite = await import('vega-lite')
  const vega = await import('vega')
  const compiled = vegaLite.compile(spec as unknown as Parameters<typeof vegaLite.compile>[0])
  // il loader che rifiuta TUTTO (le due funzioni che vega chiama per i dati);
  // l'interfaccia Loader di vega è strutturale: sanitize/file non servono a
  // una spec senza url, il cast lo dichiara al compilatore
  const view = new vega.View(vega.parse(compiled.spec), {
    renderer: 'none',
    loader: REJECTING_LOADER as unknown as import('vega').Loader
  })
  try {
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

export interface ChartSaveResult {
  id: string
  title: string
  kind: 'vega-lite' | 'mermaid'
}

/**
 * visualize (punto 3): crea una voce chart. Vega-Lite: validazione (charts.ts)
 * + resa SVG SUBITO nel daemon — un errore di compilazione torna al modello e
 * la voce NON si crea. Mermaid: si salva il sorgente (lo rende la UI strict).
 */
export async function saveChart(agentId: string, input: { title?: unknown; kind?: unknown; spec?: unknown }, ctx: LibraryWriteContext = {}): Promise<LibraryOp<ChartSaveResult>> {
  const title = String(input.title ?? '').trim()
  const kind = input.kind === 'mermaid' ? 'mermaid' : input.kind === 'vega-lite' ? 'vega-lite' : null
  const spec = String(input.spec ?? '')
  if (!title) return { ok: false, error: 'serve un title (il titolo del grafico)' }
  if (!kind) return { ok: false, error: 'kind non valido: "vega-lite" o "mermaid"' }
  const now = Date.now()
  const id = newLibraryId()
  const dir = libraryItemDir(id)
  if (kind === 'vega-lite') {
    const check = validateVegaLiteSpec(spec)
    if (!check.ok) return { ok: false, error: check.error }
    let svg: string
    try {
      svg = await renderVegaLiteSvg(check.spec)
    } catch (e) {
      return { ok: false, error: `compilazione Vega-Lite non riuscita: ${e instanceof Error ? e.message : String(e)}` }
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, CHART_SPEC), spec)
    writeFileSync(join(dir, CHART_SVG), svg)
  } else {
    const check = validateMermaidSource(spec)
    if (!check.ok) return { ok: false, error: check.error }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, CHART_MERMAID), spec)
  }
  insertLibraryItem({
    id, kind: 'chart', title, authorAgentId: agentId, createdAt: now, updatedAt: now,
    pinned: false, tainted: ctx.contaminated === true, currentVersion: 1,
    chartKind: kind, fileName: null, fileSha256: null, fileSize: null, fileMime: null
  })
  return { ok: true, value: { id, title, kind } }
}

/** L'SVG di una voce chart Vega-Lite (per la UI e l'export). */
export function chartSvgOf(id: string): string | null {
  try {
    return readFileSync(join(libraryItemDir(id), CHART_SVG), 'utf8')
  } catch {
    return null
  }
}

/** Il sorgente di una voce chart (spec.json o diagram.mmd). */
export function chartSourceOf(id: string): string | null {
  const dir = libraryItemDir(id)
  for (const f of [CHART_SPEC, CHART_MERMAID]) {
    try {
      return readFileSync(join(dir, f), 'utf8')
    } catch {
      // prova il prossimo
    }
  }
  return null
}

// ---- la lista (punto 4) ----

export interface LibraryListRow {
  id: string
  kind: LibraryKind
  title: string
  author: string
  updatedAt: number
  pinned: boolean
  tainted: boolean
  version?: number
}

/** list_library (punto 4): max 20 righe, le fissate prima; tainted per il loop. */
export function listLibrary(input: { query?: unknown; kind?: unknown; limit?: unknown } = {}): { rows: LibraryListRow[]; anyTainted: boolean } {
  const kind = input.kind === 'document' || input.kind === 'chart' || input.kind === 'file' ? (input.kind as LibraryKind) : undefined
  const limit = input.limit !== undefined && input.limit !== null ? Number(input.limit) : undefined
  const items = listLibraryItems({
    ...(input.query !== undefined && input.query !== null ? { query: String(input.query) } : {}),
    ...(kind ? { kind } : {}),
    ...(Number.isFinite(limit) ? { limit } : {})
  })
  const rows = items.map((i) => ({
    id: i.id, kind: i.kind, title: i.title,
    author: getAgent(i.authorAgentId)?.name ?? i.authorAgentId,
    updatedAt: i.updatedAt, pinned: i.pinned, tainted: i.tainted,
    ...(i.kind === 'document' ? { version: i.currentVersion } : {})
  }))
  return { rows, anyTainted: rows.some((r) => r.tainted) }
}

/** Il testo del result di list_library per il modello. */
export function formatLibraryRows(rows: LibraryListRow[]): string {
  if (!rows.length) return 'La libreria è vuota (o nessuna voce per questo filtro).'
  const kindLabel: Record<LibraryKind, string> = { document: 'documento', chart: 'grafico', file: 'file' }
  return [
    `Voci della libreria (${rows.length}, fissate prima):`,
    ...rows.map((r) =>
      `- ${r.id} · ${kindLabel[r.kind]} · "${r.title}"${r.version ? ` (v${r.version})` : ''} · di ${r.author}${r.pinned ? ' · fissata' : ''}${r.tainted ? ' · ⚠ proveniente da dati esterni' : ''}`
    )
  ].join('\n')
}

// ---- file dal box (punto 4) ----

/** Il mime minimo dall'estensione (card e vista file). */
export function mimeOf(name: string): string {
  const ext = extname(name).toLowerCase()
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
    '.html': 'text/html', '.zip': 'application/zip'
  }
  return map[ext] ?? 'application/octet-stream'
}

/** Il nome file RIPULITO (punto 1): niente path, niente caratteri ostili. */
export function sanitizeFileName(raw: string): string {
  const base = basename(String(raw ?? '')).replace(/[/\\]/g, '_').replace(/[^\w.\- ()\[\]]+/g, '_').replace(/^\.+/, '').trim()
  return base || 'file'
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

/**
 * save_to_library (punto 4): porta un file dal box nella libreria. In docker
 * path è nel box (home del bot o /workspace) e si copia con docker cp come
 * copy_from_box (confini validati da resolveBoxPath, tetto 50 MB); in host è
 * nella cartella di lavoro del bot ( stessi confini di read-file). Nessuna
 * card: la libreria è interna e non manda niente fuori.
 */
export async function saveFileFromBox(
  agentId: string,
  input: { path?: unknown; title?: unknown },
  deps: {
    dockerStatSize?: (agentId: string, boxAbsPath: string) => Promise<number | null>
    dockerCp?: (boxAbsPath: string, localPath: string) => Promise<void>
  } = {},
  ctx: LibraryWriteContext = {}
): Promise<LibraryOp<{ id: string; title: string; name: string; size: number }>> {
  const { sandboxMode, boxRoot, boxDir } = await import('../sandbox')
  const { resolveBoxPath } = await import('../sandbox/box-paths')
  const path = String(input.path ?? '').trim()
  if (!path) return { ok: false, error: 'serve il path del file nel box (relativo alla tua home o /workspace/…)' }
  const owner = (await import('../sandbox')).boxOwnerOf(agentId)
  const root = sandboxMode() === 'docker' ? '/box' : boxRoot()
  const home1 = sandboxMode() === 'docker' ? `/box/home/${owner}` : boxDir(agentId)
  const resolved = resolveBoxPath(path, root, home1, sandboxMode() === 'docker' ? (p: string) => p : (await import('node:fs')).realpathSync)
  if (!resolved.ok) return { ok: false, error: resolved.reason! }
  const boxAbs = resolved.abs!

  let size: number
  if (sandboxMode() === 'docker') {
    const stat = deps.dockerStatSize ?? (async (agent, p) => {
      const { runDockerArgv } = await import('../sandbox')
      const { dockerStatSizeArgv, BOX_CONTAINER } = await import('../sandbox/docker-argv')
      const r = await runDockerArgv(dockerStatSizeArgv(BOX_CONTAINER, p), { timeoutMs: 15_000 })
      const n = Number(r.stdout.trim())
      return r.exitCode === 0 && Number.isFinite(n) ? n : null
    })
    const s = await stat(agentId, boxAbs)
    if (s === null) return { ok: false, error: `file non trovato nel box: "${path}"` }
    size = s
  } else {
    try {
      size = statSync(boxAbs).size
    } catch {
      return { ok: false, error: `file non trovato nel box: "${path}"` }
    }
  }
  if (size > LIBRARY_FILE_MAX_BYTES) {
    return { ok: false, error: `file troppo grande (${size} byte, limite ${LIBRARY_FILE_MAX_BYTES} per la libreria)` }
  }

  const name = sanitizeFileName(basename(boxAbs))
  const title = String(input.title ?? '').trim() || name
  const id = newLibraryId()
  const dir = libraryItemDir(id)
  mkdirSync(dir, { recursive: true })
  const localPath = join(dir, name)
  if (sandboxMode() === 'docker') {
    const cp = deps.dockerCp ?? (async (boxPath, dest) => {
      const { BOX_CONTAINER } = await import('../sandbox/docker-argv')
      const { execFile } = await import('node:child_process')
      await new Promise<void>((resolveP, rejectP) => {
        execFile('docker', ['cp', `${BOX_CONTAINER}:${boxPath}`, dest], (err) => (err ? rejectP(err) : resolveP()))
      })
    })
    try {
      await cp(boxAbs, localPath)
    } catch (e) {
      return { ok: false, error: `copia dal box non riuscita: ${e instanceof Error ? e.message : String(e)}` }
    }
  } else {
    const { copyFile } = await import('node:fs/promises')
    try {
      await copyFile(boxAbs, localPath)
    } catch (e) {
      return { ok: false, error: `copia non riuscita: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  const sha = await sha256OfFile(localPath).catch(() => '')
  const now = Date.now()
  insertLibraryItem({
    id, kind: 'file', title, authorAgentId: agentId, createdAt: now, updatedAt: now,
    pinned: false, tainted: ctx.contaminated === true, currentVersion: 1,
    chartKind: null, fileName: name, fileSha256: sha || null, fileSize: size, fileMime: mimeOf(name)
  })
  return { ok: true, value: { id, title, name, size } }
}

/** Il path locale del file di una voce (per l'export e la vista). */
export function fileOfItem(item: LibraryItem): string | null {
  if (item.kind !== 'file' || !item.fileName) return null
  return join(libraryItemDir(item.id), item.fileName)
}

// ---- esportazione (punto 5) ----

export type ExportFormat = 'md' | 'html' | 'pdf' | 'svg' | 'mmd' | 'file'

export interface ExportPlan {
  id: string
  format: ExportFormat
  /** nome file proposto (non in conflitto lo decide runLibraryExport) */
  name: string
  /** byte stimati (i file di corpo; il pdf è stimato) */
  bytes: number
  destination: string
}

/**
 * I formati validi per una voce (punto 5): documenti md/html/pdf, grafici
 * Vega-Lite svg e Mermaid mmd, file → il file stesso.
 */
export function exportFormatsOf(item: LibraryItem): ExportFormat[] {
  if (item.kind === 'document') return ['md', 'html', 'pdf']
  if (item.kind === 'chart') return item.chartKind === 'mermaid' ? ['mmd'] : ['svg']
  return ['file']
}

/** Il nome file proposto per l'export (puro). */
export function exportFileName(item: LibraryItem, format: ExportFormat): string {
  const safe = sanitizeFileName(item.title).replace(/\.(md|html|pdf|svg|mmd)$/i, '')
  if (format === 'file') return sanitizeFileName(item.fileName ?? item.title)
  return `${safe}.${format}`
}

/**
 * Valida la richiesta di export e calcola il piano per la card (punto 5).
 * La CARD di conferma la costruisce il loop (come copy_from_box).
 */
export function prepareLibraryExport(input: { id?: unknown; format?: unknown }): LibraryOp<ExportPlan> {
  const id = String(input.id ?? '').trim()
  if (!id) return { ok: false, error: 'serve l\'id della voce (lib_…)' }
  const item = getLibraryItem(id)
  if (!item) return { ok: false, error: `voce "${id}" non trovata nella libreria` }
  const rawFormat = String(input.format ?? '').trim()
  const allowed = exportFormatsOf(item)
  // "file" si accetta anche vuoto per le voci file
  const fmt: ExportFormat = (rawFormat === '' && item.kind === 'file') ? 'file' : (rawFormat as ExportFormat)
  if (!allowed.includes(fmt)) {
    return { ok: false, error: `formato "${rawFormat}" non valido per questa voce: ${allowed.join(', ')}` }
  }
  let bytes = 0
  try {
    if (item.kind === 'document') {
      bytes = statSync(join(libraryItemDir(id), `v${item.currentVersion}.md`)).size
    } else if (fmt === 'svg') {
      bytes = statSync(join(libraryItemDir(id), CHART_SVG)).size
    } else if (fmt === 'mmd') {
      bytes = statSync(join(libraryItemDir(id), CHART_MERMAID)).size
    } else if (item.fileName) {
      bytes = statSync(join(libraryItemDir(id), item.fileName)).size
    }
  } catch {
    return { ok: false, error: 'il contenuto della voce non si legge (libreria incoerente)' }
  }
  return {
    ok: true,
    value: { id, format: fmt, name: exportFileName(item, fmt), bytes, destination: '~/Downloads/SandBot/' + exportFileName(item, fmt) }
  }
}

export interface ExportRunDeps {
  /** genera il PDF dall'HTML in una finestra nascosta (UI); throw = niente UI */
  printToPdf?: (html: string) => Promise<Buffer>
  /** test: dove mettere l'export (default ~/Downloads/SandBot) */
  targetDir?: string
  existsSync?: (p: string) => boolean
}

/**
 * Esegue l'export (dopo il click sulla card, punto 5): scrive in
 * ~/Downloads/SandBot con nome NON in conflitto (come copy_from_box).
 */
export async function runLibraryExport(plan: ExportPlan, deps: ExportRunDeps = {}): Promise<{ output: string; finalPath: string }> {
  const { homedir } = await import('node:os')
  const { nonConflictingName } = await import('./file-exchange')
  const item = getLibraryItem(plan.id)
  if (!item) throw new Error(`voce "${plan.id}" non trovata`)
  const dir = deps.targetDir ?? join(homedir(), 'Downloads', 'SandBot')
  const { mkdirSync: mkdirS } = await import('node:fs')
  mkdirS(dir, { recursive: true })
  const exists = deps.existsSync ?? existsSync
  const target = nonConflictingName(join(dir, plan.name), exists)
  const { basename: bn } = await import('node:path')

  if (plan.format === 'md') {
    const content = readFileSync(join(libraryItemDir(plan.id), `v${item.currentVersion}.md`), 'utf8')
    writeFileSync(target, content)
  } else if (plan.format === 'html') {
    writeFileSync(target, await documentHtmlOf(item))
  } else if (plan.format === 'pdf') {
    if (!deps.printToPdf) {
      throw new Error('il PDF lo genera la finestra di SandBot: aprila e riprova, oppure esporta in html')
    }
    const pdf = await deps.printToPdf(await documentHtmlOf(item))
    const { writeFile: wf } = await import('node:fs/promises')
    await wf(target, pdf)
  } else if (plan.format === 'svg') {
    const svg = chartSvgOf(plan.id)
    if (svg === null) throw new Error('il SVG del grafico non c\'è (voce incoerente)')
    writeFileSync(target, svg)
  } else if (plan.format === 'mmd') {
    const src = readFileSync(join(libraryItemDir(plan.id), CHART_MERMAID), 'utf8')
    writeFileSync(target, src)
  } else {
    const file = fileOfItem(item)
    if (!file) throw new Error('il file della voce non c\'è (voce incoerente)')
    const { copyFile: cf } = await import('node:fs/promises')
    await cf(file, target)
  }
  const note = basename(target) !== plan.name ? ` (esisteva già: scritto come "${bn(target)}")` : ''
  return { output: `Esportato in ${target}${note}.`, finalPath: target }
}

/** L'HTML autonomo di un documento (punto 5): SVG in linea dei blocchi vega-lite. */
export async function documentHtmlOf(item: LibraryItem): Promise<string> {
  const md = readFileSync(join(libraryItemDir(item.id), `v${item.currentVersion}.md`), 'utf8')
  const svgs: string[] = []
  for (const block of extractChartBlocks(md)) {
    if (block.lang !== 'vega-lite') continue
    const check = validateVegaLiteSpec(block.body)
    // i blocchi sono stati validati alla scrittura; qui si difende lo stesso
    if (check.ok) {
      svgs.push(await renderVegaLiteSvg(check.spec).catch(() => ''))
    } else {
      svgs.push('')
    }
  }
  return documentToHtml(
    { title: item.title, authorName: getAgent(item.authorAgentId)?.name ?? item.authorAgentId, version: item.currentVersion },
    md,
    svgs
  )
}

// ---- spazio (punto 1: avviso oltre 2 GB, nessun blocco) ----

/** I byte totali della libreria (documenti + grafici + file su disco). */
export function libraryTotalBytes(): number {
  const root = join(dataDir(), 'library')
  let total = 0
  const walk = (dir: string): void => {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      try {
        const s = statSync(p)
        if (s.isDirectory()) walk(p)
        else total += s.size
      } catch {
        // voce sparita: si salta
      }
    }
  }
  walk(root)
  return total
}

/** Il testo del result di write/read/edit per il modello (punto 2). */
export function documentResultText(r: DocumentWriteResult): string {
  return `Documento «${r.title}» (${r.id}) v${r.version} salvato nella libreria.`
}

// ---- iniezione per i test del loop (nessuna home reale) ----

let fake: { saveFile?: typeof saveFileFromBox } | null = null
export function setLibraryForTests(f: { saveFile?: typeof saveFileFromBox } | null): void {
  fake = f
}
export function getSaveFileFromBox(): typeof saveFileFromBox {
  return fake?.saveFile ?? saveFileFromBox
}

export { readFile as libraryReadFile, writeFile as libraryWriteFile }
/** L'item della libreria per id (RPC della UI). */
export { getLibraryItem as getLibraryItemPublic } from '../store/library'
