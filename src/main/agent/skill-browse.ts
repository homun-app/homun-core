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
// `git ls-tree -r --name-only HEAD` (niente blob) e il solo file che serve
// (`.claude-plugin/plugin.json`; fino alla fase sfoglia veloce anche
// `.mcp.json`) da `git show HEAD:<path>`, che
// col clone parziale scarica solo QUEI blob. Il clone vive in
// <dataDir>/cache/marketplaces/ come il catalogo (M6 della fase 13): una
// cartella per sorgente col suffisso -tree, TTL di 1 ora, re-clone in una
// cartella NUOVA che poi sostituisce la vecchia. NON si riusa il clone del
// catalogo: quello dei marketplace github NON ESISTE (il marketplace.json
// arriva da raw.githubusercontent.com) e quello dei marketplace git è
// sparse-checkout del solo .claude-plugin/ col ciclo di vita gestito dal
// manager per i cataloghi — l'albero intero serve invece qui.
//
// Fase SFOGLIA VELOCE (V1/V2): aprire la finestra non rifà niente. Il disegno
// è quello di Rakazo (registryData, stale-while-revalidate): il catalogo
// classificato vive ANCHE su disco (<dataDir>/cache/marketplaces/
// skill-browse.json, con l'ora e lo sha della HEAD di ogni marketplace) e si
// rilegge alla creazione del browser, cioè a ogni avvio del daemon; scaduto
// (10 minuti) si dà SUBITO e si aggiorna in sottofondo, poi il daemon emette
// skills:browse-updated. Solo la prima volta in assoluto si aspetta, col
// conteggio skills:browse-progress. Il clone si rifà SOLTANTO se la HEAD
// remota è cambiata (git ls-remote, una chiamata leggera); la riprova sul
// clone invariato fa un fetch --depth 1 --filter=blob:none, mai un clone.
// Le letture dei manifest vanno in parallelo (tetto 8, come i worker di
// MANIFEST_CONCURRENCY in Rakazo), .mcp.json NON si legge mai (la presenza
// nell'albero basta per dire connettore) e la classificazione di un
// marketplace ha un tetto di 60 s: oltre, i plugin non letti vanno in
// skipped («tempo scaduto»). La cache serve SOLO a mostrare l'elenco:
// l'installazione passa sempre da buildPluginCard (sha fissato, controllo L6).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { SandbotEvent } from '../../shared/types'
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

/** V2: i git show dei manifest in parallelo, al massimo 8 insieme (MANIFEST_CONCURRENCY di Rakazo). */
export const MANIFEST_CONCURRENCY = 8

/** V2: il tetto di tempo della classificazione di UN marketplace: oltre, i plugin non letti vanno in skipped. */
export const SKILL_BROWSE_TIME_CAP_MS = 60_000

/**
 * V2: il motivo dello scarto dei plugin rimasti senza lettura allo scadere
 * del tetto (il «tempo scaduto» della spec; in inglese come gli altri motivi
 * degli scarti: la guardia del testo italiano di main/daemon lo esige).
 */
const TIME_CAP_REASON = `time limit reached: not read within ${SKILL_BROWSE_TIME_CAP_MS / 1000} s`

/** Il motivo dello scarto di un plugin con server MCP nel suo .mcp.json. */
const MCP_JSON_REASON = 'contains MCP servers (.mcp.json): it is a connector, add it from Connect apps'

/** V1: il file del catalogo classificato su disco (si rilegge all'avvio del daemon). */
export function skillBrowseCacheFile(dataRoot: string): string {
  return join(marketplaceCacheDir(dataRoot), 'skill-browse.json')
}

/** V1: gli eventi del browser verso la finestra (avanzamento e catalogo aggiornato). */
export type SkillBrowseEvent = Extract<SandbotEvent, { type: 'skills:browse-progress' | 'skills:browse-updated' }>

/** Tetto dell'elenco dei file del marketplace (git ls-tree -r). */
const TREE_MAX_FILES = 50_000
/** Il solo file letto col clone parziale: il manifest, 64 KB (V2: .mcp.json mai — basta la presenza). */
const MANIFEST_MAX_BYTES = 64_000

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
  if (mcpText !== null) return { reason: MCP_JSON_REASON }
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
  /** V1: gli eventi per la finestra (il daemon li manda a tutte le finestre) */
  emit?: (e: SkillBrowseEvent) => void
}

