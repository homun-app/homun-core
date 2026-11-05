// Fase skill · Sfoglia (B2): il catalogo dei PACCHETTI DI SOLE SKILL dei
// marketplace che Homun usa già (il predefinito ufficiale e quelli aggiunti
// dall'utente in Collega app › Marketplace). NIENTE registro aperto: come il
// Browse di Rakazo non è un elenco di «tutte le skill» ma i plugin dei
// marketplace SENZA connettore — e ciò che non si sa classificare si SCARTA
// (sorgenti esterne, server MCP, path che escono dalla cartella).
// Struttura del catalogo ispirata a Rakazo (Apache 2.0),
// packages/adapters/src/plugin-marketplace.ts: filtro hasConnector, cache di
// 10 minuti, errori mai in cache, scarti contati col motivo.
//
// Come si classifica SENZA le API di GitHub (che in Rakazo hanno il limite di
// 60 richieste all'ora): per ogni marketplace UN clone parziale
// `git clone --depth 1 --filter=blob:none --no-checkout` con le STESSE regole
// sicure di gitCloneArgv/checkGitUrl (hook disattivati, niente submoduli,
// https SOLO — file:// solo col flag di test), l'elenco dei file arriva da
// `git ls-tree -r --name-only HEAD` (niente blob) e i pochi file che servono
// (`.claude-plugin/plugin.json`, `.mcp.json`) da `git show HEAD:<path>`, che
// col clone parziale scarica solo QUEI blob. Il clone vive in
// <dataDir>/cache/marketplaces/ come il catalogo (M6 della fase 13): una
// cartella per sorgente col suffisso -tree, TTL di 1 ora, re-clone in una
// cartella NUOVA che poi sostituisce la vecchia. NON si riusa il clone del
// catalogo: quello dei marketplace github NON ESISTE (il marketplace.json
// arriva da raw.githubusercontent.com) e quello dei marketplace git è
// sparse-checkout del solo .claude-plugin/ col ciclo di vita gestito dal
// manager per i cataloghi — l'albero intero serve invece qui.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
// fase rilascio (A7): git di /usr/bin o Homebrew, non il nome semplice
import { resolveTool } from '../tool-paths'
import {
  checkGitUrl, githubRepoUrl, relativeSourceError, PLUGIN_TIMEOUT_MS,
  IGNORED_DIRS, IGNORED_LABELS
} from '../connectors/marketplace'
import {
  MARKETPLACE_CACHE_MS, marketplaceCacheDir, marketplaceCacheName,
  type MarketplaceCatalog, type MarketplaceManager
} from '../connectors/marketplace-manager'

/** Il runner git iniettabile (default: spawn di git, con timeout). */
export type RunGit = (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>

export const spawnGitRun: RunGit = (args, opts = {}) =>
  new Promise((res, rej) => {
    const child = spawn(resolveTool('git'), args, { stdio: ['ignore', 'pipe', 'pipe'], ...(opts.cwd ? { cwd: opts.cwd } : {}) })
    let stdout = ''
    let stderr = ''
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e) => { if (timer) clearTimeout(timer); rej(e) })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      res({ code: code ?? 1, stdout, stderr })
    })
  })

/** Cache del catalogo classificato: 10 minuti (come Rakazo). */
export const SKILL_BROWSE_CACHE_MS = 10 * 60_000

/** Tetto dell'elenco dei file del marketplace (git ls-tree -r). */
const TREE_MAX_FILES = 50_000
/** I pochi file letti col clone parziale: manifest 64 KB, .mcp.json 256 KB. */
const MANIFEST_MAX_BYTES = 64_000
const MCP_MAX_BYTES = 256_000

// ---- la parte PURA: classificazione e ricerca ----

/** Una voce del catalogo Sfoglia (senza lo stato di installazione). */
export interface SkillPackEntryBase {
  /** l'id che usa buildPluginCard: plugin:<nome>@<marketplace> */
  id: string
  name: string
  displayName: string
  description: string
  category: string
  keywords: string[]
  homepage: string
  marketplace: string
  official: boolean
  skillCount: number
  skillNames: string[]
}

