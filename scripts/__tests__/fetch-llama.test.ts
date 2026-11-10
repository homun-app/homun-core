// Fase locale (L2.1): fetch-llama.mjs — scarica l'asset UFFICIALE fissato in
// scripts/llama-pin.json, verifica sha256 e dimensione, estrae in vendor/llama/
// SOLO llama-server e le dylib che gli servono (otool -L). Tutto con un TAR
// FINTO in mkdtemp e fetch/otool iniettati: nessun download vero (rete vietata).
//
// Fase fetch-llama sul tarball vero (RS1): il tarball VERO di llama.cpp non è
// piatto — TUTTO sta in una cartella llama-<tag>/, le dipendenze passano da
// @rpath/ (l'unico LC_RPATH è @loader_path) e molte dylib sono symlink
// lib*.0.dylib -> lib*.0.x.y.dylib. Il fixture qui sotto ha quella struttura,
// con gli output di otool -L/-l copiati dal formato vero (dipendenze @rpath,
// LC_RPATH @loader_path, /usr/lib/librdma.dylib weak).
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, readdirSync, lstatSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { fetchLlamaBundle, ensureLlamaNotice } = (await import('../fetch-llama.mjs')) as {
  fetchLlamaBundle: (o: {
    pin: { url: string; size: number; sha256: string; asset: string }
    fetchImpl: (url: string) => Promise<{ ok: boolean; status?: number; arrayBuffer: () => Promise<ArrayBuffer> }>
    otool: (file: string, flag: 'L' | 'l') => string
    targetDir: string
  }) => Promise<{ files: string[]; bytes: number }>
  ensureLlamaNotice: (noticesPath: string) => boolean
}

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-fetch-llama-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

/** Un tar.gz FINTO con llama-server, due dylib collegate e un file che NON serve. */
function makeFakeBundle(): { path: string; size: number; sha256: string } {
  const src = join(ROOT, 'bundle-src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'llama-server'), '#!/bin/sh\n# finto llama-server b12061\nsleep 1\n')
  writeFileSync(join(src, 'libllama.dylib'), 'dylib finta llama (compatibile, deterministica)')
  writeFileSync(join(src, 'libggml-metal.dylib'), 'dylib finta metal')
  writeFileSync(join(src, 'README.md'), 'non serve nel bundle')
  const tarPath = join(ROOT, 'llama-b12061-bin-macos-arm64.tar.gz')
  const r = spawnSync('tar', ['-czf', tarPath, '-C', src, 'llama-server', 'libllama.dylib', 'libggml-metal.dylib', 'README.md'])
  if (r.status !== 0) throw new Error('tar finto non creato: ' + r.stderr)
  const buf = readFileSync(tarPath)
  return { path: tarPath, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }
}

/**
 * otool FINTO del tarball piatto: `-L` dà llama-server → libllama,
 * libllama → libggml-metal (chiusura transitiva); `-l` non ha LC_RPATH
 * (quelle dylib si collegano via @loader_path, senza @rpath).
 */
const fakeOtool = (file: string, flag?: 'L' | 'l'): string => {
  if (flag === 'l') return ''
  if (file.endsWith('llama-server')) {
    return `llama-server:\n\t@loader_path/libllama.dylib (compatibility version 0.0.0)\n\t/usr/lib/libc++.1.dylib (compatibility version 9.0.0)\n\t/usr/lib/libSystem.B.dylib`
  }
  if (file.endsWith('libllama.dylib')) {
    return `libllama.dylib:\n\t@loader_path/libggml-metal.dylib (compatibility version 0.0.0)\n\t/usr/lib/libSystem.B.dylib`
  }
  return `${file}:\n\t/usr/lib/libSystem.B.dylib`
}

const BUNDLE = makeFakeBundle()
const pinOf = (over: Partial<{ size: number; sha256: string }> = {}) => ({
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12061/llama-b12061-bin-macos-arm64.tar.gz',
  asset: 'llama-b12061-bin-macos-arm64.tar.gz',
  size: BUNDLE.size,
  sha256: BUNDLE.sha256,
  ...over
})
const fetchOfBundle = (url: string) => {
  if (url !== 'https://github.com/ggml-org/llama.cpp/releases/download/b12061/llama-b12061-bin-macos-arm64.tar.gz') {
    return Promise.resolve({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })
  }
  const buf = readFileSync(BUNDLE.path)
  return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) })
}

