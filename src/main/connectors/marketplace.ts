// Plugin nel formato di Claude Code (fase 13, punto 4): il marketplace è un
// repo git con `.claude-plugin/marketplace.json`; il plugin è una cartella con
// manifest `.claude-plugin/plugin.json` (opzionale), `skills/<n>/SKILL.md`,
// `.mcp.json` o `mcpServers` nel manifest, più le componenti che SandBot NON
// importa MAI (hook, bin/, monitor, LSP, command, agent): di terzi si prendono
// SOLO skill e server MCP, e i server stdio girano nel BOX, non sul Mac.
//
// parseMarketplace e inspectPlugin sono PURE (sul JSON e sul filesystem);
// il clone sicuro usa git con hook DISATTIVATI, https SOLO (file:// solo col
// flag di test), tetti di dimensione/file/tempo e rifiuto dei symlink che
// escono dalla cartella.
import { spawn } from 'node:child_process'
// fase rilascio (A7): git di /usr/bin o Homebrew, non il nome semplice
import { resolveTool } from '../tool-paths'
import { existsSync, lstatSync, mkdtempSync, cpSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
// fase 17c (C3): le issue di parse del marketplace si mostrano nella UI
import { uiText } from '../ui-language'
import { UI } from '../../shared/ui-messages'

/** Nome valido di plugin/marketplace: ^[A-Za-z0-9][A-Za-z0-9._-]*$. */
export const VALID_PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** sha valido: 40 esadecimali minuscoli. */
export const VALID_SHA_RE = /^[0-9a-f]{40}$/

/** Tetti del download del plugin: 50 MB, 5000 file, 120 s. */
export const PLUGIN_MAX_BYTES = 50 * 1024 * 1024
export const PLUGIN_MAX_FILES = 5000
export const PLUGIN_TIMEOUT_MS = 120_000

/** Le sorgenti dei plugin supportate (npm/archive/command NON lo saranno mai). */
export type PluginSource =
  | { kind: 'relative'; path: string }
  | { kind: 'github'; repo: string; ref?: string; sha?: string }
  | { kind: 'url'; url: string; ref?: string; sha?: string }
  | { kind: 'git-subdir'; url: string; path: string; ref?: string; sha?: string }
  | { kind: 'npm'; package: string }
  | { kind: 'archive'; url: string }
  | { kind: 'command'; command: string }

export interface MarketplacePlugin {
  name: string
  description?: string
  source: PluginSource
  /** developerMetadata.author → mostrato come editore nella ricerca */
  author?: string
}

export interface ParsedMarketplace {
  name: string
  owner?: string
  plugins: MarketplacePlugin[]
}

export interface MarketplaceParseIssue {
  plugin: string
  reason: string
}

/**
 * parseMarketplace(json) (pura): segue lo schema del riferimento; le voci non
 * valide si scartano UNA PER UNA e la ragione si registra.
 */
export function parseMarketplace(json: unknown): { marketplace: ParsedMarketplace | null; issues: MarketplaceParseIssue[] } {
  const issues: MarketplaceParseIssue[] = []
  const root = json as { name?: unknown; owner?: unknown; plugins?: unknown } | null
  // fase 17c (C3): le issue si mostrano nella scheda Marketplace — testi del
  // catalogo UI nella lingua dell'interfaccia (risolti qui, al build)
  if (!root || typeof root !== 'object') {
    return { marketplace: null, issues: [{ plugin: uiText(UI.mpRoot), reason: uiText(UI.mpNotObject) }] }
  }
  if (typeof root.name !== 'string' || !VALID_PLUGIN_NAME_RE.test(root.name)) {
    return { marketplace: null, issues: [{ plugin: uiText(UI.mpRoot), reason: uiText(UI.mpBadName, { name: String(root.name) }) }] }
  }
  const plugins: MarketplacePlugin[] = []
  if (Array.isArray(root.plugins)) {
    for (const raw of root.plugins) {
      const p = raw as Record<string, unknown>
      const name = typeof p?.name === 'string' ? p.name : ''
      if (!name || !VALID_PLUGIN_NAME_RE.test(name)) {
        issues.push({ plugin: name || uiText(UI.mpUnnamed), reason: uiText(UI.mpBadPluginName, { name }) })
        continue
      }
      const source = parsePluginSource(p?.source)
      if (!source) {
        issues.push({ plugin: name, reason: uiText(UI.mpBadSource, { source: JSON.stringify(p?.source ?? null).slice(0, 80) }) })
        continue
      }
      const author = (p?.developerMetadata as { author?: unknown } | undefined)?.author
      plugins.push({
        name,
        ...(typeof p?.description === 'string' && p.description ? { description: p.description } : {}),
        source,
        ...(typeof author === 'string' && author ? { author } : {})
      })
    }
  }
  return {
    marketplace: { name: root.name, ...(typeof root.owner === 'string' && root.owner ? { owner: root.owner } : {}), plugins },
    issues
  }
}

/** ref/sha opzionali di una sorgente: 40 hex minuscoli = sha, il resto = ref. */
function optRef(v: unknown): { ref?: string; sha?: string } {
  if (typeof v !== 'string' || !v) return {}
  return /^[0-9a-f]{40}$/.test(v) ? { sha: v } : { ref: v }
}

/**
 * La sorgente di una voce (pura): il formato REALE di marketplace.json usa
 * `source` come STRINGA relativa ("./plugins/x") o oggetto col TIPO nella
 * chiave `source` stessa: {"source":"git-subdir","url":…,"path":…,"ref":…}.
 * (La chiave `sourceType` non esiste nel formato vero.) Le sorgenti
 * relativa/github/url/git-subdir sono supportate; npm/archive/command sono
 * riconosciute ma NON supportate (command esegue codice sulla macchina
 * dell'utente: non sarà mai supportata).
 */
function parsePluginSource(s: unknown): PluginSource | null {
  // relativa in forma di stringa: "./plugins/x"
  if (typeof s === 'string' && s.startsWith('./')) return { kind: 'relative', path: s }
  if (!s || typeof s !== 'object') return null
  const o = s as Record<string, unknown>
  const type = typeof o.source === 'string' ? o.source : null
  const rel = typeof o.relativePath === 'string' ? o.relativePath : typeof o.path === 'string' && (type === 'relative') ? o.path : null
  if (rel) return { kind: 'relative', path: rel }
  if (type === 'github' || (!type && typeof o.repo === 'string' && o.repo)) {
    if (typeof o.repo !== 'string' || !o.repo) return null
    return { kind: 'github', repo: o.repo, ...optRef(o.ref), ...optRef(o.sha) }
  }
  if (type === 'git-subdir' || (!type && typeof o.url === 'string' && typeof o.path === 'string')) {
    if (typeof o.url !== 'string' || typeof o.path !== 'string') return null
    return { kind: 'git-subdir', url: o.url, path: o.path, ...optRef(o.ref), ...optRef(o.sha) }
  }
  if (type === 'url' || type === 'archive' || (!type && typeof o.url === 'string')) {
    if (typeof o.url !== 'string') return null
    if (type === 'archive') return { kind: 'archive', url: o.url }
    return { kind: 'url', url: o.url, ...optRef(o.ref), ...optRef(o.sha) }
  }
  if (type === 'npm' || (!type && typeof o.package === 'string')) {
    return typeof o.package === 'string' ? { kind: 'npm', package: o.package } : null
  }
  if (type === 'command' || (!type && typeof o.command === 'string')) {
    return typeof o.command === 'string' ? { kind: 'command', command: o.command } : null
  }
  return null
}

/** Le sorgenti che SandBot SA scaricare (npm/archive/command mai). */
export function sourceSupported(s: PluginSource): boolean {
  return s.kind === 'relative' || s.kind === 'github' || s.kind === 'url' || s.kind === 'git-subdir'
}

// ---- clonazione sicura (sul Mac si SCARICA e basta: niente esecuzione) ----

export interface GitCloneDeps {
  /** test: URL file:// ammessi (in produzione MAI) */
  allowFileUrlsForTests?: boolean
  /** runner git iniettabile (default: spawn di git) */
  run?: (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>
  mkdtemp?: (prefix: string) => string
}

/**
 * L'argv del clone sicuro (puro): hook DISATTIVATI (core.hooksPath=/dev/null),
 * protocol.file.allow=never (niente file:// dentro ai repo), depth 1, senza
 * submoduli, blob:none; --sparse quando serve una sotto-cartella. Il flag di
 * test SOLO per i repo git locali di fixture: in produzione MAI (senza il
 * -c protocol.file il default di git ammetterebbe file://).
 */
export function gitCloneArgv(url: string, staging: string, sparse: boolean, opts: { allowFileUrlsForTests?: boolean } = {}): string[] {
  return [
    '-c', 'core.hooksPath=/dev/null',
    ...(opts.allowFileUrlsForTests ? [] : ['-c', 'protocol.file.allow=never']),
    'clone', '--depth', '1',
    '--no-recurse-submodules',
    '--filter', 'blob:none',
    ...(sparse ? ['--sparse'] : []),
    '--', url, staging
  ]
}

/** Verifica l'URL git di una sorgente (pura): https SOLAMENTE (mai file:// né ssh); i test iniettano il flag. */
export function checkGitUrl(url: string, opts: { allowFileUrlsForTests?: boolean } = {}): { ok: true } | { ok: false; error: string } {
  if (url.startsWith('https://')) return { ok: true }
  if (opts.allowFileUrlsForTests && url.startsWith('file://')) return { ok: true }
  return { ok: false, error: `source is not https: ${url} (in production it clones only from https)` }
}

/** github:owner/repo → https://github.com/<owner>/<repo>.git */
export function githubRepoUrl(repo: string): string {
  const clean = repo.replace(/^github:/, '').replace(/\.git$/, '')
  return `https://github.com/${clean}.git`
}

const defaultRun: NonNullable<GitCloneDeps['run']> = (args, opts = {}) =>
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

/** Conteggio ricorsivo di file e byte dentro una cartella (tetti del download). */
export function dirStats(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile()) {
        files++
        bytes += statSync(p).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

/**
 * Rifiuta i link simbolici che ESCONO dalla cartella del plugin (puro sul
 * filesystem): un symlink dentro la cartella che punta fuori aprirebbe file
 * del Mac alla copia nel box.
 */
export function findEscapingSymlink(dir: string): string | null {
  const walk = (d: string): string | null => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isSymbolicLink()) {
        const dest = resolve(d, readlinkSync(p))
        const rel = relative(dir, dest)
        if (rel.startsWith('..') || isAbsolute(rel)) return p
        continue
      }
      if (ent.isDirectory()) {
        const found = walk(p)
        if (found) return found
      }
    }
    return null
  }
  return walk(dir)
}

