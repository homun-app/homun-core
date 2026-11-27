// Fase memoria-engramma (M0): il pacchetto del motore — prepare-engramma.mjs
// copia .node/index.js/index.d.ts dal crate engramma-node in vendor/engramma/
// e verifica lo SHA256 contro engramma.lock.json. Test sul CUORE iniettabile
// (cartelle fixture in una temporanea): niente crate vero, niente cargo.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, chmodSync } from 'node:fs'
import { TEST_TMP_BASE } from '../../src/test-tmp'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')
// il cuore dello script è importabile dal .mjs (prepareEngramma iniettabile)
const { prepareEngramma, sha256File, ENGRAMMA_FILES } = (await import('../prepare-engramma.mjs')) as {
  prepareEngramma: (o: {
    srcDir: string
    vendorDir: string
    run?: (cmd: string, args: string[], opts: { cwd: string }) => void
  }) => Promise<{ copied: string[]; skipped: string[] }>
  sha256File: (f: string) => Promise<string>
  ENGRAMMA_FILES: string[]
}

const ROOT = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-engramma-prepare-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const BASE: Record<string, string> = {
  'engramma.darwin-arm64.node': 'binario finto ma deterministico',
  'index.js': 'module.exports = {}',
  'index.d.ts': 'export declare const version: string'
}

