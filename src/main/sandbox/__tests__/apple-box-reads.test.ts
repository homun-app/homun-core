// Fase box-apple-cli-vera (BAV2): le LETTURE del motore Apple sono JSON,
// mai template. I parse PURI si provano sulle uscite VERE della CLI 1.7.1
// (le fixture copiate alla lettera): l'esistenza dall'elenco ls --format
// json, TUTTI i fatti del box esistente da UN solo inspect (running, useInit,
// l'immagine NORMALIZZATA — docker.io/library/sandbot-box:x ≡ sandbot-box:x —,
// i mount col loro ro, la rete), i nomi dei volumi, la dimensione dell'immagine
// intera, il df nella forma Apple. Visto FALLIRE il 2026-11-14: i parse non
// esistevano e l'ensure leggeva nomi per riga dal JSON.
import { describe, expect, it, afterAll, vi } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'container-1.7.1')

/** Il corpo di una fixture: senza la riga `$ container…` e senza `[exit N]`. */
const fixture = (name: string): string => {
  const text = readFileSync(join(FIXTURES, name), 'utf8')
  return text.replace(/^\$ container[^\n]*\n/, '').replace(/\[exit \d+\]\n?$/, '').trim()
}

const {
  appleLsJsonIds,
  parseAppleBoxInspect,
  normalizeAppleImageRef,
  appleVolumeNamesFromLsJson,
  appleImageSizeBytesFromInspect,
  appleBoxInspectArgv
} = await import('../apple-container-argv')
const { setDiskSpaceProbeForTests } = await import('../disk-space')
const { appleContainerEngine } = await import('../apple-container-engine')

// fase design (verifica della suite): il probe dello spazio disco, come fa
// disk-space.test.ts — qui fingiamo TUTTO (la CLI del box, il runner) e il
// controllo dello spazio leggeva invece il disco VERO della macchina: la
// suite diventava verde o rossa secondo i GB liberi del momento (il prodotto
// chiede ~6,5 GB liberi prima di costruire l'immagine del box).
setDiskSpaceProbeForTests(() => 20_000_000_000)
const { parseDfJson } = await import('../disk-space')