/** Un path relativo di sorgente deve iniziare con ./ e non contenere .. (puro). */
export function relativeSourceError(path: string): string | null {
  if (!path.startsWith('./')) return `relative source must start with "./" (${path})`
  if (path.split('/').includes('..')) return `relative source cannot contain ".." (${path})`
  return null
}

export interface StagingResult {
  ok: true
  /** la cartella del PLUGIN (per git-subdir è la sotto-cartella, non il repo) */
  dir: string
  /** la RADICE dello staging (repo clonato o cartella temporanea): da cancellare SEMPRE */
  root: string
  /** commit effettivo (git rev-parse HEAD) */
  sha: string
  /** i primi 12 caratteri dello sha (path di installazione e card) */
  sha12: string
}
export type StagingOutcome = StagingResult | { ok: false; error: string }

/**
 * Scarica il plugin in una cartella di STAGING (prima della card): clone
 * sicuro + checkout dello sha se c'è + sparse-checkout per git-subdir +
 * copia dalla cartella relativa per le sorgenti relative + tetti + symlink.
 * Non esegue NIENTE del plugin: git con hook disattivati, solo download.
 *
 * L3: per git-subdir il plugin vive in `source.path` — la cartella restituita
 * è QUELLA (prima si ispezionava la radice del repo e 102 dei 315 plugin
 * ufficiali risultavano vuoti). L7: un solo try/finally cancella lo staging
 * su OGNI esito non ok.
 */
