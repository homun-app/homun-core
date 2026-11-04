#!/usr/bin/env node
// Fase catalogo app (P1): aggiorna il catalogo CURATO delle app Composio che
// sta nel repo (src/shared/app-catalog/composio-catalog.json + i loghi in
// src/renderer/src/assets/app-logos). Lo lanciamo NOI a mano sul Mac con la
// chiave di un progetto Composio nell'ambiente (COMPOSIO_CATALOG_KEY):
// NESSUNA chiave finisce nell'app, nel repo o nella CI, e la chiave non si
// stampa né si scrive MAI da nessuna parte (nemmeno nei messaggi d'errore).
//
// Cosa scarica: GET <base>/api/v3/toolkits?sort_by=usage paginato col cursore,
// tenendo solo le voci COLLEGABILI da un consumatore (auth gestita da Composio
// oppure nessuna auth, mai i toolkit locali). La forma dei campi è snake_case
// nell'API REST e camelCase nell'SDK @composio/core (ToolKitItemSchema in
// dist/composio-*.d.mts): il parser accetta ENTRAMBE le grafie.
//
// Il file di cura curation.json (consigliate, nascoste, categorie nostre,
// override, marchi) è scritto a mano e questo script NON lo tocca mai: si
// limita a ELENCARE a fine lancio le categorie Composio che non sono mappate
// (finiscono in «Altro»), così le mappiamo.
//
// Opzioni: --limit <N> (quante app collegabili, default 300) · --base-url
// <url> (default https://backend.composio.dev; per la prova col server finto)
// · --dry-run (non scrive nulla, stampa solo le differenze) · --prune (tolge
// anche le app sparite) · --out <dir> (cartella d'uscita per la prova:
// <dir>/composio-catalog.json e <dir>/app-logos/) · --solo-loghi (SENZA
// chiave: tiene il catalogo com'è e scarica solo i loghi pubblici da
// logos.composio.dev/api/<slug>, riempiendo il campo logo).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BASE = 'https://backend.composio.dev'
const PAGE_SIZE = 100
const LOGO_MAX_BYTES = 200 * 1024
const LOGO_TYPES = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp'
}

// ---- le opzioni e la chiave ----

const args = process.argv.slice(2)
const optValue = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}
const hasFlag = (name) => args.includes(name)
const limit = Math.max(1, Number(optValue('--limit') ?? 300) || 300)
const baseUrl = (optValue('--base-url') ?? DEFAULT_BASE).replace(/\/+$/, '')
const dryRun = hasFlag('--dry-run')
const prune = hasFlag('--prune')
const outDir = optValue('--out')
const logosOnly = hasFlag('--solo-loghi')
/** Il logo pubblico di Composio per uno slug: serve quando meta.logo manca e per --solo-loghi. */
const LOGO_CDN = 'https://logos.composio.dev/api/'
const publicLogoUrl = (slug) => `${LOGO_CDN}${encodeURIComponent(slug)}`

const KEY = process.env.COMPOSIO_CATALOG_KEY ?? ''
if (!KEY && !logosOnly) {
  console.error('Manca COMPOSIO_CATALOG_KEY: esporta la chiave API di un progetto Composio (composio.dev → Settings → API Keys) e rilancia. Non faccio nulla.')
  process.exit(1)
}

const catalogPath = outDir ? join(outDir, 'composio-catalog.json') : join(ROOT, 'src/shared/app-catalog/composio-catalog.json')
const logosDir = outDir ? join(outDir, 'app-logos') : join(ROOT, 'src/renderer/src/assets/app-logos')
const curationPath = join(ROOT, 'src/shared/app-catalog/curation.json')

/** La chiave non compare mai nell'output: il corpo di un errore si mostra solo se non la contiene. */
const safeExcerpt = (body) => (body && (!KEY || !body.includes(KEY)) ? ` — ${body.slice(0, 200)}` : '')

// ---- il download delle pagine di toolkit ----

/** Lege un campo nell'una o nell'altra grafia (REST snake_case / SDK camelCase). */
const pick = (obj, snake, camel) => {
  if (!obj || typeof obj !== 'object') return undefined
  return obj[snake] !== undefined ? obj[snake] : obj[camel]
}