describe('BAV2: i parse PURI sulle uscite VERE della 1.7.1 (le fixture)', () => {
  it('ls -a --format json (fixture ls-a-json): gli id da configuration.id — il box c\'è, buildkit pure', () => {
    expect(appleLsJsonIds(fixture('ls-a-json.txt'))).toEqual(['sandbot-box', 'buildkit'])
    expect(appleContainerEngine.reads!.psExists(fixture('ls-a-json.txt'), 'sandbot-box')).toBe(true)
    expect(appleContainerEngine.reads!.psExists(fixture('ls-a-json.txt'), 'nonesiste')).toBe(false)
    // un elenco VUOTO è un elenco (non un errore): il box non c'è
    expect(appleLsJsonIds('[]')).toEqual([])
    expect(appleContainerEngine.reads!.psExists('[]', 'sandbot-box')).toBe(false)
  })

  it('ls -a --format json: JSON illeggibile → null, l\'elenco che non c\'è (mai un errore che ferma i bot)', () => {
    expect(appleLsJsonIds('')).toBeNull()
    expect(appleLsJsonIds('Error: qualcosa')).toBeNull()
  })

  it('inspect (fixture inspect-box): running TRUE, useInit FALSE (il box del vivo era nato senza --init), immagine NORMALIZZATA, plugin RO, rete homun-box', () => {
    const p = parseAppleBoxInspect(fixture('inspect-box.txt'))!
    expect(p).not.toBeNull()
    expect(p.running).toBe(true) // status.state === 'running'
    expect(p.useInit).toBe(false) // configuration.useInit === false (BAV4: si ricrea)
    expect(p.imageRef).toBe('sandbot-box:abab9640c765') // via docker.io/library/
    expect(p.mounts).toEqual([
      { destination: '/box', ro: false },
      { destination: '/plugins', ro: true },
      { destination: '/browser', ro: false }
    ])
    expect(p.network).toBe('homun-box')
  })

  it('inspect di chi non c\'è (fixture inspect-missing): niente stdout da leggere → null', () => {
    expect(parseAppleBoxInspect('')).toBeNull()
    expect(parseAppleBoxInspect('Error: container not found: nonesiste')).toBeNull()
    expect(parseAppleBoxInspect('[]')).toBeNull()
  })

  it('la NORMALIZZAZIONE: docker.io/library/sandbot-box:x ≡ sandbot-box:x; gli ALTRI registri restano interi', () => {
    expect(normalizeAppleImageRef('docker.io/library/sandbot-box:abab9640c765')).toBe('sandbot-box:abab9640c765')
    expect(normalizeAppleImageRef('sandbot-box:abab9640c765')).toBe('sandbot-box:abab9640c765')
    expect(normalizeAppleImageRef('mcr.microsoft.com/playwright:v1.64.1-noble')).toBe('mcr.microsoft.com/playwright:v1.64.1-noble')
  })

  it('volume ls --format json (fixture volume-ls-json): i TRE nomi da configuration.name — niente --filter', () => {
    expect(appleVolumeNamesFromLsJson(fixture('volume-ls-json.txt'))).toEqual(['sandbot-box', 'sandbot-browser', 'sandbot-plugins'])
    expect(appleVolumeNamesFromLsJson('[]')).toEqual([])
    expect(appleVolumeNamesFromLsJson('non json')).toBeNull()
  })

  it('image inspect (fixture image-inspect): la dimensione dell\'immagine INTERA è la SOMMA dei variants[].size', () => {
    // PERCHÉ quel campo: il `descriptor.size` del manifest (375 byte) è il
    // size del SOLO JSON dell'indice OCI, non dell'immagine; ogni variante
    // di `variants` è l'immagine COMPLETA per una piattaforma — il suo
    // `size` (1 302 970 425 byte qui) è il numero che occupa il disco
    expect(appleImageSizeBytesFromInspect(fixture('image-inspect.txt'))).toBe(1302970425)
    // più varianti (piattaforme) si SOMMANO: tutte stanno sul disco
    expect(appleImageSizeBytesFromInspect(JSON.stringify([{ variants: [{ size: 100 }, { size: 23 }] }]))).toBe(123)
    expect(appleImageSizeBytesFromInspect('[]')).toBeNull()
    expect(appleImageSizeBytesFromInspect('non json')).toBeNull()
  })

  it('system df --format json (fixture system-df-json): la forma Apple — un OGGETTO con sizeInBytes e reclaimable', () => {
    const df = parseDfJson(fixture('system-df-json.txt'))!
    expect(df).not.toBeNull()
    expect(df.imagesBytes).toBe(5396357120)
    expect(df.imagesReclaimableBytes).toBe(244289536)
    expect(df.containersBytes).toBe(10580217856)
    expect(df.volumesBytes).toBe(119730176)
    // la CLI di Apple NON ha la voce della cache di build
    expect(df.buildCacheBytes).toBe(0)
    expect(df.buildCacheReclaimableBytes).toBe(0)
  })
})

