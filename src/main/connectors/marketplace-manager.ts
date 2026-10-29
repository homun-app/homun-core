// Manager dei marketplace registrati (fase 13, punto 4): l'utente aggiunge
// `owner/repo` GitHub o un URL git dalle Impostazioni (il BOT non può); il
// predefinito è anthropics/claude-plugins-official, che l'utente può
// rimuovere. Il catalogo si scarica leggendo SOLO .claude-plugin/marketplace.json
// (HTTP GET su raw.githubusercontent per github; clonazione sparsa del solo
// .claude-plugin/ per gli URL git), con cache di 1 ora. La validazione è
// parseMarketplace (pura): le voci non valide si scartano una per una e la
// ragione si registra.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { getSetting, setSetting } from '../store/db'
import { webFetchCached, type WebFetchOutcome } from '../agent/web-tools'
import { parseMarketplace, stagePlugin, type MarketplacePlugin, type ParsedMarketplace } from './marketplace'

/** Impostazione: l'elenco dei marketplace registrati. */
export const MARKETPLACES_SETTING = 'connectors.marketplaces'

export interface RegisteredMarketplace {
  /** nome del marketplace (dal marketplace.json) */
  name: string
  /** sorgente git: owner/repo GitHub oppure URL https */
  source: string
  kind: 'github' | 'git'
  /** il marketplace ufficiale ha l'etichetta sua propria */
  official: boolean
  addedAt: number
}

/** Il marketplace ufficiale: predefinito, rimovibile dall'utente. */
export const OFFICIAL_MARKETPLACE: RegisteredMarketplace = {
  name: 'claude-plugins-official',
  source: 'anthropics/claude-plugins-official',
  kind: 'github',
  official: true,
  addedAt: 0
}

export interface MarketplaceCatalog {
  marketplace: RegisteredMarketplace
  parsed: ParsedMarketplace
  /** le voci scartate con la ragione */
  issues: Array<{ plugin: string; reason: string }>
  fetchedAt: number
}

/** Cache dei cataloghi: 1 ora. */
export const MARKETPLACE_CACHE_MS = 60 * 60_000