describe('fase locale (L2.1): fetchLlamaBundle con tar finto e fetch iniettato', () => {
  it('sha e dimensione GIUSTI: estrae llama-server e le dylib della chiusura, eseguibile, senza il resto', async () => {
    const target = join(ROOT, 'vendor-ok')
    const r = await fetchLlamaBundle({ pin: pinOf(), fetchImpl: fetchOfBundle, otool: fakeOtool, targetDir: target })
    expect(r.files.sort()).toEqual(['libggml-metal.dylib', 'libllama.dylib', 'llama-server'])
    expect(existsSync(join(target, 'README.md'))).toBe(false) // solo ciò che serve
    // llama-server è ESEGUIBILE
    expect(statSync(join(target, 'llama-server')).mode & 0o111).not.toBe(0)
    expect(r.bytes).toBeGreaterThan(0)
  })

  it('sha256 SBAGLIATO: errore che lo dice, vendor/llama resta VUOTA', async () => {
    const target = join(ROOT, 'vendor-badsha')
    await expect(fetchLlamaBundle({
      pin: pinOf({ sha256: '0'.repeat(64) }), fetchImpl: fetchOfBundle, otool: fakeOtool, targetDir: target
    })).rejects.toThrow(/sha256/i)
    expect(existsSync(target)).toBe(false)
  })

  it('dimensione SBAGLIATA: errore che la nomina (prima ancora dell\'hash)', async () => {
    const target = join(ROOT, 'vendor-badsize')
    await expect(fetchLlamaBundle({
      pin: pinOf({ size: BUNDLE.size + 1 }), fetchImpl: fetchOfBundle, otool: fakeOtool, targetDir: target
    })).rejects.toThrow(/16542711|dimensione|byte/i as RegExp)
    expect(existsSync(target)).toBe(false)
  })

  it('download fallito (404): errore chiaro, niente estrazione', async () => {
    const target = join(ROOT, 'vendor-404')
    await expect(fetchLlamaBundle({
      pin: { ...pinOf(), url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12061/ALTRO.tar.gz' },
      fetchImpl: fetchOfBundle, otool: fakeOtool, targetDir: target
    })).rejects.toThrow(/404|download/i)
    expect(existsSync(target)).toBe(false)
  })
})

// ---- Fase fetch-llama sul tarball vero (RS1): la STRUTTURA VERA ----
// Nel tarball b12061 (pin del repo) tutto sta in llama-<tag>/, le dipendenze
// passano da @rpath/ e molte dylib sono symlink. Chiusura calcolata da me
// (spec): 11 voci, ~30 MB.

/** La cartella in cima del tarball vero (fixture col tag finto b9999). */
const REAL_TAG = 'llama-b9999'

/** Le 11 voci della chiusura vera (llama-server + 10 dylib), in ordine. */
const CHIUSURA = [
  'llama-server',
  'libggml-base.0.dylib',
  'libggml-blas.0.dylib',
  'libggml-cpu.0.dylib',
  'libggml-metal.0.dylib',
  'libggml-rpc.0.dylib',
  'libggml.0.dylib',
  'libllama-common.0.dylib',
  'libllama-server-impl.dylib',
  'libllama.0.dylib',
  'libmtmd.0.dylib'
]

/** Le dylib richieste col nome CORTO sono symlink alla versione lunga. */
const SYMLINKS: Record<string, string> = {
  'libggml.0.dylib': 'libggml.0.28.0.dylib',
  'libggml-base.0.dylib': 'libggml-base.0.28.0.dylib',
  'libggml-cpu.0.dylib': 'libggml-cpu.0.28.0.dylib',
  'libggml-blas.0.dylib': 'libggml-blas.0.28.0.dylib',
  'libggml-metal.0.dylib': 'libggml-metal.0.28.0.dylib',
  'libggml-rpc.0.dylib': 'libggml-rpc.0.28.0.dylib',
  'libllama.0.dylib': 'libllama.0.8.0.dylib',
  'libllama-common.0.dylib': 'libllama-common.0.8.0.dylib',
  'libmtmd.0.dylib': 'libmtmd.0.8.0.dylib'
}

/** Un tar.gz con la struttura VERA: cartella llama-b9999/ in cima, i file
 * finti, i symlink .0 -> versione lunga e voci che NON servono (README, tool). */
function makeRealBundle(): { path: string; size: number; sha256: string; src: string } {
  const src = join(ROOT, 'reale-src')
  const dir = join(src, REAL_TAG)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'llama-server'), '#!/bin/sh\n# finto llama-server b9999\nsleep 1\n')
  writeFileSync(join(dir, 'libllama-server-impl.dylib'), 'dylib finta libllama-server-impl (senza versione: file vero)')
  for (const [nome, ver] of Object.entries(SYMLINKS)) {
    writeFileSync(join(dir, ver), `contenuto VERO di ${ver} (b9999)`)
    symlinkSync(ver, join(dir, nome))
  }
  // nel tarball vero ci sono 61 voci: tool e README che NON entrano nel bundle
  writeFileSync(join(dir, 'README.md'), 'non serve nel bundle')
  writeFileSync(join(dir, 'llama-bench'), '#!/bin/sh\n# tool che non serve\n')
  const tarPath = join(ROOT, 'llama-b9999-bin-macos-arm64.tar.gz')
  const r = spawnSync('tar', ['-czf', tarPath, '-C', src, REAL_TAG])
  if (r.status !== 0) throw new Error('tar finto non creato: ' + r.stderr)
  const buf = readFileSync(tarPath)
  return { path: tarPath, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), src: dir }
}

