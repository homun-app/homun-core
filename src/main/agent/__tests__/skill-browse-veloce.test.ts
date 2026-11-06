// Fase SFOGLIA VELOCE (V1/V2): aprire la finestra non rifà niente — cache su
// disco e aggiornamento in sottofondo (stale-while-revalidate, come
// registryData di Rakazo), letture in parallelo con tetto di 8, .mcp.json
// deciso dalla PRESENZA nell'albero e tetto di 60 s per marketplace.
// Repo git LOCALI file:// (solo col flag di test); temporanei con mkdtemp
// nella cartella indicata dai vincoli della fase, mai $TMPDIR.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSkillBrowser, spawnGitRun, SKILL_BROWSE_CACHE_MS,
  MANIFEST_CONCURRENCY, SKILL_BROWSE_TIME_CAP_MS, skillBrowseCacheFile,
  type RunGit
} from '../skill-browse'
import { createMarketplaceManager, MARKETPLACES_SETTING, MARKETPLACE_CACHE_MS } from '../../connectors/marketplace-manager'
import { setDataDir, setSetting } from '../../store/db'

// Vincoli della fase: temporanei SOLO con mkdtemp qui, mai $TMPDIR
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/'
const TMP = mkdtempSync(TMP_BASE + 'sandbot-sfoglia-veloce-test-')
const EXTRA_DIRS: string[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// git VERO su repo locali: con la suite intera in parallelo i cloni rallentano
vi.setConfig({ testTimeout: 30_000 })
/** Aspetta una condizione (fino a 10 s): i lavori in sottofondo finiscono quando finiscono. */
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await sleep(50)
}

/** Il repo git locale del marketplace: un plugin per voce, ognuno col suo manifest (default) e una skill. */
function buildRepo(defs: Array<{ name: string; mcp?: boolean; manifest?: boolean; skills?: string[] }>, mpName = 'mp-veloce'): { dir: string; url: string } {
  const dir = mkdtempSync(TMP_BASE + 'sandbot-veloce-mp-')
  EXTRA_DIRS.push(dir)
  const mk = (p: string): string => { mkdirSync(join(dir, p), { recursive: true }); return join(dir, p) }
  writeFileSync(join(mk('.claude-plugin'), 'marketplace.json'), JSON.stringify({
    name: mpName,
    owner: 'tester',
    plugins: defs.map((d) => ({ name: d.name, description: `Pacchetto ${d.name}`, source: `./plugins/${d.name}` }))
  }))
  for (const d of defs) {
    for (const s of d.skills ?? ['unica']) {
      writeFileSync(join(mk(`plugins/${d.name}/skills/${s}`), 'SKILL.md'),
        `---\nname: ${s}\ndescription: la skill ${s} di ${d.name}\n---\nIstruzioni della skill ${s}.`)
    }
    if (d.manifest !== false) {
      writeFileSync(join(mk(`plugins/${d.name}/.claude-plugin`), 'plugin.json'), JSON.stringify({ name: d.name }))
    }
    if (d.mcp) writeFileSync(join(mk(`plugins/${d.name}`), '.mcp.json'), JSON.stringify({ mcpServers: { x: { url: 'https://x.example' } } }))
  }
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: dir })
  return { dir, url: `file://${dir}` }
}

/** Una dir dati VERGINE per la prova (le cache su disco sono condivise per dir). */
const freshDataDir = (): string => {
  const d = mkdtempSync(TMP_BASE + 'sandbot-veloce-fresh-')
  EXTRA_DIRS.push(d)
  return d
}

/** Il browser sui deps iniettati: manager vero (repo locale) e dir dati PROPRIA. */
function mkBrowserOn(url: string, dataDir: string, extra: Record<string, unknown> = {}) {
  setSetting(MARKETPLACES_SETTING, [{ name: 'mp-veloce', source: url, kind: 'git', official: false, addedAt: 1 }])
  const manager = createMarketplaceManager({ allowFileUrlsForTests: true, dataDir: () => dataDir, ...(extra.managerDeps as Record<string, unknown> ?? {}) })
  const { managerDeps: _m, ...browserExtra } = extra
  return createSkillBrowser({
    marketplaces: manager,
    dataDir: () => dataDir,
    installedPlugins: () => [],
    allowFileUrlsForTests: true,
    ...browserExtra
  })
}

/** Il runGit che registra ogni argv (e delega al git vero). */
function recordingGit(delayShowMs = 0): { runGit: RunGit; args: string[][]; state: { active: number; max: number } } {
  const args: string[][] = []
  const state = { active: 0, max: 0 }
  const runGit: RunGit = async (a, opts) => {
    if (a.includes('show')) {
      state.active++
      state.max = Math.max(state.max, state.active)
      if (delayShowMs) await sleep(delayShowMs)
      state.active--
    }
    args.push(a)
    return spawnGitRun(a, opts)
  }
  return { runGit, args, state }
}