export async function stagePlugin(
  source: PluginSource,
  marketplaceDir: string | null,
  deps: GitCloneDeps = {}
): Promise<StagingOutcome> {
  const run = deps.run ?? defaultRun
  const mkd = deps.mkdtemp ?? ((prefix: string) => mkdtempSync(join(tmpdir(), prefix)))
  const staging = mkd('sandbot-plugin-')
  let done = false
  try {
    if (source.kind === 'relative') {
      const err = relativeSourceError(source.path)
      if (err) return { ok: false, error: err }
      if (!marketplaceDir) return { ok: false, error: 'relative source without the marketplace clone' }
      const from = resolve(marketplaceDir, source.path)
      const rel = relative(marketplaceDir, from)
      if (rel.startsWith('..') || isAbsolute(rel)) return { ok: false, error: `the relative source leaves the marketplace: ${source.path}` }
      if (!existsSync(from)) return { ok: false, error: `plugin folder missing in the marketplace: ${source.path}` }
      cpSync(from, staging, { recursive: true })
      const shaR = await run(['rev-parse', 'HEAD'], { cwd: marketplaceDir })
      const out = finishStaging(staging, staging, shaR.code === 0 ? shaR.stdout.trim() : '')
      done = out.ok
      return out
    }
    const url = source.kind === 'github'
      ? githubRepoUrl(source.repo)
      : source.kind === 'url' || source.kind === 'git-subdir'
        ? source.url
        : null
    if (url === null) return { ok: false, error: `source ${source.kind} not downloadable` }
    const urlCheck = checkGitUrl(url, deps)
    if (!urlCheck.ok) return { ok: false, error: urlCheck.error }
    const clone = await run(gitCloneArgv(url, staging, source.kind === 'git-subdir', deps), { timeoutMs: PLUGIN_TIMEOUT_MS })
    if (clone.code !== 0) return { ok: false, error: `clone failed: ${clone.stderr.trim().slice(0, 200)}` }
    if (source.kind === 'url' || source.kind === 'github' || source.kind === 'git-subdir') {
      if (source.sha) {
        if (!VALID_SHA_RE.test(source.sha)) return { ok: false, error: `invalid sha: ${source.sha}` }
        const co = await run(['checkout', source.sha], { cwd: staging })
        if (co.code !== 0) return { ok: false, error: `checkout of sha ${source.sha} failed` }
      } else if (source.ref) {
        const fe = await run(['fetch', '--depth', '1', 'origin', source.ref], { cwd: staging, timeoutMs: PLUGIN_TIMEOUT_MS })
        if (fe.code === 0) await run(['checkout', 'FETCH_HEAD'], { cwd: staging })
      }
    }
    if (source.kind === 'git-subdir') {
      // L3: il path deve essere relativo, interno e senza ..
      if (isAbsolute(source.path) || source.path.split('/').includes('..')) {
        return { ok: false, error: `the git-subdir path is not an internal relative path (${source.path})` }
      }
      const sp = await run(['sparse-checkout', 'set', source.path], { cwd: staging })
      if (sp.code !== 0) return { ok: false, error: `sparse-checkout failed for ${source.path}` }
      // dopo il checkout la cartella del plugin ESISTE, è una directory reale
      // (non un symlink) e resta dentro lo staging
      const dir = resolve(staging, source.path)
      const rel = relative(staging, dir)
      let stat: { isDirectory(): boolean; isSymbolicLink(): boolean } | null = null
      try { stat = lstatSync(dir) } catch { stat = null }
      if (rel.startsWith('..') || isAbsolute(rel) || !stat || !stat.isDirectory() || stat.isSymbolicLink()) {
        return { ok: false, error: `plugin folder missing in the repository: ${source.path}` }
      }
      const shaR = await run(['rev-parse', 'HEAD'], { cwd: staging })
      const out = finishStaging(staging, dir, shaR.code === 0 ? shaR.stdout.trim() : '')
      done = out.ok
      return out
    }
    const shaR = await run(['rev-parse', 'HEAD'], { cwd: staging })
    const out = finishStaging(staging, staging, shaR.code === 0 ? shaR.stdout.trim() : '')
    done = out.ok
    return out
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    // L7: staging cancellato su ogni esito non ok, compreso il primo return
    // che throwa — lo staging intero (radice), comunque
    if (!done) rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Tetti + symlink che escono + sha12: la coda comune di stagePlugin. I tetti e
 * i symlink si contano sulla CARTELLA DEL PLUGIN (L3); la pulizia la fa il
 * finally di stagePlugin.
 */
function finishStaging(root: string, dir: string, sha: string): StagingOutcome {
  const stats = dirStats(dir)
  if (stats.files > PLUGIN_MAX_FILES) return { ok: false, error: `too many files (${stats.files} > ${PLUGIN_MAX_FILES})` }
  if (stats.bytes > PLUGIN_MAX_BYTES) return { ok: false, error: `plugin too large (${stats.bytes} bytes > ${PLUGIN_MAX_BYTES})` }
  const esc = findEscapingSymlink(dir)
  if (esc) return { ok: false, error: `symlink leaving the plugin folder: ${esc}` }
  if (!VALID_SHA_RE.test(sha)) return { ok: false, error: 'commit not readable (git rev-parse HEAD)' }
  return { ok: true, dir, root, sha, sha12: sha.slice(0, 12) }
}

// ---- inspectPlugin(dir): COSA contiene davvero il plugin (puro sul fs) ----

/** Un server MCP dichiarato dal plugin (placeholder NON sostituiti). */
export interface PluginMcpServer {
  name: string
  /** url http(s) remoto, oppure il comando stdio */
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  /** da dove è arrivato (manifest inline | .mcp.json | file del manifest) */
  from: string
}

export interface PluginSkillInfo {
  /** nome con cui entra nel prompt: <plugin>--<skill> (già validato/troncato) */
  name: string
  description: string
  /** path della cartella della skill, RELATIVO alla radice del plugin */
  dir: string
}

export interface PluginUserConfigField {
  key: string
  description?: string
  type?: string
  sensitive?: boolean
}

export interface PluginInspection {
  /** il name del manifest se presente */
  name: string | null
  skills: PluginSkillInfo[]
  mcpServers: PluginMcpServer[]
  userConfig: PluginUserConfigField[]
  /** componenti presenti che NON si importano (non girano in SandBot) */
  ignored: string[]
  /** bundle .mcpb/.dxt presenti, ignorati (elencati) */
  bundles: string[]
  errors: string[]
}

/**
 * Nome della skill del plugin nel prompt: <plugin>--<skill>, forma valida per
 * isValidSkillName, troncato a 64 (puro).
 */
export function pluginSkillName(plugin: string, skill: string): string {
  const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (`${clean(plugin)}--${clean(skill)}`.replace(/^-+/, '') || 'plugin-skill').slice(0, 64).replace(/-+$/, '')
}

/** Le cartelle/sezioni del plugin che SandBot NON importa mai (elenco per la card). */
export const IGNORED_DIRS = ['commands', 'agents', 'hooks', 'bin', 'monitors', 'outputStyles', 'themes', 'workflows'] as const
export const IGNORED_LABELS: Record<(typeof IGNORED_DIRS)[number], string> = {
  commands: 'commands', agents: 'agents', hooks: 'hooks', bin: 'bin/',
  monitors: 'monitors', outputStyles: 'outputStyles', themes: 'themes', workflows: 'workflows'
}

/**
 * inspectPlugin(dir) (puro sul filesystem, testato su cartelle di fixture):
 * skill valide (skills/<n>/SKILL.md + path dichiarati nel manifest, sempre
 * DENTRO la cartella), server MCP da .mcp.json e manifest (inline o file),
 * userConfig con sensitive, le componenti IGNORATE e gli errori (path che
 * escono, .., file mancanti).
 */
export function inspectPlugin(dir: string, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): PluginInspection {
  const out: PluginInspection = { name: null, skills: [], mcpServers: [], userConfig: [], ignored: [], bundles: [], errors: [] }
  const inside = (p: string): boolean => {
    const rel = relative(dir, p)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }
  const manifestPath = join(dir, '.claude-plugin', 'plugin.json')
  let manifest: Record<string, unknown> | null = null
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFile(manifestPath)) as Record<string, unknown>
    } catch {
      out.errors.push('manifest .claude-plugin/plugin.json is not valid JSON')
    }
  }
  if (manifest) {
    if (typeof manifest.name === 'string' && manifest.name) out.name = manifest.name
    else out.errors.push('manifest without name (required when present)')
  }
  // skill: directory skills/<nome>/SKILL.md con frontmatter valido
  const skillsDir = join(dir, 'skills')
  if (existsSync(skillsDir)) {
    for (const ent of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const body = join(skillsDir, ent.name, 'SKILL.md')
      if (!existsSync(body)) {
        out.errors.push(`skills/${ent.name}/SKILL.md missing`)
        continue
      }
      const rec = parseSkillFrontmatter(readFile(body))
      if (!rec) {
        out.errors.push(`skills/${ent.name}/SKILL.md without valid frontmatter`)
        continue
      }
      out.skills.push({ name: pluginSkillName(out.name ?? ent.name, rec.name), description: rec.description, dir: `skills/${ent.name}` })
    }
  }
  // skill dichiarate nel manifest (path aggiuntivi, sempre dentro la cartella)
  if (manifest && Array.isArray(manifest.skills)) {
    for (const s of manifest.skills) {
      if (typeof s !== 'string') continue
      const p = resolve(dir, s)
      if (!inside(p)) {
        out.errors.push(`manifest skill path outside the folder: ${s}`)
        continue
      }
      const body = join(p, 'SKILL.md')
      if (!existsSync(body)) {
        out.errors.push(`manifest skill missing: ${s}`)
        continue
      }
      const rec = parseSkillFrontmatter(readFile(body))
      if (!rec) {
        out.errors.push(`manifest skill without valid frontmatter: ${s}`)
        continue
      }
      out.skills.push({ name: pluginSkillName(out.name ?? 'plugin', rec.name), description: rec.description, dir: s })
    }
  }
  // server MCP: .mcp.json + manifest (inline o path di un file .json)
  const mcpJsonPath = join(dir, '.mcp.json')
  if (existsSync(mcpJsonPath)) {
    try {
      collectMcpServers(JSON.parse(readFile(mcpJsonPath)), '.mcp.json', out)
    } catch {
      out.errors.push('.mcp.json is not valid JSON')
    }
  }
  if (manifest && manifest.mcpServers !== undefined) {
    if (typeof manifest.mcpServers === 'string') {
      const p = resolve(dir, manifest.mcpServers)
      if (!inside(p)) out.errors.push(`manifest mcpServers file outside the folder: ${manifest.mcpServers}`)
      else if (!existsSync(p)) out.errors.push(`manifest mcpServers file missing: ${manifest.mcpServers}`)
      else {
        try {
          collectMcpServers(JSON.parse(readFile(p)), manifest.mcpServers, out)
        } catch {
          out.errors.push(`manifest mcpServers file is not valid JSON: ${manifest.mcpServers}`)
        }
      }
    } else if (manifest.mcpServers && typeof manifest.mcpServers === 'object') {
      collectMcpServers({ mcpServers: manifest.mcpServers }, 'manifest', out)
    }
  }
  // bundle .mcpb/.dxt: elencati e ignorati
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isFile() && (ent.name.endsWith('.mcpb') || ent.name.endsWith('.dxt'))) out.bundles.push(ent.name)
  }
  // componenti ignorate (presenti ma mai importate) + lspServers del manifest
  for (const name of IGNORED_DIRS) {
    if (existsSync(join(dir, name))) out.ignored.push(IGNORED_LABELS[name])
  }
  if (manifest && manifest.lspServers && typeof manifest.lspServers === 'object') out.ignored.push('lspServers')
  // userConfig del manifest (con sensitive: le chiavi si compilano nelle Impostazioni)
  if (manifest && manifest.userConfig && typeof manifest.userConfig === 'object') {
    for (const [key, v] of Object.entries(manifest.userConfig as Record<string, unknown>)) {
      const f = (v ?? {}) as { description?: unknown; type?: unknown; sensitive?: unknown }
      out.userConfig.push({
        key,
        ...(typeof f.description === 'string' && f.description ? { description: f.description } : {}),
        ...(typeof f.type === 'string' && f.type ? { type: f.type } : {}),
        ...(f.sensitive === true ? { sensitive: true } : {})
      })
    }
  }
  return out
}