/** Il catalogo interno: voci SENZA stato di installazione (quello si calcola a ogni chiamata). */
interface SkillBrowseInternal {
  entries: SkillPackEntryBase[]
  unavailable: Array<{ source: string }>
  skipped: SkillBrowseSkipped[]
}

/** V1: il catalogo su disco — l'ora, lo sha della HEAD di ogni marketplace, i dati. */
interface SkillBrowseDiskCache {
  version: 1
  at: number
  heads: Record<string, string>
  /** i marketplace per cui è stato costruito (se l'elenco cambia, vale come scaduto) */
  sources: string[]
  /** il nome di ogni marketplace (dal suo marketplace.json): le voci lo portano in `marketplace` */
  names: Record<string, string>
  data: SkillBrowseInternal
}

/** V1: la cache in memoria (quella riletta dal disco o l'ultima classificazione). */
interface SkillBrowseCache {
  at: number
  sources: string[]
  names: Record<string, string>
  data: SkillBrowseInternal
}

/** V1: lo stesso insieme di marketplace (l'ordine non conta). */
function sameSources(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sb = [...b].sort()
  return [...a].sort().every((s, i) => s === sb[i])
}

export type SkillBrowseOutcome = {
  entries: SkillPackEntry[]
  unavailable: Array<{ source: string }>
  skipped: SkillBrowseSkipped[]
}

const fileUrlsAllowed = (deps: SkillBrowseDeps): boolean =>
  deps.allowFileUrlsForTests === true || process.env.SANDBOT_TEST_ALLOW_FILE_URLS === '1'

/** Uno sha di git (sha1 o sha256). */
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

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

/** V1: lo sha della HEAD remota con una chiamata LEGGERA (nessun blob, nessun clone), stesse regole sicure. */
export function lsRemoteArgv(url: string, opts: { allowFileUrlsForTests?: boolean } = {}): string[] {
  return [
    '-c', 'core.hooksPath=/dev/null',
    ...(opts.allowFileUrlsForTests ? [] : ['-c', 'protocol.file.allow=never']),
    'ls-remote', '--', url, 'HEAD'
  ]
}

/**
 * V1: l'aggiornamento LEGGERO del clone esistente (mai buttarlo): fetch
 * --depth 1 --filter=blob:none dall'origin del clone parziale (il filtro vale
 * solo per il remote del partial clone, non per un URL qualsiasi).
 */
export function treeFetchArgv(opts: { allowFileUrlsForTests?: boolean } = {}): string[] {
  return [
    '-c', 'core.hooksPath=/dev/null',
    ...(opts.allowFileUrlsForTests ? [] : ['-c', 'protocol.file.allow=never']),
    'fetch', '--depth', '1',
    '--no-recurse-submodules',
    '--filter', 'blob:none',
    'origin'
  ]
}

