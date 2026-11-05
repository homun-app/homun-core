// Fase skill · Sfoglia (B2): il catalogo dei PACCHETTI DI SOLE SKILL dei
// marketplace registrati. Come il Browse di Rakazo NON è un registro di skill
// sciolte: sono i plugin dei marketplace che Homun usa già, e ciò che non si
// sa classificare si SCARTA (sorgenti esterne, connettori, path che escono).
// Repo git LOCALE file:// (solo col flag di test); temporanei con mkdtemp
// nella cartella indicata dai vincoli della fase, mai $TMPDIR.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifySkillPack, searchSkillPacks, createSkillBrowser, SKILL_BROWSE_CACHE_MS, spawnGitRun,
  type SkillPackEntry
} from '../skill-browse'
import { createMarketplaceManager, MARKETPLACES_SETTING } from '../../connectors/marketplace-manager'
import { setDataDir, setSetting } from '../../store/db'

// Vincoli della fase: temporanei SOLO con mkdtemp qui, mai $TMPDIR
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/'
const TMP = mkdtempSync(TMP_BASE + 'sandbot-skill-browse-test-')
let REPO: string
let REPO_NASCOSTO: string

const skillMd = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\nIstruzioni della skill ${name}.`

beforeAll(() => {
  setDataDir(TMP)
  // il marketplace finto: repo git locale con .claude-plugin/marketplace.json e
  // i CINQUE plugin della sonda — (a) solo skill, (b) skill + .mcp.json,
  // (c) sorgente esterna, (d) skill + commands/, (e) path che esce
  REPO = mkdtempSync(TMP_BASE + 'sandbot-browse-mp-')
  const mk = (p: string): string => { mkdirSync(join(REPO, p), { recursive: true }); return join(REPO, p) }
  writeFileSync(join(mk('.claude-plugin'), 'marketplace.json'), JSON.stringify({
    name: 'mp-di-test',
    owner: 'tester',
    plugins: [
      { name: 'solo-skill', description: 'Due skill utili', source: './plugins/solo-skill' },
      { name: 'con-connettore', description: 'Skill più server', source: './plugins/con-connettore' },
      { name: 'esterno', description: 'Vive su GitHub', source: { source: 'github', repo: 'owner/esterno' } },
      { name: 'con-commands', description: 'Con comandi', source: './plugins/con-commands' },
      { name: 'fuori', description: 'Path che esce', source: './plugins/fuori' }
    ]
  }))
  // (a) solo skill, 2 skill, col manifest che dà displayName/category/keywords/homepage
  writeFileSync(join(mk('plugins/solo-skill/.claude-plugin'), 'plugin.json'), JSON.stringify({
    name: 'solo-skill', displayName: 'Solo Skill Carino', category: 'writing',
    keywords: ['due', 'parole'], homepage: 'https://example.com/solo'
  }))
  writeFileSync(join(mk('plugins/solo-skill/skills/uno'), 'SKILL.md'), skillMd('uno', 'la prima'))
  writeFileSync(join(mk('plugins/solo-skill/skills/due'), 'SKILL.md'), skillMd('due', 'la seconda'))
  // (b) skill + .mcp.json → CONNETTORE, non è un pacchetto di sole skill
  writeFileSync(join(mk('plugins/con-connettore/skills/tre'), 'SKILL.md'), skillMd('tre', 'la terza'))
  writeFileSync(join(mk('plugins/con-connettore'), '.mcp.json'), JSON.stringify({ mcpServers: { x: { url: 'https://x.example' } } }))
  // (d) solo skill + commands/ (parte «non usata»: NON esclude)
  writeFileSync(join(mk('plugins/con-commands/skills/quattro'), 'SKILL.md'), skillMd('quattro', 'la quarta'))
  writeFileSync(join(mk('plugins/con-commands/commands'), 'pippo.md'), '# comando pippo')
  // (e) manifest che dichiara una skill FUORI dalla cartella → escluso
  writeFileSync(join(mk('plugins/fuori/.claude-plugin'), 'plugin.json'), JSON.stringify({ name: 'fuori', skills: ['../altrove/SKILL.md'] }))
  writeFileSync(join(mk('plugins/fuori/skills/cinque'), 'SKILL.md'), skillMd('cinque', 'la quinta'))
  writeFileSync(join(mk('altrove'), 'SKILL.md'), skillMd('altrove', 'il bersaglio del path che esce'))
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: REPO })
})
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
  rmSync(REPO, { recursive: true, force: true })
  for (const d of EXTRA_DIRS) rmSync(d, { recursive: true, force: true })
  try { if (REPO_NASCOSTO) rmSync(REPO_NASCOSTO, { recursive: true, force: true }) } catch { /* già via */ }
})

/** Il browser sui deps iniettati: manager vero (repo locale), dir dati TMP. */
const EXTRA_DIRS: string[] = []
/** Una dir dati VERGINE per la prova (la cache dell'albero su disco è condivisa). */
const freshDataDir = (): string => {
  const d = mkdtempSync(TMP_BASE + 'sandbot-browse-fresh-')
  EXTRA_DIRS.push(d)
  return d
}
const mkBrowser = (extra: Record<string, unknown> = {}) => {
  // come la sonda: il marketplace locale registrato DIRETTAMENTE nel setting e
  // quello UFFICIALE tolto — niente rete fuori da 127.0.0.1, mai
  setSetting(MARKETPLACES_SETTING, [{ name: 'mp-di-test', source: `file://${REPO}`, kind: 'git', official: false, addedAt: 1 }])
  const manager = createMarketplaceManager({ allowFileUrlsForTests: true, dataDir: () => TMP })
  return createSkillBrowser({
    marketplaces: manager,
    dataDir: () => TMP,
    installedPlugins: () => [],
    allowFileUrlsForTests: true,
    ...extra
  })
}