/** Frontmatter name/description di un SKILL.md (la validazione SandBot la fa pluginSkillName). */
function parseSkillFrontmatter(text: string): { name: string; description: string } | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return null
  const fields = new Map<string, string>()
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  const name = fields.get('name') ?? ''
  if (!name) return null
  return { name, description: fields.get('description') ?? '' }
}

/**
 * La mappa dei server di un file .mcp.json (o del manifest), DUE FORME (M1):
 * `{"mcpServers": {...}}` (context7, discord, …) OPPURE la mappa PIATTA
 * nome→server alla radice (linear, github, playwright, …: 9 dei 14 plugin
 * ufficiali) — Claude Code accetta entrambe. Vuota `{}` = 0 server senza
 * errore; una radice che non è nessuna delle due = errore di ispezione.
 */
function collectMcpServers(root: unknown, from: string, out: PluginInspection): void {
  let servers: Record<string, unknown> | null = null
  const r = root as Record<string, unknown> | null
  if (r && typeof r === 'object' && r.mcpServers !== undefined) {
    if (r.mcpServers && typeof r.mcpServers === 'object') servers = r.mcpServers as Record<string, unknown>
  } else if (r && typeof r === 'object') {
    // mappa piatta: OGNI valore è un oggetto con url, command o type
    const entries = Object.values(r)
    const flat = entries.every((v) => v && typeof v === 'object' && !Array.isArray(v)
      && ('url' in (v as object) || 'command' in (v as object) || 'type' in (v as object)))
    if (flat) servers = r
  }
  if (servers === null) {
    if (!r || typeof r !== 'object' || Object.keys(r).length) {
      out.errors.push(`${from} without recognizable servers`)
    }
    return
  }
  for (const [name, def] of Object.entries(servers)) {
    if (!def || typeof def !== 'object') continue
    const d = def as Record<string, unknown>
    const headers = d.headers && typeof d.headers === 'object' ? { headers: d.headers as Record<string, string> } : {}
    if (typeof d.url === 'string' && d.url) {
      out.mcpServers.push({ name, url: d.url, from, ...headers })
    } else if (typeof d.command === 'string' && d.command) {
      out.mcpServers.push({
        name, command: d.command,
        ...(Array.isArray(d.args) ? { args: d.args.map(String) } : {}),
        ...(d.env && typeof d.env === 'object' ? { env: d.env as Record<string, string> } : {}),
        from
      })
    } else {
      out.errors.push(`MCP server "${name}" (${from}) without url or command`)
    }
  }
}

