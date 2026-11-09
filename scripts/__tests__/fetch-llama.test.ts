// Fase locale (L2.1): fetch-llama.mjs — scarica l'asset UFFICIALE fissato in
// scripts/llama-pin.json, verifica sha256 e dimensione, estrae in vendor/llama/
// SOLO llama-server e le dylib che gli servono (otool -L). Tutto con un TAR
// FINTO in mkdtemp e fetch/otool iniettati: nessun download vero (rete vietata).
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { fetchLlamaBundle, ensureLlamaNotice } = (await import('../fetch-llama.mjs')) as {
  fetchLlamaBundle: (o: {
    pin: { url: string; size: number; sha256: string; asset: string }
    fetchImpl: (url: string) => Promise<{ ok: boolean; status?: number; arrayBuffer: () => Promise<ArrayBuffer> }>
    otool: (file: string) => string
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

/** otool -L FINTO: llama-server → libllama, libllama → libggml-metal (chiusura transitiva). */
const fakeOtool = (file: string): string => {
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