const REALE = makeRealBundle()
const URL_REALE = 'https://github.com/ggml-org/llama.cpp/releases/download/b9999/llama-b9999-bin-macos-arm64.tar.gz'
const pinReale = () => ({
  url: URL_REALE,
  asset: 'llama-b9999-bin-macos-arm64.tar.gz',
  size: REALE.size,
  sha256: REALE.sha256
})
const fetchReale = (url: string) => {
  if (url !== URL_REALE) {
    return Promise.resolve({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })
  }
  const buf = readFileSync(REALE.path)
  return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) })
}

// Gli output di otool, copiati dal formato VERO (b12061): llama-server
// dipende da 10 dylib TUTTE @rpath/, l'unico LC_RPATH è @loader_path e
// /usr/lib/librdma.dylib (solo dipendenza esterna) è weak.

/** otool -L di llama-server: 10 dylib @rpath + le librerie di sistema. */
const OTOOL_LL_SERVER = `llama-server:
	@rpath/libllama-server-impl.dylib (compatibility version 0.0.0, current version 0.0.0)
	@rpath/libllama-common.0.dylib (compatibility version 0.0.0, current version 0.0.0)
	@rpath/libllama.0.dylib (compatibility version 0.0.0, current version 0.0.0)
	@rpath/libmtmd.0.dylib (compatibility version 0.0.0, current version 0.0.0)
	@rpath/libggml.0.dylib (compatibility version 0.0.0, current version 0.0.0)
	@rpath/libggml-base.0.dylib (compatibility version 0.0.0, current version 0.0.0)
	@rpath/libggml-cpu.0.dylib (compatibility version 0.0.0, current version 0.0.0)
	@rpath/libggml-blas.0.dylib (compatibility version 0.0.0, current version 0.0.0)
	@rpath/libggml-metal.0.dylib (compatibility version 0.0.0, current version 0.0.0)
	@rpath/libggml-rpc.0.dylib (compatibility version 0.0.0, current version 0.0.0)
	/usr/lib/libc++.1.dylib (compatibility version 9.0.0, current version 900.4.0)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1319.100.3)
`