// ---- sostituzioni dei placeholder (pure) ----

/** La forma dei placeholder sostituibili: ${user_config.KEY}, ${VAR}, ${VAR:-default}. */
const PLACEHOLDER_RE = /\$\{([A-Za-z0-9_.-]+)(?::-([^}]*))?\}/g

/**
 * Sostituisce `${user_config.KEY}`, `${VAR}` e `${VAR:-default}` in una STRINGA
 * (pura): il chiamante la usa SOLO su env, headers e url, al momento della
 * CONNESSIONE, coi valori presi dallo store cifrato. Una chiave senza valore
 * resta com'è (la connessione la rifiuta prima di partire); `${VAR:-default}`
 * senza valore diventa il default. MAI dall'ambiente del daemon
 * (process.env): l'ambiente del Mac dell'utente non deve finire in un server
 * di terzi.
 */
export function substituteUserConfig(value: string, values: Record<string, string>): string {
  return value.replace(PLACEHOLDER_RE, (whole, key: string, def: string | undefined) => {
    if (key === 'CLAUDE_PLUGIN_ROOT') return whole // sostituito a parte col path nel box
    const k = key.startsWith('user_config.') ? key.slice('user_config.'.length) : key
    return Object.hasOwn(values, k) ? values[k]! : def !== undefined ? def : whole
  })
}