/** V2: un pool di `limit` lavoratori su un elenco (nessuna dipendenza nuova). */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * Il browser del catalogo: cache di 10 minuti per il classificato, errori MAI
 * in cache, richieste contemporanee che condividono lo stesso lavoro (un solo
 * clone), un marketplace illeggibile finisce in `unavailable` senza far
 * fallire gli altri. V1: la cache vive anche su disco e si rilegge QUI (alla
 * creazione, cioè all'avvio del daemon); scaduta si dà subito e si aggiorna
 * in sottofondo.
 */
export function createSkillBrowser(deps: SkillBrowseDeps) {
  const now = deps.now ?? Date.now
  const run = deps.runGit ?? spawnGitRun
  const mkd = deps.mkdtemp ?? ((prefix: string) => mkdtempSync(join(marketplaceCacheDir(deps.dataDir()), prefix)))
  const allowFile = fileUrlsAllowed(deps)
  /** il lavoro in corso, condiviso: force = è una «Riprova» */
  let pending: { job: Promise<SkillBrowseInternal>; force: boolean } | null = null
  /** V1: c'è già un aggiornamento in sottofondo (uno alla volta) */
  let revalidating = false
  /** i cloni degli alberi per sorgente (TTL di 1 ora, come il catalogo) e lo sha della loro HEAD */
  const trees = new Map<string, { dir: string; at: number; sha: string | null }>()

  // come il manager dei marketplace (M6): le temporanee .tree-clone-* di un
  // clone interrotto si buttano via alla creazione (e quelle della cache su
  // disco, .skill-browse-*, di una scrittura interrotta)
  try {
    const root = marketplaceCacheDir(deps.dataDir())
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (ent.name.startsWith('.tree-clone-') || ent.name.startsWith('.skill-browse-')) rmSync(join(root, ent.name), { recursive: true, force: true })
    }
  } catch {
    // root assente al primo avvio: normale
  }

  /** V1: la cache su disco, riletta alla creazione; null se assente o non valida. */
  function readDiskCache(): SkillBrowseCache | null {
    try {
      const raw = JSON.parse(readFileSync(skillBrowseCacheFile(deps.dataDir()), 'utf8')) as Partial<SkillBrowseDiskCache> | null
      const d = raw?.data
      if (raw?.version !== 1 || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null
      if (!Array.isArray(raw.sources) || !raw.names || typeof raw.names !== 'object') return null
      if (!d || !Array.isArray(d.entries) || !Array.isArray(d.unavailable) || !Array.isArray(d.skipped)) return null
      return { at: raw.at, sources: raw.sources.map(String), names: raw.names, data: d }
    } catch {
      return null // prima volta in assoluto (o file illeggibile): si aspetta la lettura
    }
  }

  /** V1: scrive la cache su disco (file temporaneo + rename: mai un file a metà). */
  function writeDiskCache(c: SkillBrowseCache, heads: Record<string, string>): void {
    try {
      const root = marketplaceCacheDir(deps.dataDir())
      mkdirSync(root, { recursive: true })
      const tmp = join(root, `.skill-browse-${process.pid}.json`)
      const body: SkillBrowseDiskCache = { version: 1, at: c.at, heads, sources: c.sources, names: c.names, data: c.data }
      writeFileSync(tmp, JSON.stringify(body))
      renameSync(tmp, skillBrowseCacheFile(deps.dataDir()))
    } catch {
      // disco pieno o in sola lettura: resta la cache in memoria
    }
  }

  let cache: SkillBrowseCache | null = readDiskCache()

  /** Il timestamp del clone (sidecar `<dir>.at`); null se mai clonato. */
  const cloneTime = (dir: string): number | null => {
    try {
      const t = Number(readFileSync(`${dir}.at`, 'utf8').trim())
      return Number.isFinite(t) ? t : null
    } catch {
      return null
    }
  }

  /** V1: lo sha della HEAD del clone — dal sidecar `<dir>.head` o, se manca (clone di prima), da git rev-parse. */
  async function localHead(dir: string): Promise<string | null> {
    try {
      const s = readFileSync(`${dir}.head`, 'utf8').trim()
      if (SHA_RE.test(s)) return s
    } catch {
      // nessun sidecar: lo si chiede a git (locale, niente rete)
    }
    const r = await run(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: PLUGIN_TIMEOUT_MS })
    const sha = r.code === 0 ? r.stdout.trim() : ''
    if (!SHA_RE.test(sha)) return null
    try { writeFileSync(`${dir}.head`, sha) } catch { /* sola lettura: si richiede la prossima volta */ }
    return sha
  }

  /** V1: lo sha della HEAD remota (git ls-remote <url> HEAD: una chiamata leggera). */
  async function remoteHead(url: string): Promise<string | null> {
    const r = await run(lsRemoteArgv(url, { allowFileUrlsForTests: allowFile }), { timeoutMs: PLUGIN_TIMEOUT_MS })
    if (r.code !== 0) return null
    const sha = r.stdout.trim().split(/\s+/)[0] ?? ''
    return SHA_RE.test(sha) ? sha : null
  }

  /**
   * Il clone parziale dell'albero del marketplace (TTL 1 h, sostituzione
   * atomica). V1: un clone che c'è già si rifà SOLTANTO se la HEAD remota è
   * cambiata (ls-remote); invariata, si tiene (la riprova lo aggiorna con un
   * fetch leggero). MAI buttare il clone per una semplice apertura.
   */
  async function ensureTree(m: { source: string; kind: 'github' | 'git' }, force: boolean): Promise<{ dir: string; at: number; sha: string | null }> {
    const url = m.kind === 'github' ? githubRepoUrl(m.source) : m.source
    const check = checkGitUrl(url, { allowFileUrlsForTests: allowFile })
    if (!check.ok) throw new Error(check.error)
    const dir = join(marketplaceCacheDir(deps.dataDir()), `${marketplaceCacheName(m.source)}-tree`)
    if (!force) {
      const hit = trees.get(m.source)
      if (hit && now() - hit.at < MARKETPLACE_CACHE_MS) return hit
      const diskAt = cloneTime(dir)
      if (diskAt !== null && now() - diskAt < MARKETPLACE_CACHE_MS) {
        const tree = { dir, at: diskAt, sha: await localHead(dir) }
        trees.set(m.source, tree)
        return tree
      }
    }
    mkdirSync(marketplaceCacheDir(deps.dataDir()), { recursive: true })
    if (cloneTime(dir) !== null) {
      const remote = await remoteHead(url)
      if (remote === null) throw new Error('marketplace unreachable: git ls-remote failed')
      const local = await localHead(dir)
      if (local === remote) {
        // la HEAD è la stessa: il clone resta. La riprova lo aggiorna con un
        // fetch leggero (un fallimento non conta: l'albero è già alla HEAD giusta)
        if (force) await run(treeFetchArgv({ allowFileUrlsForTests: allowFile }), { cwd: dir, timeoutMs: PLUGIN_TIMEOUT_MS })
        writeFileSync(`${dir}.at`, String(now()))
        const tree = { dir, at: now(), sha: local }
        trees.set(m.source, tree)
        return tree
      }
    }
    // il primo clone, o la HEAD remota è cambiata: clone NUOVO in una
    // cartella temporanea che poi sostituisce la vecchia
    const tmp = mkd('.tree-clone-')
    const r = await run(treeCloneArgv(url, tmp, { allowFileUrlsForTests: allowFile }), { timeoutMs: PLUGIN_TIMEOUT_MS })
    if (r.code !== 0) {
      rmSync(tmp, { recursive: true, force: true })
      throw new Error(`marketplace tree clone failed: ${r.stderr.trim().slice(0, 160)}`)
    }
    rmSync(dir, { recursive: true, force: true })
    renameSync(tmp, dir)
    rmSync(`${dir}.head`, { force: true })
    writeFileSync(`${dir}.at`, String(now()))
    const tree = { dir, at: now(), sha: await localHead(dir) }
    trees.set(m.source, tree)
    return tree
  }

  /** L'elenco dei file del marketplace a HEAD (git ls-tree: nessun blob). */
  async function treePaths(dir: string): Promise<string[]> {
    const r = await run(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir, timeoutMs: PLUGIN_TIMEOUT_MS })
    if (r.code !== 0) throw new Error(`git ls-tree failed: ${r.stderr.trim().slice(0, 160)}`)
    const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length > TREE_MAX_FILES) throw new Error(`marketplace tree too large (${lines.length} files)`)
    return lines
  }

  /**
   * Il contenuto di UN file del marketplace a HEAD (git show: col clone
   * parziale scarica solo quel blob). V2: failed = la lettura NON è riuscita
   * (anche uccisa allo scadere del tetto di tempo); text null = troppo grande.
   */
  async function treeFile(dir: string, path: string, maxBytes: number, timeoutMs: number): Promise<{ failed: boolean; text: string | null }> {
    const r = await run(['show', `HEAD:${path}`], { cwd: dir, timeoutMs })
    if (r.code !== 0) return { failed: true, text: null }
    if (Buffer.byteLength(r.stdout, 'utf8') > maxBytes) return { failed: false, text: null }
    return { failed: false, text: r.stdout }
  }

  /** Un marketplace pronto da classificare: catalogo, albero, elenco dei file e il suo tetto di tempo. */
  interface ReadyMarketplace {
    m: { source: string; official: boolean }
    cat: MarketplaceCatalog
    treeDir: string
    paths: string[]
    deadlineAt: number
  }
  type PluginOutcome = { entry: SkillPackEntryBase } | { skipped: SkillBrowseSkipped }

  /**
   * Classifica UN plugin. V2: .mcp.json NON si legge mai (la presenza
   * nell'albero basta: è un connettore), il manifest si legge SOLO se c'è e
   * solo entro il tetto di tempo del marketplace (oltre: «tempo scaduto»).
   */
  async function classifyPlugin(mp: ReadyMarketplace, plugin: MarketplaceCatalog['parsed']['plugins'][number]): Promise<PluginOutcome> {
    const skip = (reason: string): PluginOutcome => ({ skipped: { plugin: plugin.name, reason } })
    // solo le voci con sorgente RELATIVA: i plugin che vivono DENTRO il
    // repository del marketplace. Le sorgenti esterne non entrano: senza
    // scaricarle non si può sapere cosa contengono (la scelta di Rakazo)
    if (plugin.source.kind !== 'relative') return skip(`external source (${plugin.source.kind}): not vendored in the marketplace`)
    const relErr = relativeSourceError(plugin.source.path)
    if (relErr) return skip(relErr)
    const dir = plugin.source.path.slice(2) // './plugins/x' → 'plugins/x'
    const own = mp.paths.filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1))
    if (own.length === 0) return skip(`plugin folder missing in the marketplace tree: ${plugin.source.path}`)
    // V2: la PRESENZA di .mcp.json basta per dire connettore, senza leggerlo
    if (own.includes('.mcp.json')) return skip(MCP_JSON_REASON)
    let manifestText: string | null = null
    if (own.includes('.claude-plugin/plugin.json')) {
      // V2: il tetto di tempo — una lettura che non comincia (o non finisce) entro il tetto non c'è
      const left = mp.deadlineAt - now()
      if (left <= 0) return skip(TIME_CAP_REASON)
      const read = await treeFile(mp.treeDir, `${dir}/.claude-plugin/plugin.json`, MANIFEST_MAX_BYTES, Math.min(PLUGIN_TIMEOUT_MS, left))
      if (read.failed && now() >= mp.deadlineAt) return skip(TIME_CAP_REASON)
      manifestText = read.text
    }
    const detailed = classifyDetailed(own, manifestText, null)
    if (!('classification' in detailed)) return skip(detailed.reason)
    const manifest = manifestText !== null ? safeJson(manifestText) : null
    return {
      entry: {
        id: `plugin:${plugin.name}@${mp.cat.parsed.name}`,
        name: plugin.name,
        displayName: manifestDisplayName(manifest, plugin.name),
        description: plugin.description ?? '',
        category: manifestCategory(manifest),
        keywords: manifestKeywords(manifest),
        homepage: manifestHomepage(manifest),
        marketplace: mp.cat.parsed.name,
        official: mp.m.official,
        skillCount: detailed.classification.skillCount,
        skillNames: detailed.classification.skillNames
      }
    }
  }

  /**
   * Il catalogo classificato di TUTTI i marketplace (un fallimento non si
   * porta via gli altri). Fase 1: catalogo, clone dell'albero ed elenco dei
   * file di ogni marketplace. Fase 2 (V2): i plugin di tutti i marketplace in
   * UN pool con tetto 8, col conteggio per la finestra (V1) e il tetto di 60 s
   * per marketplace, che parte quando ne comincia la classificazione.
   */
  async function buildInternal(force: boolean): Promise<{ data: SkillBrowseInternal; heads: Record<string, string>; sources: string[]; names: Record<string, string> }> {
    const entries: SkillPackEntryBase[] = []
    const unavailable: Array<{ source: string }> = []
    const skipped: SkillBrowseSkipped[] = []
    const heads: Record<string, string> = {}
    const names: Record<string, string> = {}
    const ready: Array<Omit<ReadyMarketplace, 'deadlineAt'>> = []
    const registered = deps.marketplaces.list()
    for (const m of registered) {
      let cat: MarketplaceCatalog
      try {
        cat = await deps.marketplaces.fetchCatalog(m, force)
      } catch {
        unavailable.push({ source: m.source })
        continue
      }
      names[m.source] = cat.parsed.name
      try {
        const tree = await ensureTree(m, force)
        const paths = await treePaths(tree.dir)
        if (tree.sha) heads[m.source] = tree.sha
        ready.push({ m, cat, treeDir: tree.dir, paths })
      } catch {
        unavailable.push({ source: m.source })
        continue
      }
    }
    const start = now()
    const work = ready.flatMap((r) => {
      const mp: ReadyMarketplace = { ...r, deadlineAt: start + SKILL_BROWSE_TIME_CAP_MS }
      return mp.cat.parsed.plugins.map((plugin) => ({ mp, plugin }))
    })
    const total = work.length
    let done = 0
    deps.emit?.({ type: 'skills:browse-progress', done, total })
    await mapLimit(work, MANIFEST_CONCURRENCY, async ({ mp, plugin }) => {
      let out: PluginOutcome
      try {
        out = await classifyPlugin(mp, plugin)
      } catch (e) {
        out = { skipped: { plugin: plugin.name, reason: `could not read the plugin: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) } }
      }
      if ('entry' in out) entries.push(out.entry)
      else skipped.push(out.skipped)
      done++
      deps.emit?.({ type: 'skills:browse-progress', done, total })
    })
    // il pool finisce in ordine sparso: gli scarti si mettono in fila per nome
    skipped.sort((a, b) => a.plugin.localeCompare(b.plugin))
    return {
      data: { entries: sortSkillPacks(entries as SkillPackEntry[]).map(stripInstalled), unavailable, skipped },
      heads,
      sources: registered.map((m) => m.source),
      names
    }
  }

  /**
   * Un catalogo FRESCO (classificato adesso). Due richieste contemporanee
   * condividono lo stesso lavoro (un solo clone); una «Riprova» non si
   * accontenta di un aggiornamento normale in corso: lo aspetta e poi rilegge
   * davvero. Gli errori NON vanno mai in cache: solo un successo la scrive.
   */
  async function loadFresh(force: boolean): Promise<SkillBrowseInternal> {
    while (pending) {
      if (pending.force || !force) return pending.job
      await pending.job.catch(() => undefined)
    }
    const job = (async () => {
      const { data, heads, sources, names } = await buildInternal(force)
      cache = { at: now(), sources, names, data }
      writeDiskCache(cache, heads)
      return data
    })()
    const mine = { job, force }
    pending = mine
    try {
      return await job
    } finally {
      if (pending === mine) pending = null
    }
  }

  /** V1: l'aggiornamento in sottofondo della cache scaduta; finito, la finestra aperta ricarica. */
  function revalidate(): void {
    if (revalidating) return
    revalidating = true
    void loadFresh(false)
      .then(() => { deps.emit?.({ type: 'skills:browse-updated' }) })
      .catch(() => undefined) // resta il vecchio catalogo: la prossima apertura riprova
      .finally(() => { revalidating = false })
  }

  /**
   * Il catalogo interno per una chiamata. V1: la riprova legge DAVVERO; con
   * la cache (anche quella riletta dal disco) si risponde SUBITO — scaduta, la
   * si aggiorna in sottofondo; solo la prima volta in assoluto si aspetta. Se
   * l'elenco dei marketplace è cambiato (Collega app › Marketplace) la cache
   * vale come scaduta e i pacchetti dei marketplace TOLTI spariscono subito.
   */
  async function loadInternal(retry: boolean): Promise<SkillBrowseInternal> {
    if (retry) return loadFresh(true)
    if (cache) {
      const registered = deps.marketplaces.list()
      const changed = !sameSources(registered.map((m) => m.source), cache.sources)
      if (changed || now() - cache.at >= SKILL_BROWSE_CACHE_MS) revalidate()
      if (!changed) return cache.data
      const sources = new Set(registered.map((m) => m.source))
      const kept = new Set(registered.map((m) => cache!.names[m.source]).filter((n): n is string => Boolean(n)))
      return {
        entries: cache.data.entries.filter((e) => kept.has(e.marketplace)),
        unavailable: cache.data.unavailable.filter((u) => sources.has(u.source)),
        skipped: cache.data.skipped
      }
    }
    return loadFresh(false)
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