describe('B2.4: classifySkillPack (pura) — quando un plugin è «di sole skill»', () => {
  it('due skill in skills/<n>/SKILL.md → conta 2, nomi ordinati, niente parti non usate', () => {
    expect(classifySkillPack(['skills/uno/SKILL.md', 'skills/due/SKILL.md', 'README.md'], null, null))
      .toEqual({ skillCount: 2, skillNames: ['due', 'uno'], ignored: [] })
  })

  it('le parti che Homun ignora (commands/, agents/, hooks/…) NON escludono: finiscono in ignored', () => {
    const r = classifySkillPack(['skills/quattro/SKILL.md', 'commands/pippo.md', 'hooks/setup.js', 'bin/strumento'], null, null)
    expect(r).toEqual({ skillCount: 1, skillNames: ['quattro'], ignored: ['commands', 'hooks', 'bin/'] })
  })

  it('il manifest può dichiarare path skill aggiuntivi (sempre DENTRO la cartella)', () => {
    const manifest = JSON.stringify({ name: 'x', skills: ['altre/abc'] })
    expect(classifySkillPack(['skills/uno/SKILL.md', 'altre/abc/SKILL.md'], manifest, null))
      .toEqual({ skillCount: 2, skillNames: ['abc', 'uno'], ignored: [] })
  })

  it('un path del manifest che ESCE dalla cartella → null (escluso, come inspectPlugin)', () => {
    const manifest = JSON.stringify({ name: 'x', skills: ['../altrove'] })
    expect(classifySkillPack(['skills/uno/SKILL.md', 'qualcosa.txt'], manifest, null)).toBeNull()
  })

  it('un path dell\'elenco che esce (.. o assoluto) → null', () => {
    expect(classifySkillPack(['skills/uno/SKILL.md', '../fuori/SKILL.md'], null, null)).toBeNull()
    expect(classifySkillPack(['/etc/passwd'], null, null)).toBeNull()
  })

  it('.mcp.json presente → null (connettore: si aggiunge da Collega app)', () => {
    expect(classifySkillPack(['skills/uno/SKILL.md', '.mcp.json'], null, JSON.stringify({ mcpServers: {} }))).toBeNull()
  })

  it('mcpServers nel manifest (inline o file) → null', () => {
    expect(classifySkillPack(['skills/uno/SKILL.md'], JSON.stringify({ mcpServers: { x: { url: 'https://x' } } }), null)).toBeNull()
    expect(classifySkillPack(['skills/uno/SKILL.md', 'servers.json'], JSON.stringify({ mcpServers: 'servers.json' }), null)).toBeNull()
  })

  it('nessuna skill → null; manifest o .mcp.json non leggibili (JSON rotto) → null', () => {
    expect(classifySkillPack(['README.md'], null, null)).toBeNull()
    expect(classifySkillPack(['skills/uno/SKILL.md'], '{non json', null)).toBeNull()
    expect(classifySkillPack(['skills/uno/SKILL.md', '.mcp.json'], null, '{rotto')).toBeNull()
  })
})