let n = 0
/** Una cartella coi file dati (nome → contenuto). */
function makeDir(prefix: string, files: Record<string, string>): string {
  const dir = join(ROOT, `${prefix}-${++n}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

/** vendor/engramma con il lock calcolato sui contenuti dati (di solito BASE). */
async function makeVendor(contents: Record<string, string> = BASE): Promise<string> {
  const ref = makeDir('ref', contents)
  const files: Record<string, string> = {}
  for (const f of ENGRAMMA_FILES) files[f] = await sha256File(join(ref, f))
  return makeDir('vendor', {
    'engramma.lock.json': JSON.stringify({ module: 'engramma-node', version: '0.1.0-dev', tag: 'fase-v0.4.1', files }, null, 2)
  })
}

describe('fase memoria-engramma M0: prepare-engramma', () => {
  it('copia i tre file in vendor/engramma/ la prima volta', async () => {
    const src = makeDir('src', BASE)
    const vendor = await makeVendor()
    const r = await prepareEngramma({ srcDir: src, vendorDir: vendor })
    expect([...r.copied].sort()).toEqual([...ENGRAMMA_FILES].sort())
    for (const f of ENGRAMMA_FILES) expect(readFileSync(join(vendor, f), 'utf8')).toBe(BASE[f])
  })

  it('scrive vendor/engramma/package.json con type commonjs (index.js è CJS sotto un repo "type": "module")', async () => {
    // senza, Node tratta index.js come ESM e il require('./engramma.darwin-arm64.node')
    // del caricatore napi-rs si risolve dal chiamante: «Cannot find native binding»
    const src = makeDir('src', BASE)
    const vendor = await makeVendor()
    await prepareEngramma({ srcDir: src, vendorDir: vendor })
    expect(JSON.parse(readFileSync(join(vendor, 'package.json'), 'utf8'))).toEqual({ type: 'commonjs' })
  })

  it('è idempotente: la seconda volta non riscrive nulla (mtime intatto)', async () => {
    const src = makeDir('src', BASE)
    const vendor = await makeVendor()
    await prepareEngramma({ srcDir: src, vendorDir: vendor })
    const node = join(vendor, 'engramma.darwin-arm64.node')
    const past = new Date(Date.now() - 60_000)
    utimesSync(node, past, past)
    const r = await prepareEngramma({ srcDir: src, vendorDir: vendor })
    expect(r.copied).toEqual([])
    expect([...r.skipped].sort()).toEqual([...ENGRAMMA_FILES].sort())
    expect(Math.abs(statSync(node).mtimeMs - past.getTime())).toBeLessThan(1000)
  })

  // fase locale (L0): la build di Homun NON dipende dallo stato del repo di
  // Engramma — mentre GLM lavora a v0.4.3 nell'altro repo il .node sorgente
  // cambia, ma se vendor/ ha già gli hash del lock lo script esce SUBITO
  it('L0: vendor coi tre hash del lock → ok senza LEGGERE la sorgente (nemmeno se manca)', async () => {
    const vendor = await makeVendor()
    // prima la popola (la prima copia vera)…
    const seed = makeDir('seed', BASE)
    await prepareEngramma({ srcDir: seed, vendorDir: vendor })
    // …poi la sorgente sparisce (l'altro repo che cambia non conta più)
    const missing = join(ROOT, 'src-inesistente-L0')
    const r = await prepareEngramma({ srcDir: missing, vendorDir: vendor })
    expect(r.copied).toEqual([])
    expect([...r.skipped].sort()).toEqual([...ENGRAMMA_FILES].sort())
    // e i file non sono stati riscritti (mtime intatto)
    const node = join(vendor, 'engramma.darwin-arm64.node')
    const past = new Date(Date.now() - 60_000)
    utimesSync(node, past, past)
    await prepareEngramma({ srcDir: missing, vendorDir: vendor })
    expect(Math.abs(statSync(node).mtimeMs - past.getTime())).toBeLessThan(1000)
  })

  it('L0: vendor SBAGLIATO e sorgente con hash diverso dal lock → errore che NOMINA il file', async () => {
    // vendor con un file rotto, sorgente che non è la versione agganciata
    const vendor = await makeVendor()
    const seed = makeDir('seed-l0b', BASE)
    await prepareEngramma({ srcDir: seed, vendorDir: vendor })
    writeFileSync(join(vendor, 'index.js'), 'module.exports = { rotto: true }')
    const src = makeDir('src-l0b', { ...BASE, 'index.js': 'module.exports = { altro: true }' })
    await expect(prepareEngramma({ srcDir: src, vendorDir: vendor })).rejects.toThrow(/index\.js/)
    // il vendor rotto non è stato sovrascritto con la sorgente NON agganciata
    expect(readFileSync(join(vendor, 'index.js'), 'utf8')).toBe('module.exports = { rotto: true }')
  })

  it('rifiuta una sorgente il cui hash non è nel lock (versione non agganciata)', async () => {
    const src = makeDir('src', { ...BASE, 'index.js': 'module.exports = { altro: true }' })
    const vendor = await makeVendor()
    await expect(prepareEngramma({ srcDir: src, vendorDir: vendor })).rejects.toThrow(/index\.js/)
    // niente copiato di sbagliato
    expect(existsSync(join(vendor, 'index.js'))).toBe(false)
  })

  it('senza lock si ferma con un errore chiaro', async () => {
    const src = makeDir('src', BASE)
    const vendor = makeDir('vendor-nolock', {})
    await expect(prepareEngramma({ srcDir: src, vendorDir: vendor })).rejects.toThrow(/engramma\.lock\.json/)
  })

  it('costruisce il .node UNA volta se manca nella sorgente (npm run build nel crate)', async () => {
    const { 'engramma.darwin-arm64.node': built, ...rest } = BASE
    const src = makeDir('src-build', rest)
    const vendor = await makeVendor()
    const runs: Array<{ cmd: string; args: string[]; cwd: string }> = []
    const r = await prepareEngramma({
      srcDir: src,
      vendorDir: vendor,
      run: (cmd, args, opts) => {
        runs.push({ cmd, args, cwd: opts.cwd })
        writeFileSync(join(src, 'engramma.darwin-arm64.node'), built!)
      }
    })
    expect(runs).toEqual([{ cmd: 'npm', args: ['run', 'build'], cwd: src }])
    expect(r.copied).toContain('engramma.darwin-arm64.node')
  })

  // La sorgente può essere in SOLA LETTURA — le cartelle aggancio-v* lo sono (.node
  // 0555, index.js e index.d.ts 0444) — e copyFileSync porta con sé i modi della
  // sorgente: in vendor restavano file in sola lettura, e l'aggancio SUCCESSIVO (il
  // lock cambia, il .node va riscritto) cadeva con EACCES. In vendor i modi sono
  // quelli normali, 0644.
  const modiSolaLettura = (f: string) => (f === 'engramma.darwin-arm64.node' ? 0o555 : 0o444)
  const modiDi = (file: string) => statSync(file).mode & 0o777

  it('da una sorgente in SOLA LETTURA (aggancio-v*) i file copiati in vendor hanno modi normali (0644)', async () => {
    const src = makeDir('src-sola-lettura', BASE)
    for (const f of ENGRAMMA_FILES) chmodSync(join(src, f), modiSolaLettura(f))
    const vendor = await makeVendor()
    const r = await prepareEngramma({ srcDir: src, vendorDir: vendor })
    expect([...r.copied].sort()).toEqual([...ENGRAMMA_FILES].sort())
    for (const f of ENGRAMMA_FILES) {
      expect(readFileSync(join(vendor, f), 'utf8')).toBe(BASE[f])
      expect(modiDi(join(vendor, f)), f).toBe(0o644)
    }
    // la sorgente non si tocca: resta in sola lettura
    for (const f of ENGRAMMA_FILES) expect(modiDi(join(src, f))).toBe(modiSolaLettura(f))
  })

  it('l’aggancio SUCCESSIVO riesce anche se in vendor c’è una copia in sola lettura (prima: EACCES)', async () => {
    const vendor = await makeVendor()
    // la copia di prima, com'è rimasta con lo script vecchio: i modi della sorgente
    await prepareEngramma({ srcDir: makeDir('src-vecchia', BASE), vendorDir: vendor })
    for (const f of ENGRAMMA_FILES) chmodSync(join(vendor, f), modiSolaLettura(f))
    // il lock passa alla versione dopo; la sorgente nuova è in sola lettura anche lei
    const DOPO = { ...BASE, 'engramma.darwin-arm64.node': 'binario finto della versione DOPO' }
    const srcDopo = makeDir('src-dopo-sola-lettura', DOPO)
    for (const f of ENGRAMMA_FILES) chmodSync(join(srcDopo, f), modiSolaLettura(f))
    const lockPath = join(vendor, 'engramma.lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    for (const f of ENGRAMMA_FILES) lock.files[f] = await sha256File(join(srcDopo, f))
    writeFileSync(lockPath, JSON.stringify(lock, null, 2))
    const r = await prepareEngramma({ srcDir: srcDopo, vendorDir: vendor })
    expect(r.copied).toEqual(['engramma.darwin-arm64.node'])
    expect(r.skipped.sort()).toEqual(['index.d.ts', 'index.js'])
    const node = join(vendor, 'engramma.darwin-arm64.node')
    expect(readFileSync(node, 'utf8')).toBe(DOPO['engramma.darwin-arm64.node'])
    expect(modiDi(node)).toBe(0o644)
    // la terza volta non tocca più nulla: vendor già giusto
    const past = new Date(Date.now() - 60_000)
    utimesSync(node, past, past)
    const r3 = await prepareEngramma({ srcDir: srcDopo, vendorDir: vendor })
    expect(r3.copied).toEqual([])
    expect(Math.abs(statSync(node).mtimeMs - past.getTime())).toBeLessThan(1000)
  })

  it('il lock nel repo ha modulo, versione, tag fase-v0.6.20 e i tre hash', () => {
    const lock = JSON.parse(readFileSync(join(REPO, 'vendor', 'engramma', 'engramma.lock.json'), 'utf8'))
    expect(lock.module).toBe('engramma-node')
    expect(lock.tag).toBe('fase-v0.6.20')
    expect(typeof lock.version).toBe('string')
    expect(Object.keys(lock.files).sort()).toEqual([...ENGRAMMA_FILES].sort())
    for (const h of Object.values(lock.files) as string[]) expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('il .node resta fuori dall asar: extraResources porta vendor/ in Resources/vendor', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    expect(pkg.build.files).toEqual(['out/**/*'])
    expect(pkg.build.extraResources).toContainEqual({ from: 'vendor', to: 'vendor' })
    // gira su pretest/predev/predist/prebuild come prepare-wasm
    for (const hook of ['pretest', 'predev', 'predist', 'prebuild']) {
      expect(pkg.scripts[hook]).toContain('prepare-engramma.mjs')
    }
    expect(pkg.scripts['release:local']).toContain('prepare-engramma.mjs')
  })

  it('verify-release controlla il .node: presente, hash del lock, codesign --verify --strict', () => {
    const src = readFileSync(join(REPO, 'scripts', 'verify-release.mjs'), 'utf8')
    expect(src).toContain('engramma.darwin-arm64.node')
    expect(src).toContain('engramma.lock.json')
    expect(src).toMatch(/'--verify',\s*'--strict'/)
  })
})
