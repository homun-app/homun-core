// Fase rilascio di prova (RP1): Engramma da un ASSET FISSATO quando non c'è
// la sorgente locale (la CI non ha il crate: il repo ~/Projects/Bot/engramma
// non ha remote). prepare-engramma.mjs segue l'ordine: vendor già giusto →
// esce; sorgente presente → copia e verifica; altrimenti SCARICA i 3 file
// dagli asset della release del lock, verifica sha256 E dimensione, e MAI un
// file non verificato in vendor. Test con un SERVER FINTO su 127.0.0.1
// (ENGRAMMA_RELEASE_BASE / baseUrl iniettabile): nessun download vero.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')
const { prepareEngramma, sha256File, ENGRAMMA_FILES, releaseAssetUrls, resolveBaseUrl } = (await import('../prepare-engramma.mjs')) as {
  prepareEngramma: (o: {
    srcDir: string
    vendorDir: string
    run?: (cmd: string, args: string[], opts: { cwd: string }) => void
    fetchImpl?: (url: string) => Promise<{ ok: boolean; status?: number; arrayBuffer: () => Promise<ArrayBuffer> }>
    baseUrl?: string
  }) => Promise<{ copied: string[]; skipped: string[]; source: 'vendor' | 'crate' | 'release' }>
  sha256File: (f: string) => Promise<string>
  ENGRAMMA_FILES: string[]
  releaseAssetUrls: (lock: unknown, base?: string) => Record<string, string>
  resolveBaseUrl: (env?: Record<string, string | undefined>) => string
}

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-engramma-release-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const FILES: Record<string, string> = {
  'engramma.darwin-arm64.node': 'binario finto ma deterministico (RP1)',
  'index.js': 'module.exports = {}',
  'index.d.ts': 'export declare const version: string'
}
const RELEASE = { repo: 'homun-app/homun-core', tag: 'engramma-fase-v0.4.3' }

/** Il lock per i contenuti dati: hash, dimensioni e la release degli asset. */
async function lockOf(files: Record<string, string>, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const hashes: Record<string, string> = {}
  const sizes: Record<string, number> = {}
  for (const f of ENGRAMMA_FILES) {
    hashes[f] = await sha256File(join(files['__dir'] as string, f))
    sizes[f] = statSync(join(files['__dir'] as string, f)).size
  }
  return { module: 'engramma-node', version: '0.1.0-dev', tag: 'fase-v0.4.3', files: hashes, sizes, release: RELEASE, ...over }
}

/** Una cartella coi file dati + il lock calcolato sopra quei file. */
async function makeVendor(contents: Record<string, string>, over: Record<string, unknown> = {}): Promise<string> {
  const dir = join(ROOT, `ref-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(contents)) writeFileSync(join(dir, name), content)
  const dir2 = join(ROOT, `vendor-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir2, { recursive: true })
  writeFileSync(join(dir2, 'engramma.lock.json'), JSON.stringify(await lockOf({ ...contents, __dir: dir } as Record<string, string>, over), null, 2))
  return dir2
}

/** Il server finto su 127.0.0.1: serve i file della release (o li altera). */
function startReleaseServer(serve: Record<string, string | null>): { server: Server; url: string; requests: string[] } {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(String(req.url))
    const file = ENGRAMMA_FILES.find((f) => req.url === `/${RELEASE.repo}/releases/download/${RELEASE.tag}/${f}`)
    const body = file !== undefined ? serve[file] : undefined
    if (file === undefined || body === undefined || body === null) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    res.statusCode = 200
    res.end(body)
  })
  server.listen(0, '127.0.0.1')
  // listen è asincrono: la porta si legge solo dopo l'evento «listening» (url è un getter)
  return {
    server,
    get url(): string {
      const addr = server.address() as { port: number }
      return `http://127.0.0.1:${addr.port}`
    },
    requests
  }
}

let fake: { server: Server; url: string; requests: string[] }
beforeAll(async () => {
  fake = startReleaseServer(FILES)
  await new Promise<void>((resolve) => fake.server.once('listening', resolve))
})
afterAll(() => new Promise<void>((resolve) => fake.server.close(() => resolve())))