/** La voce che arriva alla finestra: base + «Aggiunto». */
export interface SkillPackEntry extends SkillPackEntryBase {
  installed: boolean
}

/** Una voce scartata col motivo (per il REPORT: quante restano fuori e perché). */
export interface SkillBrowseSkipped {
  plugin: string
  reason: string
}

/** La classificazione di un pacchetto di sole skill (pura). */
export interface SkillPackClassification {
  skillCount: number
  skillNames: string[]
  /** le parti che Homun ignora sempre (commands, agents, hooks, bin…): si mostrano come «non usate» */
  ignored: string[]
}

/**
 * Quando un plugin è «di sole skill» (PURa): almeno una skills/<nome>/SKILL.md
 * (o i path skill dichiarati nel manifest, come inspectPlugin), NESSUN server
 * MCP (niente .mcp.json, niente mcpServers nel manifest), nessun path che
 * esce dalla cartella. Ciò che non si riesce a leggere (manifest o .mcp.json
 * non JSON) si ESCLUDE. Le parti che Homun ignora sempre NON escludono:
 * finiscono in `ignored`. Null = non è un pacchetto di sole skill.
 */
export function classifySkillPack(
  paths: string[],
  manifestText: string | null,
  mcpText: string | null
): SkillPackClassification | null {
  const detailed = classifyDetailed(paths, manifestText, mcpText)
  return 'classification' in detailed ? detailed.classification : null
}

/** La classificazione col MOTIVO dello scarto (per il REPORT e i test). */
export function classifyDetailed(
  paths: string[],
  manifestText: string | null,
  mcpText: string | null
): { classification: SkillPackClassification } | { reason: string } {
  // i path non escono dalla cartella (stesse regole di inspectPlugin)
  for (const p of paths) {
    if (isAbsolute(p) || p.split('/').includes('..')) return { reason: `a path leaves the plugin folder` }
  }
  // .mcp.json presente (anche illeggibile) → connettore
  if (mcpText !== null) return { reason: 'contains MCP servers (.mcp.json): it is a connector, add it from Connect apps' }
  let manifest: Record<string, unknown> | null = null
  if (manifestText !== null) {
    try {
      const parsed = JSON.parse(manifestText) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { reason: 'manifest .claude-plugin/plugin.json is not an object' }
      manifest = parsed as Record<string, unknown>
    } catch {
      return { reason: 'manifest .claude-plugin/plugin.json is not valid JSON' }
    }
  }
  if (manifest && manifest.mcpServers !== undefined) {
    return { reason: 'contains MCP servers (manifest mcpServers): it is a connector, add it from Connect apps' }
  }
  const names = new Set<string>()
  for (const p of paths) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(p)
    if (m) names.add(m[1]!)
  }
  if (manifest && Array.isArray(manifest.skills)) {
    for (const s of manifest.skills) {
      if (typeof s !== 'string' || !s) continue
      // un path dichiarato nel manifest che ESCE dalla cartella → escluso
      if (isAbsolute(s) || s.split('/').includes('..')) return { reason: `a manifest skill path leaves the folder: ${s}` }
      const dir = s.replace(/\/+$/, '')
      if (paths.includes(`${dir}/SKILL.md`)) names.add(dir.split('/').pop()!)
    }
  }
  if (names.size === 0) return { reason: 'no skills/<name>/SKILL.md inside the plugin folder' }
  const ignored: string[] = []
  for (const name of IGNORED_DIRS) {
    if (paths.some((p) => p === name || p.startsWith(`${name}/`))) ignored.push(IGNORED_LABELS[name])
  }
  return { classification: { skillCount: names.size, skillNames: [...names].sort(), ignored } }
}

/** Il nome in Title Case quando il manifest non dà un displayName (come Rakazo). */
export function titleCaseName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ')
}