describe('B2: il catalogo Sfoglia dal marketplace git locale', () => {
  it('mostra SOLO i pacchetti di sole skill (a) e (d); (b), (c), (e) restano fuori col motivo', async () => {
    const b = mkBrowser()
    const out = await b.browse('')
    expect(out.unavailable).toEqual([])
    expect(out.entries.map((e) => e.name).sort()).toEqual(['con-commands', 'solo-skill'])
    const solo = out.entries.find((e) => e.name === 'solo-skill')!
    expect(solo.skillCount).toBe(2)
    expect(solo.skillNames).toEqual(['due', 'uno'])
    expect(solo.displayName).toBe('Solo Skill Carino') // dal manifest
    expect(solo.category).toBe('writing')
    expect(solo.keywords).toEqual(['due', 'parole'])
    expect(solo.homepage).toBe('https://example.com/solo')
    expect(solo.official).toBe(false)
    expect(solo.installed).toBe(false)
    // l'id è quello che usa buildPluginCard: plugin:<nome>@<marketplace>
    expect(solo.id).toBe('plugin:solo-skill@mp-di-test')
    const conCommands = out.entries.find((e) => e.name === 'con-commands')!
    expect(conCommands.skillCount).toBe(1)
    expect(conCommands.displayName).toBe('Con Commands') // Title Case quando il manifest non c'è
    // gli scarti con il motivo (per il REPORT): esterna, connettore, path che esce
    expect(out.skipped.some((s) => s.plugin === 'esterno' && /external source/.test(s.reason))).toBe(true)
    expect(out.skipped.some((s) => s.plugin === 'con-connettore' && /connector|MCP/.test(s.reason))).toBe(true)
    expect(out.skipped.some((s) => s.plugin === 'fuori' && /esc|outside|leaves/i.test(s.reason))).toBe(true)
  })

  it('il clone parziale vive in <dataDir>/cache/marketplaces/ (non in $TMPDIR), riusato entro il TTL', async () => {
    const b = mkBrowser()
    await b.browse('')
    const cacheRoot = join(TMP, 'cache', 'marketplaces')
    // una cartella per il catalogo e una per l'albero dei file (-tree), niente temporanee
    const dirs = readdirSync(cacheRoot).filter((d) => !d.endsWith('.at'))
    expect(dirs.some((d) => d.endsWith('-tree'))).toBe(true)
    expect(readdirSync(cacheRoot).filter((d) => d.startsWith('.clone-') || d.startsWith('.tree-clone-'))).toEqual([])
    // il sentinella DENTRO il clone dell'albero: un re-clone lo cancellerebbe
    const treeDir = join(cacheRoot, dirs.find((d) => d.endsWith('-tree'))!)
    writeFileSync(join(treeDir, 'sentinella'), 'resta')
    await b.browse('') // entro il TTL di 10 minuti: NESSUN nuovo clone
    expect(join(treeDir, 'sentinella')).toBeDefined()
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(join(treeDir, 'sentinella'), 'utf8')).toBe('resta')
  })

  it('cache di 10 minuti: entro il TTL nessuna nuova classificazione; scaduta si riclassifica; l\'albero si ri-clona dopo 1 ora', async () => {
    let clones = 0
    let lstrees = 0
    const runGit = (args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> => {
      if (args.includes('clone')) clones++
      if (args.includes('ls-tree')) lstrees++
      return spawnGitRun(args, opts)
    }
    const now = { v: 1_000_000 }
    const dirTtl = freshDataDir()
    const b = mkBrowser({ runGit, now: () => now.v, dataDir: () => dirTtl })
    await b.browse('')
    expect(clones).toBe(1)
    expect(lstrees).toBe(1)
    // entro i 10 minuti: NESSUN nuovo lavoro
    now.v += SKILL_BROWSE_CACHE_MS - 1_000
    await b.browse('')
    expect(lstrees).toBe(1)
    expect(clones).toBe(1)
    // catalogo scaduto (10 min): si riclassifica, ma l'ALBERO è ancora fresco (1 h)
    now.v += SKILL_BROWSE_CACHE_MS + 1_000
    await b.browse('')
    expect(lstrees).toBe(2)
    expect(clones).toBe(1)
    // scade anche l'albero (1 h): re-clone in cartella nuova
    now.v += 60 * 60_000 + 1_000
    await b.browse('')
    expect(clones).toBe(2)
  })

  it('due richieste CONTEMPORANEE condividono lo stesso lavoro (un solo clone)', async () => {
    let clones = 0
    const runGit = (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => {
      if (args.includes('clone')) clones++
      return spawnGitRun(args, opts)
    }
    // dir dati PROPRIA (calcolata UNA volta): la cache dell'albero SU DISCO
    // delle prove precedenti è ancora fresca e non farebbe clonare proprio nulla
    const dirConc = freshDataDir()
    const b = mkBrowser({ runGit, dataDir: () => dirConc })
    const [r1, r2] = await Promise.all([b.browse(''), b.browse('')])
    expect(r1.entries).toHaveLength(2)
    expect(r2.entries).toHaveLength(2)
    expect(clones).toBe(1)
  })

  it('gli errori NON vanno mai in cache: marketplace illeggibile → unavailable, ripristinato → di nuovo a posto', async () => {
    const b = mkBrowser()
    expect((await b.browse('')).entries).toHaveLength(2)
    // il repo diventa illeggibile (la sonda lo fa rinominando la cartella)
    REPO_NASCOSTO = REPO + '-nascosto'
    renameSync(REPO, REPO_NASCOSTO)
    const ko = await b.browse('', { retry: true })
    expect(ko.entries).toEqual([])
    expect(ko.unavailable).toEqual([{ source: `file://${REPO}` }])
    // ripristinato: la riprova FUNZIONA (l'errore non era rimasto in cache)
    renameSync(REPO_NASCOSTO, REPO)
    const ok = await b.browse('', { retry: true })
    expect(ok.entries).toHaveLength(2)
    expect(ok.unavailable).toEqual([])
  })

  it('installed: vero per il pacchetto già installato (nome + marketplace)', async () => {
    const b = mkBrowser({ installedPlugins: () => [{ name: 'solo-skill', marketplace: 'mp-di-test' }] })
    const out = await b.browse('')
    expect(out.entries.find((e) => e.name === 'solo-skill')!.installed).toBe(true)
    expect(out.entries.find((e) => e.name === 'con-commands')!.installed).toBe(false)
  })
})

describe('B2.6: la ricerca (pura): maiuscole e accenti non contano, gli ufficiali prima', () => {
  const entry = (over: Partial<SkillPackEntry>): SkillPackEntry => ({
    id: 'x', name: 'demo', displayName: 'Demo', description: '', category: '', keywords: [], homepage: '',
    marketplace: 'mp', official: false, skillCount: 1, skillNames: ['a'], installed: false, ...over
  })
  const entries = [
    entry({ name: 'zaino', displayName: 'Zaino', official: false }),
    entry({ name: 'albero', displayName: 'Albero', official: true, description: 'cresce piano' }),
    entry({ name: 'bussola', displayName: 'Bùssola', official: false, keywords: ['perchè'] }),
    entry({ name: 'cargo', displayName: 'Càrgo', official: true, category: 'spedizioni' })
  ]

  it('la query batte nome, displayName, descrizione, keywords e categoria, senza maiuscole né accenti', () => {
    expect(searchSkillPacks(entries, 'ALBERO')).toHaveLength(1)
    expect(searchSkillPacks(entries, 'bussòla')).toHaveLength(1)   // accento sulla query
    expect(searchSkillPacks(entries, 'perche')).toHaveLength(1)    // accento sul dato
    expect(searchSkillPacks(entries, 'cresce')).toHaveLength(1)    // descrizione
    expect(searchSkillPacks(entries, 'SPEDIZIONI')).toHaveLength(1) // categoria
    expect(searchSkillPacks(entries, '').map((e) => e.name)).toEqual(['albero', 'cargo', 'bussola', 'zaino'])
  })

  it('gli ufficiali prima, poi per nome', () => {
    const sorted = searchSkillPacks(entries, '')
    expect(sorted.map((e) => e.official)).toEqual([true, true, false, false])
    expect(sorted.map((e) => e.name)).toEqual(['albero', 'cargo', 'bussola', 'zaino'])
  })
})