const SISTEMA = '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1319.100.3)'

/** otool -L di una dylib: dipendenze @rpath (tutte DENTRO la chiusura) e di sistema. */
const dylibL = (name: string, rpathDeps: string[], altre: string[] = []): string =>
  [`${name}:`, ...rpathDeps.map((d) => `\t@rpath/${d} (compatibility version 0.0.0, current version 0.0.0)`), ...altre, SISTEMA].join('\n') + '\n'

const DYLIB_DEPS: Record<string, string> = {
  'libllama-server-impl.dylib': dylibL('libllama-server-impl.dylib', ['libllama.0.dylib', 'libllama-common.0.dylib', 'libggml.0.dylib', 'libggml-base.0.dylib']),
  'libllama-common.0.dylib': dylibL('libllama-common.0.dylib', ['libllama.0.dylib', 'libggml.0.dylib', 'libggml-base.0.dylib']),
  'libllama.0.dylib': dylibL('libllama.0.dylib', ['libggml.0.dylib', 'libggml-base.0.dylib', 'libggml-cpu.0.dylib', 'libmtmd.0.dylib']),
  'libmtmd.0.dylib': dylibL('libmtmd.0.dylib', ['libggml.0.dylib', 'libggml-base.0.dylib']),
  'libggml.0.dylib': dylibL('libggml.0.dylib', ['libggml-base.0.dylib']),
  'libggml-base.0.dylib': dylibL('libggml-base.0.dylib', []),
  'libggml-cpu.0.dylib': dylibL('libggml-cpu.0.dylib', ['libggml-base.0.dylib']),
  'libggml-blas.0.dylib': dylibL('libggml-blas.0.dylib', ['libggml-base.0.dylib'], ['\t/System/Library/Frameworks/Accelerate.framework/Versions/A/Accelerate (compatibility version 1.0.0, current version 4.0.0)']),
  // l'unica dipendenza ESTERNA della chiusura: librdma, di sistema, WEAK
  'libggml-metal.0.dylib': dylibL('libggml-metal.0.dylib', ['libggml-base.0.dylib'], ['\t/usr/lib/librdma.dylib (compatibility version 1.0.0, current version 1.0.0, weak)']),
  'libggml-rpc.0.dylib': dylibL('libggml-rpc.0.dylib', ['libggml-base.0.dylib'])
}

/** otool -l (load commands): l'unico LC_RPATH è @loader_path, come nel vero. */
const OTOOL_L_RPATH = `Load command 32
          cmd LC_RPATH
      cmdsize 32
         path @loader_path (offset 12)
`

/** L'otool del tarball vero: -L dal nome file, -l sempre LC_RPATH @loader_path.
 * `extraDep` aggiunge a llama-server una dipendenza @rpath in più (per l'errore). */
const otoolReale = (extraDep?: string) => (file: string, flag?: 'L' | 'l'): string => {
  if (flag === 'l') return OTOOL_L_RPATH
  const base = file.split('/').pop() ?? ''
  if (base === 'llama-server') {
    const righe = OTOOL_LL_SERVER.trimEnd().split('\n')
    if (extraDep) righe.splice(1, 0, `\t${extraDep} (compatibility version 0.0.0, current version 0.0.0)`)
    return righe.join('\n') + '\n'
  }
  if (DYLIB_DEPS[base]) return DYLIB_DEPS[base]
  return `${base}:\n${SISTEMA}\n`
}