beforeAll(() => { setDataDir(TMP) })
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
  for (const d of EXTRA_DIRS) rmSync(d, { recursive: true, force: true })
})

describe('V1: aprire la finestra non rifà niente — cache su disco e sottofondo', () => {
  it('il catalogo classificato si salva su disco (ora + sha della HEAD di ogni marketplace) e un NUOVO daemon lo rilegge SENZA git', async () => {
    const repo = buildRepo([{ name: 'alpha' }, { name: 'beta', mcp: true }])
    const dir = freshDataDir()
    const b1 = mkBrowserOn(repo.url, dir)
    const out1 = await b1.browse('')
    expect(out1.entries.map((e) => e.name)).toEqual(['alpha'])
    // il file della cache, nel posto della spec: <dataDir>/cache/marketplaces/skill-browse.json
    const cacheFile = skillBrowseCacheFile(dir)
    expect(cacheFile).toBe(join(dir, 'cache', 'marketplaces', 'skill-browse.json'))
    expect(existsSync(cacheFile)).toBe(true)
    const raw = JSON.parse(readFileSync(cacheFile, 'utf8')) as { at: number; heads: Record<string, string> }
    expect(typeof raw.at).toBe('number')
    const sha = execSync('git rev-parse HEAD', { cwd: repo.dir }).toString().trim()
    expect(raw.heads[repo.url]).toBe(sha)
    // un NUOVO daemon (stessa dir dati, com'è un riavvio) rilegge il catalogo
    // SENZA toccare git: nessun clone, nessuna lettura
    const b2 = mkBrowserOn(repo.url, dir, {
      runGit: () => Promise.reject(new Error('nessuna chiamata git dopo la cache su disco'))
    })
    const out2 = await b2.browse('')
    expect(out2.entries.map((e) => e.name)).toEqual(['alpha'])
    expect(out2.skipped.some((s) => s.plugin === 'beta')).toBe(true)
  })

  it('cache scaduta: browse risponde SUBITO col vecchio catalogo e l\'aggiornamento finisce in sottofondo (evento skills:browse-updated)', async () => {
    const repo = buildRepo([{ name: 'alpha' }, { name: 'beta' }])
    const dir = freshDataDir()
    const clock = { v: 1_000_000 }
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    // il cancello vale SOLO per le letture dopo la prima classificazione
    let gated = false
    const runGit: RunGit = async (a, opts) => {
      if (gated && a.includes('show')) await gate
      return spawnGitRun(a, opts)
    }
    const events: Array<{ type: string; done?: number; total?: number }> = []
    const b = mkBrowserOn(repo.url, dir, { runGit, now: () => clock.v, emit: (e: { type: string }) => { events.push(e) } })
    await b.browse('')
    gated = true
    // la cache scade (10 minuti): la risposta arriva SUBITO col vecchio catalogo
    clock.v += SKILL_BROWSE_CACHE_MS + 1_000
    const slowBrowse = b.browse('')
    const first = await Promise.race([slowBrowse.then(() => 'data' as const), sleep(500).then(() => 'timeout' as const)])
    try {
      expect(first).toBe('data')
    } finally {
      release()
    }
    // l'aggiornamento in sottofondo finisce e il daemon lo dice alla finestra
    await until(() => events.some((e) => e.type === 'skills:browse-updated'))
    expect(events.some((e) => e.type === 'skills:browse-updated')).toBe(true)
    const out = await slowBrowse
    expect(out.entries).toHaveLength(2)
  })

  it('«Riprova» (retry) NON rifà il clone se lo sha remoto non è cambiato: ls-remote + fetch sul clone esistente', async () => {
    const repo = buildRepo([{ name: 'alpha' }, { name: 'beta' }])
    const dir = freshDataDir()
    const git = recordingGit()
    const b = mkBrowserOn(repo.url, dir, { runGit: git.runGit })
    await b.browse('')
    const clonesPrima = git.args.filter((a) => a.includes('clone')).length
    expect(clonesPrima).toBe(1)
    const out = await b.browse('', { retry: true })
    expect(out.entries).toHaveLength(2)
    // MAI buttare il clone: nessun nuovo clone, ma la chiamata leggera ls-remote
    // col HEAD remoto e un fetch --depth 1 --filter=blob:none sul clone esistente
    expect(git.args.filter((a) => a.includes('clone'))).toHaveLength(1)
    const lsRemote = git.args.find((a) => a.includes('ls-remote'))
    expect(lsRemote).toBeDefined()
    expect(lsRemote).toContain(repo.url)
    expect(lsRemote).toContain('HEAD')
    const fetch = git.args.find((a) => a.includes('fetch'))
    expect(fetch).toBeDefined()
    expect(fetch).toContain('--filter')
    expect(fetch).toContain('blob:none')
  })

  it('«Riprova» rifà il clone SOLO quando la HEAD remota è cambiata (nuovo commit nel marketplace)', async () => {
    const repo = buildRepo([{ name: 'alpha' }])
    const dir = freshDataDir()
    const clock = { v: 1_000_000 }
    const git = recordingGit()
    const b = mkBrowserOn(repo.url, dir, { runGit: git.runGit, now: () => clock.v, managerDeps: { now: () => clock.v } })
    await b.browse('')
    expect(git.args.filter((a) => a.includes('clone'))).toHaveLength(1)
    // un nuovo plugin nel marketplace: nuovo commit → HEAD cambiata
    mkdirSync(join(repo.dir, 'plugins', 'nuovo-arrivato', 'skills', 's'), { recursive: true })
    writeFileSync(join(repo.dir, 'plugins', 'nuovo-arrivato', 'skills', 's', 'SKILL.md'), '---\nname: s\ndescription: la skill nuova\n---\nIstruzioni.')
    mkdirSync(join(repo.dir, 'plugins', 'nuovo-arrivato', '.claude-plugin'), { recursive: true })
    writeFileSync(join(repo.dir, 'plugins', 'nuovo-arrivato', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'nuovo-arrivato' }))
    writeFileSync(join(repo.dir, 'plugins', 'nuovo-arrivato', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'nuovo-arrivato' }))
    const marketplaceJson = JSON.parse(readFileSync(join(repo.dir, '.claude-plugin', 'marketplace.json'), 'utf8')) as { plugins: Array<{ name: string; source: string }> }
    marketplaceJson.plugins.push({ name: 'nuovo-arrivato', source: './plugins/nuovo-arrivato' })
    writeFileSync(join(repo.dir, '.claude-plugin', 'marketplace.json'), JSON.stringify(marketplaceJson))
    execSync('git add -A && git commit -qm nuovo', { cwd: repo.dir })
    // si scade anche il TTL dei cloni del manager, così il catalogo si rilegge
    clock.v += MARKETPLACE_CACHE_MS + 1_000
    const out = await b.browse('', { retry: true })
    expect(out.entries.map((e) => e.name).sort()).toEqual(['alpha', 'nuovo-arrivato'])
    expect(git.args.filter((a) => a.includes('clone'))).toHaveLength(2)
  })

  it('l\'elenco dei marketplace CAMBIA (Collega app › Marketplace): la cache vale come scaduta — subito la lista dei marketplace di adesso, in sottofondo quella nuova', async () => {
    const repoA = buildRepo([{ name: 'alpha' }], 'mp-a')
    const repoB = buildRepo([{ name: 'bravo' }], 'mp-b')
    const regA = { name: 'mp-a', source: repoA.url, kind: 'git', official: false, addedAt: 1 }
    const regB = { name: 'mp-b', source: repoB.url, kind: 'git', official: false, addedAt: 2 }
    const dir = freshDataDir()
    const events: Array<{ type: string }> = []
    setSetting(MARKETPLACES_SETTING, [regA])
    const manager = createMarketplaceManager({ allowFileUrlsForTests: true, dataDir: () => dir })
    const b = createSkillBrowser({
      marketplaces: manager, dataDir: () => dir, installedPlugins: () => [], allowFileUrlsForTests: true,
      emit: (e) => { events.push(e) }
    })
    expect((await b.browse('')).entries.map((e) => e.name)).toEqual(['alpha'])
    // l'utente AGGIUNGE un marketplace: la finestra non deve aspettare 10 minuti
    setSetting(MARKETPLACES_SETTING, [regA, regB])
    expect((await b.browse('')).entries.map((e) => e.name)).toEqual(['alpha']) // subito: la vecchia
    await until(() => events.some((e) => e.type === 'skills:browse-updated'))
    expect(events.some((e) => e.type === 'skills:browse-updated')).toBe(true)
    expect((await b.browse('')).entries.map((e) => e.name).sort()).toEqual(['alpha', 'bravo'])
    // l'utente TOGLIE un marketplace: i suoi pacchetti spariscono SUBITO
    setSetting(MARKETPLACES_SETTING, [regB])
    expect((await b.browse('')).entries.map((e) => e.name)).toEqual(['bravo'])
  })
})