const MISSING_SRC = join(ROOT, 'src-inesistente')

describe('fase rilascio di prova (RP1): gli URL degli asset dal lock', () => {
  it('releaseAssetUrls ricava i 3 URL da repo, tag e nome del file (schema di fetch-llama)', () => {
    const lock = { release: RELEASE }
    const urls = releaseAssetUrls(lock)
    for (const f of ENGRAMMA_FILES) {
      expect(urls[f]).toBe(`https://github.com/${RELEASE.repo}/releases/download/${RELEASE.tag}/${f}`)
    }
  })

  it('la base si sostituisce (ENGRAMMA_RELEASE_BASE per i test, su 127.0.0.1)', () => {
    const urls = releaseAssetUrls({ release: RELEASE }, 'http://127.0.0.1:1')
    expect(urls['index.js']).toBe(`http://127.0.0.1:1/${RELEASE.repo}/releases/download/${RELEASE.tag}/index.js`)
  })

  it('resolveBaseUrl: default github.com, env vince, schema non http(s) rifiutato', () => {
    expect(resolveBaseUrl({})).toBe('https://github.com')
    expect(resolveBaseUrl({ ENGRAMMA_RELEASE_BASE: 'http://127.0.0.1:2' })).toBe('http://127.0.0.1:2')
    expect(() => resolveBaseUrl({ ENGRAMMA_RELEASE_BASE: 'file:///etc' })).toThrow()
    expect(() => resolveBaseUrl({ ENGRAMMA_RELEASE_BASE: 'not a url' })).toThrow()
  })

  it('un lock senza release non ha URL: errore chiaro', () => {
    expect(() => releaseAssetUrls({})).toThrow(/release/)
  })
})