describe('fase fetch-llama sul tarball vero (RS1): cartella radice, @rpath, symlink', () => {
  it('estrae ESATTAMENTE le 11 voci della chiusura da llama-b9999/ (@rpath con LC_RPATH @loader_path)', async () => {
    const target = join(ROOT, 'vendor-reale')
    const r = await fetchLlamaBundle({ pin: pinReale(), fetchImpl: fetchReale, otool: otoolReale(), targetDir: target })
    expect(r.files).toEqual([...CHIUSURA].sort())
    expect(readdirSync(target).sort()).toEqual([...CHIUSURA].sort())
    // le versioni lunghe, i tool e il README NON entrano nel bundle
    expect(existsSync(join(target, 'libggml.0.28.0.dylib'))).toBe(false)
    expect(existsSync(join(target, 'libllama.0.8.0.dylib'))).toBe(false)
    expect(existsSync(join(target, 'README.md'))).toBe(false)
    expect(existsSync(join(target, 'llama-bench'))).toBe(false)
    // llama-server resta ESEGUIBILE
    expect(statSync(join(target, 'llama-server')).mode & 0o111).not.toBe(0)
    expect(r.bytes).toBeGreaterThan(0)
  })

  it('niente symlink in vendor: ogni voce è un file VERO col NOME RICHIESTO e il contenuto del puntato', async () => {
    const target = join(ROOT, 'vendor-reale-symlink')
    await fetchLlamaBundle({ pin: pinReale(), fetchImpl: fetchReale, otool: otoolReale(), targetDir: target })
    for (const nome of readdirSync(target)) {
      expect(lstatSync(join(target, nome)).isSymbolicLink()).toBe(false)
    }
    expect(readFileSync(join(target, 'libggml.0.dylib')).equals(readFileSync(join(REALE.src, SYMLINKS['libggml.0.dylib'])))).toBe(true)
    expect(readFileSync(join(target, 'libllama.0.dylib')).equals(readFileSync(join(REALE.src, SYMLINKS['libllama.0.dylib'])))).toBe(true)
    // la versione lunga NON è stata copiata accanto: nessuno la cerca
    expect(existsSync(join(target, SYMLINKS['libggml.0.dylib']))).toBe(false)
  })

  it('una dipendenza @rpath che NON si risolve nell\'estratto → errore che NOMINA il file, vendor intatta', async () => {
    const target = join(ROOT, 'vendor-rpath-mancante')
    await expect(fetchLlamaBundle({
      pin: pinReale(), fetchImpl: fetchReale, otool: otoolReale('@rpath/libmanca.0.dylib'), targetDir: target
    })).rejects.toThrow(/libmanca\.0\.dylib/)
    expect(existsSync(target)).toBe(false)
  })

  it('llama-server né alla radice né nell\'unica cartella in cima → errore che NOMINA il percorso cercato', async () => {
    const src = join(ROOT, 'senza-server-src')
    mkdirSync(join(src, REAL_TAG), { recursive: true })
    writeFileSync(join(src, REAL_TAG, 'README.md'), 'niente eseguibile qui')
    const tarPath = join(ROOT, 'llama-b9999-senza-server.tar.gz')
    const r = spawnSync('tar', ['-czf', tarPath, '-C', src, REAL_TAG])
    if (r.status !== 0) throw new Error('tar finto non creato: ' + r.stderr)
    const buf = readFileSync(tarPath)
    const pin = {
      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9999/llama-b9999-senza-server.tar.gz',
      asset: 'llama-b9999-senza-server.tar.gz',
      size: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex')
    }
    const fetchSenza = (url: string) => {
      if (url !== pin.url) {
        return Promise.resolve({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })
      }
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) })
    }
    const target = join(ROOT, 'vendor-senza-server')
    await expect(fetchLlamaBundle({ pin, fetchImpl: fetchSenza, otool: otoolReale(), targetDir: target }))
      .rejects.toThrow(new RegExp(`cercato[\\s\\S]*${REAL_TAG}/llama-server`))
    expect(existsSync(target)).toBe(false)
  })

  it('il controllo finale: un file in vendor/llama con una dipendenza @rpath che non c\'è → errore che la nomina', async () => {
    const target = join(ROOT, 'vendor-rogue')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'librogue.dylib'), 'dylib messa lì a mano, fuori dalla chiusura')
    const otool = (file: string, flag?: 'L' | 'l'): string => {
      if (file.endsWith('librogue.dylib') && flag !== 'l') {
        return `librogue.dylib:\n\t@rpath/libnope.0.dylib (compatibility version 0.0.0, current version 0.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1319.100.3)\n`
      }
      return otoolReale()(file, flag)
    }
    await expect(fetchLlamaBundle({ pin: pinReale(), fetchImpl: fetchReale, otool, targetDir: target }))
      .rejects.toThrow(/libnope\.0\.dylib/)
  })

  it('il parser otool è QUELLO di verify-release (parseLoadPaths/parseRpaths): nessun secondo parser', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'fetch-llama.mjs'), 'utf8')
    expect(src).toContain('parseLoadPaths')
    expect(src).toContain('parseRpaths')
    expect(src).toMatch(/from\s*['"]\.\/verify-release\.mjs['"]/)
    expect(src).toContain('checkVendorDeps') // il controllo finale È quello di verify-release
    expect(src).not.toMatch(/matchAll/) // la vecchia scansione regex delle dipendenze non c'è più
  })
})