// B2.6: la ricerca è PURA e CONDIVISA col renderer (src/shared/skill-browse-search.ts)
import { sortSkillPacks, searchSkillPacks } from '../../shared/skill-browse-search'
export { matchesSkillPackQuery, sortSkillPacks, searchSkillPacks } from '../../shared/skill-browse-search'

// ---- la parte con l'I/O iniettata ----

/** Le dipendenze del browser del catalogo (tutto iniettabile per i test). */
export interface SkillBrowseDeps {
  /** i marketplace registrati: list + fetchCatalog (con force per la riprova) */
  marketplaces: Pick<MarketplaceManager, 'list' | 'fetchCatalog'>
  /** la dir dati: il clone dell'albero vive in <dataDir>/cache/marketplaces/ */
  dataDir(): string
  /** i plugin installati (per l'etichetta «Aggiunto») */
  installedPlugins(): Array<{ name: string; marketplace: string }>
  runGit?: RunGit
  mkdtemp?: (prefix: string) => string
  now?(): number
  /** test: URL file:// ammessi (in produzione MAI) */
  allowFileUrlsForTests?: boolean
}

/** Il catalogo interno: voci SENZA stato di installazione (quello si calcola a ogni chiamata). */
interface SkillBrowseInternal {
  entries: SkillPackEntryBase[]
  unavailable: Array<{ source: string }>
  skipped: SkillBrowseSkipped[]
}

export type SkillBrowseOutcome = {
  entries: SkillPackEntry[]
  unavailable: Array<{ source: string }>
  skipped: SkillBrowseSkipped[]
}

const fileUrlsAllowed = (deps: SkillBrowseDeps): boolean =>
  deps.allowFileUrlsForTests === true || process.env.SANDBOT_TEST_ALLOW_FILE_URLS === '1'

/** L'argv del clone parziale dell'albero (le STESSE regole sicure di gitCloneArgv, ma --no-checkout). */
export function treeCloneArgv(url: string, dir: string, opts: { allowFileUrlsForTests?: boolean } = {}): string[] {
  return [
    '-c', 'core.hooksPath=/dev/null',
    ...(opts.allowFileUrlsForTests ? [] : ['-c', 'protocol.file.allow=never']),
    'clone', '--depth', '1',
    '--no-recurse-submodules',
    '--filter', 'blob:none',
    '--no-checkout',
    '--', url, dir
  ]
}

/**
 * Il browser del catalogo: cache di 10 minuti per il classificato, errori MAI
 * in cache, richieste contemporanee che condividono lo stesso lavoro (un solo
 * clone), un marketplace illeggibile finisce in `unavailable` senza far
 * fallire gli altri.
 */