/** Dipendenze iniettabili (test senza rete né git vero). */
export interface MarketplaceDeps {
  fetchOutcome?: (url: string) => Promise<WebFetchOutcome>
  runGit?: (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>
  mkdtemp?: (prefix: string) => string
  now?: () => number
  /** test: URL file:// ammessi per il clone sparsO (in produzione MAI) */
  allowFileUrlsForTests?: boolean
}

/** L'URL raw del marketplace.json di un repo GitHub (puro). */
export function rawMarketplaceUrl(source: string, ref = 'HEAD'): string {
  const clean = source.replace(/^github:/, '').replace(/\.git$/, '')
  return `https://raw.githubusercontent.com/${clean}/${ref}/.claude-plugin/marketplace.json`
}

/** Il flag di test della verifica d'integrazione: marketplace git locali su file:// (in produzione MAI). */
const allowFileUrls = (): boolean => process.env.SANDBOT_TEST_ALLOW_FILE_URLS === '1'

/** Normalizza l'input dell'utente: owner/repo → github, https://… → git (file:// solo col flag di test). */
export function normalizeMarketplaceSource(input: string): { kind: 'github' | 'git'; source: string } | { error: string } {
  const s = input.trim()
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return { kind: 'github', source: s }
  if (/^https:\/\/[\w.-\/]+$/i.test(s) && !s.includes(' ')) return { kind: 'git', source: s }
  if (allowFileUrls() && s.startsWith('file://')) return { kind: 'git', source: s }
  return { error: 'sorgente non valida: usa owner/repo di GitHub oppure un URL git https' }
}

/**
 * Il manager: elenco, aggiunta/rimozione (SOLO dall'utente, via RPC delle
 * Impostazioni), catalogo con cache. Il clone dei marketplace git è sparsO
 * sul solo .claude-plugin/ e vive in una temporanea finché serve lo staging
 * dei plugin a sorgente relativa.
 */
export function createMarketplaceManager(deps: MarketplaceDeps = {}) {
  const now = deps.now ?? Date.now
  const cache = new Map<string, MarketplaceCatalog>()
  /** clone sparsi del marketplace (per marketplace.json e sorgenti relative), per source */
  const clones = new Map<string, string>()

  const list = (): RegisteredMarketplace[] =>
    getSetting<RegisteredMarketplace[]>(MARKETPLACES_SETTING, [OFFICIAL_MARKETPLACE])

  const save = (all: RegisteredMarketplace[]): void => setSetting(MARKETPLACES_SETTING, all)

  /** Aggiunge un marketplace (dalle Impostazioni): normalizza, verifica lo scaricamento, salva. */
  async function add(input: string): Promise<RegisteredMarketplace> {
    const norm = normalizeMarketplaceSource(input)
    if ('error' in norm) throw new Error(norm.error)
    if (list().some((m) => m.source === norm.source)) throw new Error('marketplace già registrato')
    const cat = await fetchCatalog({ name: '', source: norm.source, kind: norm.kind, official: false, addedAt: now() }, true)
    const reg: RegisteredMarketplace = {
      name: cat.parsed.name,
      source: norm.source,
      kind: norm.kind,
      official: false,
      addedAt: now()
    }
    save([...list().filter((m) => m.source !== norm.source), reg])
    cache.delete(norm.source)
    return reg
  }

  function remove(source: string): void {
    save(list().filter((m) => m.source !== source))
    cache.delete(source)
    const clone = clones.get(source)
    if (clone) {
      rmSync(clone, { recursive: true, force: true })
      clones.delete(source)
    }
  }

  /** Il clone sparsi del marketplace (solo .claude-plugin/), riusato per le sorgenti relative. */
  async function ensureClone(m: RegisteredMarketplace): Promise<string | null> {
    if (m.kind === 'github') return null // il marketplace.json arriva da raw.githubusercontent
    const hit = clones.get(m.source)
    if (hit) return hit
    const url = m.source
    if (!url.startsWith('https://') && !deps.allowFileUrlsForTests && !allowFileUrls()) return null
    const dir = (deps.mkdtemp ?? ((p: string) => mkdtempSync(join(tmpdir(), p))))('sandbot-marketplace-')
    const r = await stagePlugin(
      { kind: 'git-subdir', url, path: '.claude-plugin' },
      null,
      { ...deps, allowFileUrlsForTests: deps.allowFileUrlsForTests ?? allowFileUrls(), mkdtemp: () => dir }
    )
    if (!r.ok) {
      rmSync(dir, { recursive: true, force: true })
      return null
    }
    clones.set(m.source, dir)
    return dir
  }

  /** Scarica (o prende dalla cache di 1 ora) il catalogo di un marketplace. */
  async function fetchCatalog(m: RegisteredMarketplace, force = false): Promise<MarketplaceCatalog> {
    const hit = cache.get(m.source)
    if (!force && hit && now() - hit.fetchedAt < MARKETPLACE_CACHE_MS) return hit
    let json: unknown = null
    if (m.kind === 'github') {
      const fetchOutcome = deps.fetchOutcome ?? ((url: string) => webFetchCached(url))
      try {
        const outcome = await fetchOutcome(rawMarketplaceUrl(m.source))
        if (outcome.ok) json = JSON.parse(outcome.text)
      } catch {
        json = null
      }
    } else {
      const clone = await ensureClone(m)
      if (clone) {
        try {
          json = JSON.parse(readFileSync(join(clone, '.claude-plugin', 'marketplace.json'), 'utf8'))
        } catch {
          json = null
        }
      }
    }
    if (json === null) throw new Error(`marketplace.json non leggibile per ${m.source}`)
    const { marketplace, issues } = parseMarketplace(json)
    if (!marketplace) throw new Error(`marketplace non valido (${m.source}): ${issues[0]?.reason ?? 'sconosciuto'}`)
    const cat: MarketplaceCatalog = { marketplace: m, parsed: marketplace, issues, fetchedAt: now() }
    cache.set(m.source, cat)
    return cat
  }

  /** Tutti i cataloghi (per la ricerca e la UI); gli irraggiungibili si saltano con il motivo. */
  async function catalogs(): Promise<{ ok: MarketplaceCatalog[]; failed: Array<{ source: string; error: string }> }> {
    const ok: MarketplaceCatalog[] = []
    const failed: Array<{ source: string; error: string }> = []
    for (const m of list()) {
      try {
        ok.push(await fetchCatalog(m))
      } catch (e) {
        failed.push({ source: m.source, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return { ok, failed }
  }

  /** Cerca un plugin per nome@marketplace (per install_plugin). */
  async function findPlugin(id: string): Promise<{ reg: RegisteredMarketplace; plugin: MarketplacePlugin } | null> {
    // id = plugin:<nome>@<marketplace>
    const rest = id.startsWith('plugin:') ? id.slice('plugin:'.length) : id
    const at = rest.lastIndexOf('@')
    if (at <= 0) return null
    const name = rest.slice(0, at)
    const mpName = rest.slice(at + 1)
    const { ok } = await catalogs()
    for (const cat of ok) {
      if (cat.parsed.name !== mpName && cat.marketplace.source !== mpName) continue
      const plugin = cat.parsed.plugins.find((p) => p.name === name)
      if (plugin) return { reg: cat.marketplace, plugin }
    }
    return null
  }

  /** La dir del clone del marketplace (sorgenti relative), se c'è. */
  const cloneOf = (source: string): string | null => clones.get(source) ?? null

  return { list, add, remove, catalogs, fetchCatalog, findPlugin, cloneOf, rawMarketplaceUrl }
}

export type MarketplaceManager = ReturnType<typeof createMarketplaceManager>

/** runner git di ripiego per i test che iniettano solo runGit nel marketplace */
export function spawnGit(args: string[], opts: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'], ...(opts.cwd ? { cwd: opts.cwd } : {}) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', rej)
    child.on('close', (code) => res({ code: code ?? 1, stdout, stderr }))
  })
}