describe('fase locale (L2.1): la nota MIT in THIRD_PARTY_NOTICES.md', () => {
  it('aggiunge la sezione llama.cpp (MIT) una volta sola', () => {
    const notices = join(ROOT, 'THIRD_PARTY_NOTICES.md')
    writeFileSync(notices, '# Third-party notices\n\n## engramma-node\nMIT\n')
    expect(ensureLlamaNotice(notices)).toBe(true)
    const first = readFileSync(notices, 'utf8')
    expect(first).toContain('llama.cpp')
    expect(first.toLowerCase()).toContain('mit')
    // idempotente
    expect(ensureLlamaNotice(notices)).toBe(false)
    expect(readFileSync(notices, 'utf8')).toBe(first)
  })
})

describe('fase locale (L2.1): il pin del repo è quello della spec', () => {
  it('llama-pin.json: tag b12061, asset, dimensione e sha256 fissati', async () => {
    const pin = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'llama-pin.json'), 'utf8'))
    expect(pin.tag).toBe('b12061')
    expect(pin.asset).toBe('llama-b12061-bin-macos-arm64.tar.gz')
    expect(pin.size).toBe(16_542_711)
    expect(pin.sha256).toBe('b107a8373f7af640ff2744521792d3bc4742b9a86e73f52aa8636b30e3e7c554')
    expect(pin.license).toBe('MIT')
    expect(pin.url).toBe('https://github.com/ggml-org/llama.cpp/releases/download/b12061/llama-b12061-bin-macos-arm64.tar.gz')
    // vendor/llama è IGNORATO dal repo (come vendor/engramma: solo il pin si committa)
    const gitignore = readFileSync(join(import.meta.dirname, '..', '..', '.gitignore'), 'utf8')
    expect(gitignore).toMatch(/vendor\/llama/)
  })
})

describe('fase locale (L2.1): il bundle nell\'app impacchettata', () => {
  it('after-pack verifica Resources/vendor/llama/llama-server presente ed eseguibile', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'after-pack.mjs'), 'utf8')
    expect(src).toMatch(/vendor[', ]+['"]llama['"]/)
    expect(src).toContain('llama-server')
    expect(src).toMatch(/mode & 0o111/)
  })

  it('predist e release:local scaricano il bundle prima di impacchettare', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'))
    expect(pkg.scripts.predist).toContain('fetch-llama.mjs')
    expect(pkg.scripts['release:local']).toContain('fetch-llama.mjs')
  })
})