/** Sostituisce `${CLAUDE_PLUGIN_ROOT}` col path del plugin NEL BOX (puro). */
export function substitutePluginRoot(value: string, boxPath: string): string {
  return value.split('${CLAUDE_PLUGIN_ROOT}').join(boxPath)
}

/**
 * Le chiavi che l'utente DOVE compilare perché il server parta (pura):
 * `${user_config.KEY}` e `${VAR}` SENZA default in url, env e headers. Le
 * `${VAR:-default}` non sono obbligatorie (c'è il default di riserva).
 */
export function userConfigKeysOf(server: PluginMcpServer): string[] {
  const keys = new Set<string>()
  const scan = (s: string): void => {
    for (const m of s.matchAll(PLACEHOLDER_RE)) {
      if (m[2] !== undefined) continue // ${VAR:-default}: non obbligatoria
      const key = (m[1] ?? '').replace(/^user_config\./, '')
      if (key && key !== 'CLAUDE_PLUGIN_ROOT') keys.add(key)
    }
  }
  if (server.url) scan(server.url)
  for (const v of Object.values(server.env ?? {})) scan(v)
  for (const v of Object.values(server.headers ?? {})) scan(v)
  return [...keys]
}

/**
 * M3: i placeholder (${VAR}, ${VAR:-x}, ${user_config.*}) in `command` o
 * `args` finirebbero in ARGV del processo nel box: la regola dei segreti lo
 * vieta, quindi il server non si registra. Restituisce i NOMI delle variabili
 * (per la card e il messaggio), vuoto se command/args sono puliti (puro).
 */
export function argvPlaceholdersOf(server: PluginMcpServer): string[] {
  const names = new Set<string>()
  const scan = (s: string): void => {
    for (const m of s.matchAll(/\$\{([^}]+)\}/g)) {
      const whole = m[1] ?? ''
      if (whole === 'CLAUDE_PLUGIN_ROOT') continue // sostituito col path del box
      const key = whole.split(':-')[0]!.replace(/^user_config\./, '')
      if (key) names.add(key)
    }
  }
  scan(server.command ?? '')
  for (const a of server.args ?? []) scan(a)
  return [...names]
}