describe('fase rilascio di prova (RP1): il download dagli asset (server finto su 127.0.0.1)', () => {
  it('vendor VUOTO e sorgente ASSENTE: scarica i 3 file, verifica hash e dimensione, li mette in vendor', async () => {
    const vendor = await makeVendor(FILES)
    const r = await prepareEngramma({ srcDir: MISSING_SRC, vendorDir: vendor, baseUrl: fake.url })
    expect(r.source).toBe('release')
    expect([...r.copied].sort()).toEqual([...ENGRAMMA_FILES].sort())
    for (const f of ENGRAMMA_FILES) expect(readFileSync(join(vendor, f), 'utf8')).toBe(FILES[f])
    // il package.json commonjs arriva anche dalla via dell'asset
    expect(JSON.parse(readFileSync(join(vendor, 'package.json'), 'utf8'))).toEqual({ type: 'commonjs' })
    expect(fake.requests.length).toBeGreaterThanOrEqual(3)
  })

  it('hash SBAGLIATO: fallisce NOMINANDO il file e NON lascia file in vendor', async () => {
    const serve = { ...FILES, 'index.js': 'module.exports = { altro: true }' } // hash diverso, STESSA lunghezza
    const srv = startReleaseServer(serve)
    try {
      const vendor = await makeVendor(FILES)
      await expect(prepareEngramma({ srcDir: MISSING_SRC, vendorDir: vendor, baseUrl: srv.url })).rejects.toThrow(/index\.js/)
      for (const f of ENGRAMMA_FILES) expect(existsSync(join(vendor, f))).toBe(false)
    } finally {
      await new Promise<void>((resolve) => srv.server.close(() => resolve()))
    }
  })

  it('dimensione SBAGLIATA: errore che la nomina, niente file in vendor', async () => {
    const serve = { ...FILES, 'index.js': 'module.exports = {} ' } // un byte in più
    const srv = startReleaseServer(serve)
    try {
      const vendor = await makeVendor(FILES)
      const expected = Buffer.from(FILES['index.js']!, 'utf8').length
      await expect(prepareEngramma({ srcDir: MISSING_SRC, vendorDir: vendor, baseUrl: srv.url })).rejects.toThrow(
        new RegExp(`dimensione|${expected} byte`, 'i')
      )
      for (const f of ENGRAMMA_FILES) expect(existsSync(join(vendor, f))).toBe(false)
    } finally {
      await new Promise<void>((resolve) => srv.server.close(() => resolve()))
    }
  })

  it('HTTP 404: errore chiaro che nomina il download, niente file in vendor', async () => {
    const serve = { ...FILES, 'engramma.darwin-arm64.node': null }
    const srv = startReleaseServer(serve)
    try {
      const vendor = await makeVendor(FILES)
      await expect(prepareEngramma({ srcDir: MISSING_SRC, vendorDir: vendor, baseUrl: srv.url })).rejects.toThrow(/404|download/i)
      for (const f of ENGRAMMA_FILES) expect(existsSync(join(vendor, f))).toBe(false)
    } finally {
      await new Promise<void>((resolve) => srv.server.close(() => resolve()))
    }
  })

  it('lock SENZA release e sorgente ASSENTE: errore che lo dice (niente silenzio)', async () => {
    const vendor = await makeVendor(FILES, { release: undefined })
    await expect(prepareEngramma({ srcDir: MISSING_SRC, vendorDir: vendor, baseUrl: fake.url })).rejects.toThrow(/release|sorgente/i)
  })

  it('vendor già GIUSTO: esce subito, il server non viene MAI toccato', async () => {
    const vendor = await makeVendor(FILES)
    // si popola PRIMA (la prima volta via asset), poi vendor è pronto
    await prepareEngramma({ srcDir: MISSING_SRC, vendorDir: vendor, baseUrl: fake.url })
    const before = fake.requests.length
    const r = await prepareEngramma({ srcDir: MISSING_SRC, vendorDir: vendor, baseUrl: fake.url })
    expect(r.source).toBe('vendor')
    expect(r.copied).toEqual([])
    expect(fake.requests.length).toBe(before)
  })

  it('la SORGENTE LOCALE vince sul download: nessuna richiesta al server', async () => {
    const src = join(ROOT, 'src-crate')
    mkdirSync(src, { recursive: true })
    for (const [name, content] of Object.entries(FILES)) writeFileSync(join(src, name), content)
    const vendor = await makeVendor(FILES)
    const before = fake.requests.length
    const r = await prepareEngramma({ srcDir: src, vendorDir: vendor, baseUrl: fake.url })
    expect(r.source).toBe('crate')
    expect(fake.requests.length).toBe(before)
  })

  it('ENGRAMMA_RELEASE_BASE sposta il download SENZA baseUrl esplicito (la via dei test)', async () => {
    const vendor = await makeVendor(FILES)
    const saved = process.env.ENGRAMMA_RELEASE_BASE
    process.env.ENGRAMMA_RELEASE_BASE = fake.url
    try {
      const r = await prepareEngramma({ srcDir: MISSING_SRC, vendorDir: vendor })
      expect(r.source).toBe('release')
      for (const f of ENGRAMMA_FILES) expect(readFileSync(join(vendor, f), 'utf8')).toBe(FILES[f])
    } finally {
      if (saved === undefined) delete process.env.ENGRAMMA_RELEASE_BASE
      else process.env.ENGRAMMA_RELEASE_BASE = saved
    }
  })
})

describe('fase rilascio di prova (RP1): il lock del repo punta agli asset giusti', () => {
  it('engramma.lock.json ha release {homun-app/homun-core, engramma-fase-v0.4.3} e le dimensioni dei 3 file', async () => {
    const lockPath = join(REPO, 'vendor', 'engramma', 'engramma.lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    expect(lock.release).toEqual(RELEASE)
    // le dimensioni scritte nel lock sono QUELLE dei file in vendor (che il
    // fast path ha già verificato contro gli hash del lock stesso)
    expect(Object.keys(lock.sizes).sort()).toEqual([...ENGRAMMA_FILES].sort())
    for (const f of ENGRAMMA_FILES) {
      expect(lock.sizes[f]).toBe(statSync(join(REPO, 'vendor', 'engramma', f)).size)
    }
    // gli URL derivati dal lock vero puntano alla release del lock
    const urls = releaseAssetUrls(lock)
    expect(urls['engramma.darwin-arm64.node']).toBe(
      `https://github.com/${RELEASE.repo}/releases/download/${RELEASE.tag}/engramma.darwin-arm64.node`
    )
  })
})
