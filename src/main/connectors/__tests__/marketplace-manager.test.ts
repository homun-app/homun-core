// Test del manager dei marketplace, correzione M6 (fase 13 correzioni 2): il
// clone del catalogo NON vive più in $TMPDIR (una cartella sandbot-marketplace-*
// per daemon, mai pulita) ma in <dataDir>/cache/marketplaces/<hash-della-sorgente>:
// riuso fra riavvii col TTL di 1 h, re-clone in una cartella NUOVA che poi
// sostituisce la vecchia. Repo git LOCALE (file:// solo col flag di test).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMarketplaceManager, MARKETPLACE_CACHE_MS, marketplaceCacheDir, marketplaceCacheName, type RegisteredMarketplace } from '../marketplace-manager'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-mkmgr-test-'))
let REPO: string
const { setDataDir } = await import('../../store/db')

beforeAll(() => {
  setDataDir(TMP)
  // il marketplace finto: repo git locale con .claude-plugin/marketplace.json
  REPO = mkdtempSync(join(tmpdir(), 'sandbot-mp-repo-'))
  mkdirSync(join(REPO, '.claude-plugin'), { recursive: true })
  writeFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'mp-di-test',
    owner: 'tester',
    plugins: [{ name: 'demo', source: './plugins/demo' }]
  }))
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: REPO })
})
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
  rmSync(REPO, { recursive: true, force: true })
})

const SOURCE = () => `file://${REPO}`
const reg = (): RegisteredMarketplace => ({ name: 'mp-di-test', source: SOURCE(), kind: 'git', official: false, addedAt: 1 })

describe('M6: il clone del catalogo vive in <dataDir>/cache/marketplaces (non in $TMPDIR)', () => {
  it('primo fetch: clone in cache/marketplaces/<hash>, catalogo leggibile, niente sandbot-marketplace-* in $TMPDIR', async () => {
    const before = countTmpMarketplaces()
    const m = createMarketplaceManager({ allowFileUrlsForTests: true, dataDir: () => TMP, now: () => 1_000_000 })
    const cat = await m.fetchCatalog(reg())
    expect(cat.parsed.name).toBe('mp-di-test')
    expect(cat.parsed.plugins).toHaveLength(1)
    // la cartella della cache: nome = hash della sorgente, contenuto vero
    const dir = join(marketplaceCacheDir(TMP), marketplaceCacheName(SOURCE()))
    expect(existsSync(join(dir, '.claude-plugin', 'marketplace.json'))).toBe(true)
    // e NESSUNA cartella sandbot-marketplace-* nuova in $TMPDIR
    expect(countTmpMarketplaces()).toBe(before)
  })

  it('riuso fra riavvii (nuovo manager, stessa dir dati) finché il TTL tiene: NESSUN re-clone', async () => {
    const dir = join(marketplaceCacheDir(TMP), marketplaceCacheName(SOURCE()))
    // un file sentinella DENTRO il clone: se il clone si rifà, sparisce
    writeFileSync(join(dir, 'sentinella'), 'resta')
    const m2 = createMarketplaceManager({ allowFileUrlsForTests: true, dataDir: () => TMP, now: () => 1_000_000 + MARKETPLACE_CACHE_MS - 1_000 })
    const cat = await m2.fetchCatalog(reg())
    expect(cat.parsed.name).toBe('mp-di-test')
    expect(existsSync(join(dir, 'sentinella'))).toBe(true) // stessa cartella
    // e il clone del manager resta quello (per le sorgenti relative)
    expect(m2.cloneOf(SOURCE())).toBe(dir)
  })

  it('TTL scaduto: re-clone in una cartella NUOVA che SOSTITUISCE la vecchia (una sola cartella in cache)', async () => {
    const dir = join(marketplaceCacheDir(TMP), marketplaceCacheName(SOURCE()))
    writeFileSync(join(dir, 'sentinella-vecchia'), 'sparisce')
    const m3 = createMarketplaceManager({ allowFileUrlsForTests: true, dataDir: () => TMP, now: () => 1_000_000 + MARKETPLACE_CACHE_MS + 1_000 })
    const cat = await m3.fetchCatalog(reg())
    expect(cat.parsed.name).toBe('mp-di-test')
    // la vecchia cartella è stata SOSTITUITA: la sentinella non c'è più
    expect(existsSync(join(dir, 'sentinella-vecchia'))).toBe(false)
    expect(existsSync(join(dir, '.claude-plugin', 'marketplace.json'))).toBe(true)
    // nella radice della cache c'è UNA sola cartella per la sorgente
    const entries = readdirSync(marketplaceCacheDir(TMP)).filter((e) => !e.endsWith('.at'))
    expect(entries).toEqual([marketplaceCacheName(SOURCE())])
    // e nessuna temporanea .clone-* dimenticata
    expect(readdirSync(marketplaceCacheDir(TMP)).filter((e) => e.startsWith('.clone-'))).toEqual([])
  })
})

/** Le cartelle sandbot-marketplace-* vive in $TMPDIR (il residuo della fase 13). */
function countTmpMarketplaces(): number {
  try {
    return readdirSync(tmpdir()).filter((e) => e.startsWith('sandbot-marketplace-')).length
  } catch {
    return 0
  }
}