describe('BAV2: le letture del MOTORE (reads) — un solo inspect per TUTTI i fatti', () => {
  const reads = appleContainerEngine.reads!

  it('gli argv delle letture: ls --format json, inspect senza --format, volume ls --format json, image inspect senza --format', () => {
    expect(reads.psArgv('sandbot-box')).toEqual(['ls', '-a', '--format', 'json'])
    expect(reads.boxInspectArgv('sandbot-box')).toEqual(['inspect', 'sandbot-box'])
    expect(appleBoxInspectArgv('sandbot-box')).toEqual(['inspect', 'sandbot-box'])
    expect(reads.volumeLsArgv()).toEqual(['volume', 'ls', '--format', 'json'])
    expect(reads.imageSizeArgv('sandbot-box:abab9640c765')).toEqual(['image', 'inspect', 'sandbot-box:abab9640c765'])
  })

  it('boxFacts sulla fixture inspect-box: TUTTO a posto (l\'immagine uguale DOPO la normalizzazione)', () => {
    const f = reads.boxFacts(fixture('inspect-box.txt'), {
      expectedImage: 'sandbot-box:abab9640c765',
      imageKnown: true,
      networkName: 'homun-box'
    })!
    expect(f).not.toBeNull()
    expect(f.initOk).toBe(false) // useInit:false → BAV4 ricreazione 'senza-init'
    expect(f.imageOk).toBe(true) // docker.io/library/… ≡ sandbot-box:…
    expect(f.staleImage).toBeNull()
    expect(f.pluginsMountOk).toBe(true)
    expect(f.browserMountOk).toBe(true)
    expect(f.networkOk).toBe(true)
  })

  it('boxFacts: immagine DIVERSA → imageOk false e la vecchia è NOSTRA (staleImage, la si toglie a box ripartito)', () => {
    const f = reads.boxFacts(fixture('inspect-box.txt'), {
      expectedImage: 'sandbot-box:nuovotag',
      imageKnown: true,
      networkName: 'homun-box'
    })!
    expect(f.imageOk).toBe(false)
    expect(f.staleImage).toBe('sandbot-box:abab9640c765')
  })

  it('boxFacts: build NON riuscita → imageOk ignoto (non si ricrea, la regola di oggi); rete DIVERSA → networkOk false', () => {
    const f = reads.boxFacts(fixture('inspect-box.txt'), { expectedImage: 'sandbot-box:x', imageKnown: false, networkName: 'homun-box-isolated' })!
    expect(f.imageOk).toBeUndefined()
    expect(f.staleImage).toBeNull()
    expect(f.networkOk).toBe(false)
  })

  it('boxFacts: JSON illeggibile → null (le regole di oggi: non si ricrea, salvo none che fallisce chiuso)', () => {
    expect(reads.boxFacts('', { expectedImage: 'x', imageKnown: true, networkName: 'homun-box' })).toBeNull()
    expect(reads.boxFacts('Error: container not found: sandbot-box', { expectedImage: 'x', imageKnown: true, networkName: 'homun-box' })).toBeNull()
  })
})

// ---- l'ensure con le letture Apple: l'inspect ILLEGGIBILE non ricrea (in bridge) ----
// Come i test di apple-box-reuse: la CLI FINTA VERA come runner, un log per
// giro; l'inspect del box risponde SPAZZATURA (il caso «JSON illeggibile»).
const ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const FAKE = join(ROOT, 'scripts', 'fake-container.mjs')
const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-apple-box-reads-test-'))

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key in settings.value ? settings.value[key] : fallback),
  dataDir: () => TMP,
  getAgent: () => null
}))

const { execCommand, setDockerRunnerForTests } = await import('../index')

const readCliLog = (file: string): string[][] =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv as string[])

describe('BAV2: l\'ensure del box legge JSON (CLI finta severa)', () => {
  it('inspect ILLEGGIBILE in bridge: NON si ricrea (nessun rm), il comando del bot gira — le regole di oggi', async () => {
    const logFile = join(TMP, 'cli-illeggibile.jsonl')
    // il box NASCE (log fresco)
    const base = async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: null }> => {
      const r = spawnSync(process.execPath, [FAKE, ...argv], {
        encoding: 'utf8',
        env: { ...process.env, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
      })
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status, signal: null }
    }
    const runner = async (argv: string[]) =>
      argv[0] === 'inspect' && !argv.includes('-f') && !argv.includes('--format')
        ? { stdout: '(la CLI ha stampato altro)', stderr: '', exitCode: 0, signal: null }
        : base(argv)
    settings.value = { 'sandbox.mode': 'box', 'sandbox.engine': 'apple-container', 'sandbox.network': 'bridge' }
    setDockerRunnerForTests(runner)
    const r1 = await execCommand('agent_x', 'true')
    expect(r1.exitCode).toBe(0)
    const before = readCliLog(logFile).length
    const r2 = await execCommand('agent_y', 'echo ancora')
    expect(r2.exitCode).toBe(0)
    const after = readCliLog(logFile).slice(before)
    // l'ensure USA il box: nessun rm, nessun nuovo run -d, il comando gira
    expect(after.some((a) => a[0] === 'rm')).toBe(false)
    expect(after.some((a) => a[0] === 'run' && a.includes('-d'))).toBe(false)
    expect(after.some((a) => a[0] === 'exec' && a.includes('echo ancora'))).toBe(true)
    // e l'esistenza l'ha letta dal JSON dell'elenco (il box C'ERA)
    expect(after.some((a) => a[0] === 'ls' && a.includes('--format'))).toBe(true)
    setDockerRunnerForTests(null)
    settings.value = {}
  }, 20_000)
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})