export function createSkillBrowser(deps: SkillBrowseDeps) {
  const now = deps.now ?? Date.now
  const run = deps.runGit ?? spawnGitRun
  const mkd = deps.mkdtemp ?? ((prefix: string) => mkdtempSync(join(marketplaceCacheDir(deps.dataDir()), prefix)))
  let cache: { at: number; data: SkillBrowseInternal } | null = null
  let pending: Promise<SkillBrowseInternal> | null = null
  /** i cloni degli alberi per sorgente (TTL di 1 ora, come il catalogo) */
  const trees = new Map<string, { dir: string; at: number }>()

  // come il manager dei marketplace (M6): le temporanee .tree-clone-* di un
  // clone interrotto si buttano via alla creazione
  try {
    const root = marketplaceCacheDir(deps.dataDir())
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (ent.name.startsWith('.tree-clone-')) rmSync(join(root, ent.name), { recursive: true, force: true })
    }
  } catch {
    // root assente al primo avvio: normale
  }

  /** Il timestamp del clone (sidecar `<dir>.at`); null se mai clonato. */
  const cloneTime = (dir: string): number | null => {
    try {
      const t = Number(readFileSync(`${dir}.at`, 'utf8').trim())
      return Number.isFinite(t) ? t : null
    } catch {
      return null
    }
  }

  /** Il clone parziale dell'albero del marketplace (TTL 1 h, sostituzione atomica). */
  async function ensureTree(m: { source: string; kind: 'github' | 'git' }, force: boolean): Promise<string> {
    const url = m.kind === 'github' ? githubRepoUrl(m.source) : m.source
    const check = checkGitUrl(url, { allowFileUrlsForTests: fileUrlsAllowed(deps) })
    if (!check.ok) throw new Error(check.error)
    const dir = join(marketplaceCacheDir(deps.dataDir()), `${marketplaceCacheName(m.source)}-tree`)
    if (!force) {
      const hit = trees.get(m.source)
      if (hit && now() - hit.at < MARKETPLACE_CACHE_MS) return hit.dir
      const diskAt = cloneTime(dir)
      if (diskAt !== null && now() - diskAt < MARKETPLACE_CACHE_MS) {
        trees.set(m.source, { dir, at: diskAt })
        return dir
      }
    }
    mkdirSync(marketplaceCacheDir(deps.dataDir()), { recursive: true })
    const tmp = mkd('.tree-clone-')
    const r = await run(treeCloneArgv(url, tmp, { allowFileUrlsForTests: fileUrlsAllowed(deps) }), { timeoutMs: PLUGIN_TIMEOUT_MS })
    if (r.code !== 0) {
      rmSync(tmp, { recursive: true, force: true })
      throw new Error(`marketplace tree clone failed: ${r.stderr.trim().slice(0, 160)}`)
    }
    rmSync(dir, { recursive: true, force: true })
    renameSync(tmp, dir)
    writeFileSync(`${dir}.at`, String(now()))
    trees.set(m.source, { dir, at: now() })
    return dir
  }

  /** L'elenco dei file del marketplace a HEAD (git ls-tree: nessun blob). */
  async function treePaths(dir: string): Promise<string[]> {
    const r = await run(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir, timeoutMs: PLUGIN_TIMEOUT_MS })
    if (r.code !== 0) throw new Error(`git ls-tree failed: ${r.stderr.trim().slice(0, 160)}`)
    const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length > TREE_MAX_FILES) throw new Error(`marketplace tree too large (${lines.length} files)`)
    return lines
  }

  /** Il contenuto di UN file del marketplace a HEAD (git show: col clone parziale scarica solo quel blob). */
  async function treeFile(dir: string, path: string, maxBytes: number): Promise<string | null> {
    const r = await run(['show', `HEAD:${path}`], { cwd: dir, timeoutMs: PLUGIN_TIMEOUT_MS })
    if (r.code !== 0) return null
    if (Buffer.byteLength(r.stdout, 'utf8') > maxBytes) return null
    return r.stdout
  }

  /** Il catalogo classificato di TUTTI i marketplace (un fallimento non si porta via gli altri). */
  async function buildInternal(force: boolean): Promise<SkillBrowseInternal> {
    const entries: SkillPackEntryBase[] = []
    const unavailable: Array<{ source: string }> = []
    const skipped: SkillBrowseSkipped[] = []
    for (const m of deps.marketplaces.list()) {
      let cat: MarketplaceCatalog
      try {
        cat = await deps.marketplaces.fetchCatalog(m, force)
      } catch {
        unavailable.push({ source: m.source })
        continue
      }
      let treeDir: string
      let paths: string[]
      try {
        treeDir = await ensureTree(m, force)
        paths = await treePaths(treeDir)
      } catch {
        unavailable.push({ source: m.source })
        continue
      }
      for (const plugin of cat.parsed.plugins) {
        // solo le voci con sorgente RELATIVA: i plugin che vivono DENTRO il
        // repository del marketplace. Le sorgenti esterne non entrano: senza
        // scaricarle non si può sapere cosa contengono (la scelta di Rakazo)
        if (plugin.source.kind !== 'relative') {
          skipped.push({ plugin: plugin.name, reason: `external source (${plugin.source.kind}): not vendored in the marketplace` })
          continue
        }
        const relErr = relativeSourceError(plugin.source.path)
        if (relErr) {
          skipped.push({ plugin: plugin.name, reason: relErr })
          continue
        }
        const dir = plugin.source.path.slice(2) // './plugins/x' → 'plugins/x'
        const own = paths.filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1))
        if (own.length === 0) {
          skipped.push({ plugin: plugin.name, reason: `plugin folder missing in the marketplace tree: ${plugin.source.path}` })
          continue
        }
        const manifestText = paths.includes(`${dir}/.claude-plugin/plugin.json`)
          ? await treeFile(treeDir, `${dir}/.claude-plugin/plugin.json`, MANIFEST_MAX_BYTES)
          : null
        const mcpText = paths.includes(`${dir}/.mcp.json`)
          ? await treeFile(treeDir, `${dir}/.mcp.json`, MCP_MAX_BYTES)
          : null
        const detailed = classifyDetailed(own, manifestText, mcpText)
        if (!('classification' in detailed)) {
          skipped.push({ plugin: plugin.name, reason: detailed.reason })
          continue
        }
        const manifest = manifestText !== null ? safeJson(manifestText) : null
        entries.push({
          id: `plugin:${plugin.name}@${cat.parsed.name}`,
          name: plugin.name,
          displayName: manifestDisplayName(manifest, plugin.name),
          description: plugin.description ?? '',
          category: manifestCategory(manifest),
          keywords: manifestKeywords(manifest),
          homepage: manifestHomepage(manifest),
          marketplace: cat.parsed.name,
          official: m.official,
          skillCount: detailed.classification.skillCount,
          skillNames: detailed.classification.skillNames
        })
      }
    }
    return { entries: sortSkillPacks(entries as SkillPackEntry[]).map(stripInstalled), unavailable, skipped }
  }

  async function loadInternal(force: boolean): Promise<SkillBrowseInternal> {
    if (!force && cache && now() - cache.at < SKILL_BROWSE_CACHE_MS) return cache.data
    // due richieste contemporanee condividono lo stesso lavoro (un solo clone)
    if (pending) return pending
    const job = (async () => {
      const data = await buildInternal(force)
      // gli errori NON vanno mai in cache: solo un successo la scrive
      cache = { at: now(), data }
      return data
    })()
    pending = job
    try {
      return await job
    } finally {
      pending = null
    }
  }

  /** Il catalogo per la finestra: voci con «Aggiunto», filtrate e ordinate dalla query. */
  async function browse(query = '', opts: { retry?: boolean } = {}): Promise<SkillBrowseOutcome> {
    const internal = await loadInternal(opts.retry === true)
    const installed = deps.installedPlugins()
    const entries = internal.entries.map((e) => ({
      ...e,
      installed: installed.some((p) => p.name === e.name && p.marketplace === e.marketplace)
    }))
    return {
      entries: searchSkillPacks(entries, query),
      unavailable: internal.unavailable,
      skipped: internal.skipped
    }
  }

  return { browse }
}

/** JSON sicuro: null quando non è un oggetto (il chiamante mostra i default). */
function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function manifestDisplayName(manifest: Record<string, unknown> | null, name: string): string {
  const d = manifest?.displayName
  if (typeof d === 'string' && d.trim() && d.length <= 120) return d.trim()
  return titleCaseName(name)
}

function manifestCategory(manifest: Record<string, unknown> | null): string {
  const c = manifest?.category
  return typeof c === 'string' && c.trim() && c.length <= 60 ? c.trim().toLowerCase() : ''
}

function manifestKeywords(manifest: Record<string, unknown> | null): string[] {
  const k = manifest?.keywords
  if (!Array.isArray(k) || k.length > 50) return []
  return k.filter((x): x is string => typeof x === 'string' && x.length <= 120).slice(0, 50)
}

function manifestHomepage(manifest: Record<string, unknown> | null): string {
  const h = manifest?.homepage
  if (typeof h !== 'string' || !h || h.length > 2048) return ''
  return /^https:\/\//.test(h) ? h : ''
}

/** toglie il campo installed (la cache non lo tiene: si calcola a ogni chiamata). */
function stripInstalled(e: SkillPackEntry): SkillPackEntryBase {
  const { installed: _installed, ...base } = e
  return base
}