async function fetchToolkitsPage(cursor) {
  const url = new URL(`${baseUrl}/api/v3/toolkits`)
  url.searchParams.set('sort_by', 'usage')
  url.searchParams.set('limit', String(PAGE_SIZE))
  if (cursor) url.searchParams.set('cursor', cursor)
  const res = await fetch(url, { headers: { 'x-api-key': KEY, accept: 'application/json' } })
    .catch((e) => { throw new Error(`non riesco a raggiungere ${baseUrl}: ${e.message ?? e}`) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET /api/v3/toolkits → HTTP ${res.status}${safeExcerpt(body)}`)
  }
  const data = await res.json().catch(() => { throw new Error('GET /api/v3/toolkits → corpo JSON illeggibile') })
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : []
  const next = pick(data, 'next_cursor', 'nextCursor') ?? null
  return { items, next }
}

/** La voce è collegabile da un consumatore: auth gestita da Composio (o nessuna), mai un toolkit locale. */
function connectable(item) {
  const local = pick(item, 'is_local_toolkit', 'isLocalToolkit')
  if (local === true) return false
  const managed = pick(item, 'composio_managed_auth_schemes', 'composioManagedAuthSchemes')
  if (Array.isArray(managed) && managed.length > 0) return true
  return pick(item, 'no_auth', 'noAuth') === true
}

function toEntry(item) {
  const meta = item.meta ?? {}
  const categories = [...new Set(
    (Array.isArray(meta.categories) ? meta.categories : [])
      .map((c) => (typeof c === 'string' ? c : (c?.slug ?? c?.id ?? c?.name)))
      .filter((s) => typeof s === 'string' && s.length > 0)
  )].sort()
  return {
    slug: String(item.slug ?? '').toLowerCase(),
    name: String(item.name ?? item.slug ?? ''),
    description: typeof meta.description === 'string' ? meta.description : '',
    categories,
    toolsCount: typeof pick(meta, 'tools_count', 'toolsCount') === 'number' ? pick(meta, 'tools_count', 'toolsCount') : 0,
    logo: null,
    auth: pick(item, 'no_auth', 'noAuth') === true ? 'none' : 'managed'
  }
}

// ---- il download e la pulizia dei loghi ----

/** Ripulisce un SVG: niente <script>, attributi on*, href esterni né <foreignObject>. */
export function sanitizeSvg(svg) {
  return svg
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<foreignObject\b[^>]*\/>/gi, '')
    .replace(/\s+(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (whole, value) => {
      const v = value.replace(/^["']|["']$/g, '').trim()
      // si tengono SOLO i riferimenti interni (#id) e i relativi: mai http(s), // o data:
      return /^(#|\.{0,2}\/(?!\/))/.test(v) ? whole : ''
    })
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
}

async function downloadLogo(entry, metaLogo) {
  let url
  try { url = new URL(String(metaLogo)) } catch { return null }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const res = await fetch(url, { redirect: 'follow' }).catch(() => null)
  if (!res || !res.ok) return null
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const ext = LOGO_TYPES[type]
  if (!ext) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength === 0 || buf.byteLength > LOGO_MAX_BYTES) return null
  const bytes = ext === 'svg' ? Buffer.from(sanitizeSvg(buf.toString('utf8')), 'utf8') : buf
  if (bytes.byteLength === 0) return null
  return { ext, bytes }
}

// ---- il corpo dello script ----

const log = (...a) => console.log('[catalogo]', ...a)

// --solo-loghi: il catalogo resta com'è, si riempiono solo i loghi (niente chiave)
async function logosOnlyRun() {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  if (!Array.isArray(catalog)) throw new Error(`${catalogPath} non è un elenco`)
  if (!dryRun) mkdirSync(logosDir, { recursive: true })
  let ok = 0
  const missing = []
  for (const entry of catalog) {
    const logo = await downloadLogo(entry, publicLogoUrl(entry.slug))
    if (!logo) { missing.push(entry.slug); continue }
    entry.logo = `${entry.slug}.${logo.ext}`
    ok++
    if (!dryRun) writeFileSync(join(logosDir, entry.logo), logo.bytes)
  }
  if (!dryRun) writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
  log(`loghi: ${ok}/${catalog.length}${missing.length ? ` · senza logo: ${missing.join(', ')}` : ''}${dryRun ? ' (dry-run: nulla scritto)' : ''}`)
}

try {
  if (logosOnly) { await logosOnlyRun(); process.exit(0) }
  // 1. le pagine, finché non ci sono `limit` voci collegabili
  const entries = []
  const seen = new Set()
  let cursor = null
  let pages = 0
  while (entries.length < limit) {
    const { items, next } = await fetchToolkitsPage(cursor)
    pages++
    for (const item of items) {
      if (entries.length >= limit) break
      if (!connectable(item)) continue
      const entry = toEntry(item)
      if (!entry.slug || seen.has(entry.slug)) continue
      seen.add(entry.slug)
      // senza meta.logo si prova il logo pubblico dello slug — SOLO verso il
      // Composio vero (col server finto dei test niente rete esterna)
      const metaLogo = typeof (item.meta ?? {}).logo === 'string' ? item.meta.logo : null
      entries.push({ entry, logoUrl: metaLogo ?? (baseUrl === DEFAULT_BASE ? publicLogoUrl(entry.slug) : null) })
    }
    if (!next) break
    cursor = next
  }
  log(`${entries.length} app collegabili in ${pages} pagin${pages === 1 ? 'a' : 'e'} (limite ${limit})`)

  // 2. i loghi (solo le nuove visite: chi non si scarica resta logo: null)
  if (!dryRun) mkdirSync(logosDir, { recursive: true })
  for (const { entry, logoUrl } of entries) {
    if (!logoUrl) continue
    const logo = await downloadLogo(entry, logoUrl)
    if (!logo) continue
    entry.logo = `${entry.slug}.${logo.ext}`
    if (dryRun) continue
    const path = join(logosDir, entry.logo)
    try {
      if (existsSync(path) && readFileSync(path).equals(logo.bytes)) continue
    } catch { /* si riscrive */ }
    writeFileSync(path, logo.bytes)
  }

  // 3. le differenze col file di oggi (se c'è)
  let previous = []
  try {
    const raw = JSON.parse(readFileSync(catalogPath, 'utf8'))
    if (Array.isArray(raw)) previous = raw
  } catch { /* prima corsa o file a metà: nessun precedente */ }
  const previousBySlug = new Map(previous.map((e) => [e.slug, e]))
  const currentSlugs = new Set(entries.map((e) => e.entry.slug))
  const newApps = entries.filter((e) => !previousBySlug.has(e.entry.slug)).map((e) => e.entry.slug)
  const gone = previous.filter((e) => !currentSlugs.has(e.slug))
  const changed = entries
    .filter(({ entry }) => {
      const old = previousBySlug.get(entry.slug)
      if (!old) return false
      return old.name !== entry.name
        || JSON.stringify(old.categories) !== JSON.stringify(entry.categories)
        || (old.logo ?? null) !== entry.logo
    })
    .map(({ entry }) => entry.slug)
  if (newApps.length) log(`app nuove (${newApps.length}): ${newApps.join(', ')}`)
  if (changed.length) log(`cambiate nome/categoria/logo (${changed.length}): ${changed.join(', ')}`)
  if (gone.length) {
    log(`app sparite (${gone.length}): ${gone.map((e) => e.slug).join(', ')}`)
    log(prune ? '--prune: le tolgo dal file' : 'restano nel file (le tolgo solo con --prune)')
  }

  // 4. il file: le nuove in ordine d'uso, poi (senza --prune) le sparite com'erano
  const finalEntries = [
    ...entries.map(({ entry }) => entry),
    ...(prune ? [] : gone)
  ]
  const serialized = `${JSON.stringify(finalEntries, null, 2)}\n`
  if (!dryRun) {
    mkdirSync(dirname(catalogPath), { recursive: true })
    const before = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : null
    if (before !== serialized) writeFileSync(catalogPath, serialized)
    log(`scritto ${catalogPath} (${finalEntries.length} voci)`)
  } else {
    log(`dry-run: ${catalogPath} non scritto (${finalEntries.length} voci)`)
  }

  // 5. le categorie Composio non mappate in curation.json (finiscono in «Altro»)
  let curationCategories = {}
  try {
    curationCategories = JSON.parse(readFileSync(curationPath, 'utf8')).categories ?? {}
  } catch { /* curation non ancora scritta: tutte non mappate */ }
  const unmapped = [...new Set(finalEntries.flatMap((e) => e.categories))]
    .filter((c) => !(c in curationCategories))
  if (unmapped.length) log(`categorie non mappate (oggi finiscono in «Altro»): ${unmapped.join(', ')}`)

  process.exit(0)
} catch (e) {
  console.error(`[catalogo] ${e.message ?? e}`)
  process.exit(1)
}