describe('V1: l\'avanzamento della prima lettura', () => {
  it('la prima volta in assoluto (niente cache) il daemon emette skills:browse-progress: 0 di N, poi fino a done === total', async () => {
    const repo = buildRepo([{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma', mcp: true }])
    const dir = freshDataDir()
    const events: Array<{ type: string; done?: number; total?: number }> = []
    const b = mkBrowserOn(repo.url, dir, { emit: (e: { type: string }) => { events.push(e) } })
    await b.browse('')
    const progress = events.filter((e) => e.type === 'skills:browse-progress') as Array<{ done: number; total: number }>
    expect(progress.length).toBeGreaterThanOrEqual(2)
    expect(progress[0]!.done).toBe(0)
    expect(progress[0]!.total).toBe(3)
    expect(progress.at(-1)!.done).toBe(progress.at(-1)!.total)
    // il conteggio cresce senza mai tornare indietro
    const done = progress.map((p) => p.done)
    expect(done).toEqual([...done].sort((a, b2) => a - b2))
  })
})

describe('V2: le letture in parallelo, poche e limitate', () => {
  it('il tetto esportato: MANIFEST_CONCURRENCY è 8, il tempo massimo è 60 s', () => {
    expect(MANIFEST_CONCURRENCY).toBe(8)
    expect(SKILL_BROWSE_TIME_CAP_MS).toBe(60_000)
  })

  it('i git show dei plugin girano in PARALLELO (almeno 2 insieme) MAI oltre 8', async () => {
    const defs = Array.from({ length: 16 }, (_, i) => ({ name: `p-${String(i).padStart(2, '0')}` }))
    const repo = buildRepo(defs)
    const dir = freshDataDir()
    const git = recordingGit(60)
    const b = mkBrowserOn(repo.url, dir, { runGit: git.runGit })
    const out = await b.browse('')
    expect(out.entries).toHaveLength(16)
    expect(git.state.max).toBeGreaterThanOrEqual(2) // davvero in parallelo (il base è in serie: 1)
    expect(git.state.max).toBeLessThanOrEqual(8)    // mai oltre il tetto
  })

  it('.mcp.json: la PRESENZA nell\'albero basta a classificarlo connettore, SENZA leggerlo; assente → nessuna lettura (né manifest assente)', async () => {
    const repo = buildRepo([
      { name: 'con-mcp', mcp: true },                                  // .mcp.json PRESENTE → connettore senza lettura
      { name: 'senza-tutto', manifest: false },                        // NESSUN manifest: nessuna lettura per lui
      { name: 'normale' }                                              // manifest presente → una sola lettura
    ])
    const dir = freshDataDir()
    const git = recordingGit()
    const b = mkBrowserOn(repo.url, dir, { runGit: git.runGit })
    const out = await b.browse('')
    // il connettore resta fuori col suo motivo, gli altri due dentro
    expect(out.entries.map((e) => e.name).sort()).toEqual(['normale', 'senza-tutto'])
    expect(out.skipped.some((s) => s.plugin === 'con-mcp' && /MCP/.test(s.reason))).toBe(true)
    // NESSUN git show di .mcp.json (la presenza basta) e NESSUNO per un
    // manifest che non c'è: le uniche letture sono i manifest presenti
    const shows = git.args.filter((a) => a.includes('show'))
    expect(shows.length).toBe(1)
    expect(shows[0]!.join(' ')).toContain('plugins/normale/.claude-plugin/plugin.json')
    expect(shows.every((a) => !a.join(' ').includes('.mcp.json'))).toBe(true)
  })

  it('tetto di 60 s: i plugin rimasti indietro finiscono in skipped con «tempo scaduto» e la lista dà quelli pronti', async () => {
    const defs = Array.from({ length: 10 }, (_, i) => ({ name: `l-${String(i).padStart(2, '0')}` }))
    const repo = buildRepo(defs)
    const dir = freshDataDir()
    const clock = { v: 1_000_000 }
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let fermi = 0 // le letture ferme al cancello
    const runGit: RunGit = async (a, opts) => {
      if (a.includes('show')) {
        fermi++
        await gate
      }
      return spawnGitRun(a, opts)
    }
    const b = mkBrowserOn(repo.url, dir, { runGit, now: () => clock.v })
    const building = b.browse('')
    // il pool è partito: 8 letture ferme al cancello, 2 in coda (sotto carico la
    // fase dei cloni può durare: si aspetta il punto VERO, non un tempo fisso)
    await until(() => fermi >= 8)
    clock.v += SKILL_BROWSE_TIME_CAP_MS + 1_000 // il tempo della classificazione scade
    release()
    const out = await building
    expect(out.entries).toHaveLength(8)
    expect(out.skipped).toHaveLength(2)
    // «tempo scaduto»: il motivo è in inglese come gli altri scarti (guardia del testo di main)
    expect(out.skipped.every((s) => /time limit reached/.test(s.reason))).toBe(true)
    expect(out.unavailable).toEqual([])
  })
})
