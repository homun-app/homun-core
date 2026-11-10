// Fase rilascio di prova (RP2): firma e verifica di TUTTO ciò che è nativo
// in Resources/vendor — llama-server, le sue .dylib e il .node di Engramma
// devono avere la firma del team (con hardened runtime) e architettura arm64,
// e ogni @rpath/@loader_path di llama-server deve risolversi DENTRO il
// bundle, mai in /opt/homebrew o /usr/local. Test con exec/otool/codesign
// INIETTABILI su un bundle finto in mkdtemp: niente firma vera, niente rete.
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')
const {
  parseLoadPaths, parseRpaths, checkVendorDeps, collectVendorMachOs, verifyVendorBinaries
} = (await import('../verify-release.mjs')) as {
  parseLoadPaths: (otoolL: string) => string[]
  parseRpaths: (otoolLowerL: string) => string[]
  checkVendorDeps: (o: {
    loads: string[]; rpaths?: string[]; binaryDir: string; contentsPath: string
    exists?: (p: string) => boolean
  }) => string[]
  collectVendorMachOs: (vendorDir: string, fileOf: (f: string) => string) => Promise<string[]>
  verifyVendorBinaries: (o: {
    appPath: string; contentsPath: string; signed: boolean
    exec?: (cmd: string, args: string[]) => { status: number; out: string }
  }) => Promise<{ binaries: Array<{ path: string; arch: string; team: string | null; runtime: boolean | null }> }>
}

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-verify-release-vendor-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

/** Un bundle finto: Resources/vendor con llama-server, una dylib e il .node. */
function makeFakeApp(): { appPath: string; contentsPath: string; vendorDir: string } {
  const appPath = join(ROOT, `Homun-${Math.random().toString(36).slice(2)}.app`)
  const contentsPath = join(appPath, 'Contents')
  const vendorDir = join(contentsPath, 'Resources', 'vendor')
  mkdirSync(join(vendorDir, 'llama'), { recursive: true })
  mkdirSync(join(vendorDir, 'engramma'), { recursive: true })
  writeFileSync(join(vendorDir, 'llama', 'llama-server'), 'binario finto')
  writeFileSync(join(vendorDir, 'llama', 'libllama.dylib'), 'dylib finta')
  writeFileSync(join(vendorDir, 'engramma', 'engramma.darwin-arm64.node'), 'modulo finto')
  writeFileSync(join(vendorDir, 'engramma', 'index.js'), 'module.exports = {}') // NON Mach-O
  return { appPath, contentsPath, vendorDir }
}

const TEAM_APP = 'TEAMAPP1'
const OTOOL_LLAMA = `llama-server:
	@loader_path/libllama.dylib (compatibility version 0.0.0, current version 0.0.0)
	/usr/lib/libc++.1.dylib (compatibility version 9.0.0.0, current version 900.4.0)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1319.100.3)`
const OTOOL_L_LLAMA = `Load command 21
          cmd LC_RPATH
      cmdsize 32
         path @loader_path/../Frameworks (offset 12)
Load command 22
          cmd LC_LOAD_DYLIB
      cmdsize 96
         name /usr/lib/libc++.1.dylib (offset 24)`

/**
 * L'exec finto: risponde a file/codesign/otool per i binari finti del
 * bundle. `over` altera le risposte per i casi d'errore; `calls` registra.
 */
function fakeExec(bundle: { appPath: string; contentsPath: string; vendorDir: string }, over: {
  file?: (rel: string) => string
  verifyFails?: (rel: string) => boolean
  teamOf?: (rel: string) => string
  runtime?: boolean
  otoolL?: string
  otoolLowerL?: string
} = {}) {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const exec = (cmd: string, args: string[]): { status: number; out: string } => {
    calls.push({ cmd, args })
    const target = args.find((a) => !a.startsWith('-') && a !== '-b') ?? ''
    const rel = target.startsWith(bundle.vendorDir) ? target.slice(bundle.vendorDir.length + 1) : target
    if (cmd === 'file') {
      const out = over.file?.(rel) ?? (rel === 'engramma/index.js' ? 'ASCII text' : 'Mach-O 64-bit executable arm64')
      return { status: 0, out }
    }
    if (cmd === 'otool' && args.includes('-L')) return { status: 0, out: over.otoolL ?? OTOOL_LLAMA }
    if (cmd === 'otool') return { status: 0, out: over.otoolLowerL ?? OTOOL_L_LLAMA }
    if (cmd === 'codesign' && args.includes('--verify')) {
      return over.verifyFails?.(rel) ? { status: 1, out: 'code object is not signed at all' } : { status: 0, out: '' }
    }
    if (cmd === 'codesign') {
      const team = rel === bundle.appPath ? TEAM_APP : (over.teamOf?.(rel) ?? TEAM_APP)
      const runtime = rel === bundle.appPath ? true : (over.runtime ?? true)
      return {
        status: 0,
        out: `Executable=${rel}\nIdentifier=app.homun.desktop\nTeamIdentifier=${team}\n` +
          `flags=0x2(${runtime ? 'runtime,' : ''}linker-signed)\n`
      }
    }
    return { status: 0, out: '' }
  }
  return { exec, calls }
}

describe('fase rilascio di prova (RP2): i pezzi puri di otool', () => {
  it('parseLoadPaths estrae i percorsi dylib da otool -L (salta la prima riga)', () => {
    expect(parseLoadPaths(OTOOL_LLAMA)).toEqual([
      '@loader_path/libllama.dylib',
      '/usr/lib/libc++.1.dylib',
      '/usr/lib/libSystem.B.dylib'
    ])
  })

  it('parseRpaths estrae SOLO i path degli LC_RPATH da otool -l', () => {
    expect(parseRpaths(OTOOL_L_LLAMA)).toEqual(['@loader_path/../Frameworks'])
  })
})

describe('fase rilascio di prova (RP2): le dipendenze di llama-server dentro il bundle', () => {
  const contents = join(ROOT, 'fake-contents')
  const llamaDir = join(contents, 'Resources', 'vendor', 'llama')

  it('@loader_path che esiste dentro il bundle → ok (le librerie di sistema passano)', () => {
    mkdirSync(llamaDir, { recursive: true })
    const problems = checkVendorDeps({
      loads: ['@loader_path/libllama.dylib', '/usr/lib/libc++.1.dylib'],
      binaryDir: llamaDir,
      contentsPath: contents,
      exists: (p) => p === join(llamaDir, 'libllama.dylib')
    })
    expect(problems).toEqual([])
  })

  it('una dipendenza in /opt/homebrew (o /usr/local) è rifiutata', () => {
    for (const bad of ['/opt/homebrew/opt/foo/lib/libfoo.dylib', '/usr/local/lib/libfoo.dylib']) {
      expect(checkVendorDeps({ loads: [bad], binaryDir: llamaDir, contentsPath: contents, exists: () => false }))
        .toEqual([expect.stringContaining(bad)])
    }
  })

  it('@loader_path che NON esiste → problema che lo nomina', () => {
    const problems = checkVendorDeps({ loads: ['@loader_path/libmanca.dylib'], binaryDir: llamaDir, contentsPath: contents, exists: () => false })
    expect(problems.join('\n')).toMatch(/libmanca\.dylib/)
  })

  it('@rpath risolto con un LC_RPATH relativo che sta dentro il bundle → ok', () => {
    const problems = checkVendorDeps({
      loads: ['@rpath/libllama.dylib'],
      rpaths: ['@loader_path/../Frameworks', '/opt/homebrew/lib'],
      binaryDir: llamaDir,
      contentsPath: contents,
      exists: (p) => p === join(contents, 'Resources', 'vendor', 'Frameworks', 'libllama.dylib')
    })
    expect(problems).toEqual([])
  })

  it('@rpath con LC_RPATH @loader_path SENZA slash (com\'è nel binario vero di llama.cpp) → si risolve nella cartella del binario', () => {
    const problems = checkVendorDeps({
      loads: ['@rpath/libllama.0.dylib', '@rpath/libggml.0.dylib'],
      rpaths: ['@loader_path'],
      binaryDir: llamaDir,
      contentsPath: contents,
      exists: (p) => p === join(llamaDir, 'libllama.0.dylib') || p === join(llamaDir, 'libggml.0.dylib')
    })
    expect(problems).toEqual([])
  })

  it('@rpath che si risolve FUORI dal bundle (via rpath Homebrew) → problema', () => {
    const problems = checkVendorDeps({
      loads: ['@rpath/libllama.dylib'],
      rpaths: ['/opt/homebrew/lib'],
      binaryDir: llamaDir,
      contentsPath: contents,
      exists: (p) => p === '/opt/homebrew/lib/libllama.dylib'
    })
    expect(problems.join('\n')).toMatch(/FUORI dal bundle.*\/opt\/homebrew/)
  })

  it('@rpath senza alcun rpath → non si risolve', () => {
    expect(checkVendorDeps({ loads: ['@rpath/libx.dylib'], binaryDir: llamaDir, contentsPath: contents, exists: () => false }).join('\n'))
      .toMatch(/non si risolve/)
  })
})

describe('fase rilascio di prova (RP2): ogni Mach-O sotto Resources/vendor', () => {
  it('collectVendorMachOs trova SOLO i Mach-O (relativi a vendor), saltando i file di testo', async () => {
    const { vendorDir } = makeFakeApp()
    const machos = await collectVendorMachOs(vendorDir, (f) =>
      f.endsWith('index.js') ? 'ASCII text' : f.endsWith('.dylib') ? 'Mach-O 64-bit dynamically linked shared library arm64' : 'Mach-O 64-bit executable arm64'
    )
    expect(machos.sort()).toEqual([
      'engramma/engramma.darwin-arm64.node',
      'llama/libllama.dylib',
      'llama/llama-server'
    ])
  })

  it('firmata e tutto a posto: nessun problema, report con team e runtime', async () => {
    const b = makeFakeApp()
    const { exec } = fakeExec(b)
    const r = await verifyVendorBinaries({ appPath: b.appPath, contentsPath: b.contentsPath, signed: true, exec })
    expect(r.binaries.map((x) => x.arch)).toEqual(['arm64', 'arm64', 'arm64'])
    for (const bin of r.binaries) {
      expect(bin.team).toBe(TEAM_APP)
      expect(bin.runtime).toBe(true)
    }
  })

  it('una dylib NON firmata (codesign --verify fallisce) → errore che la NOMINA', async () => {
    const b = makeFakeApp()
    const { exec } = fakeExec(b, { verifyFails: (rel) => rel === 'llama/libllama.dylib' })
    await expect(verifyVendorBinaries({ appPath: b.appPath, contentsPath: b.contentsPath, signed: true, exec }))
      .rejects.toThrow(/libllama\.dylib[\s\S]*codesign --verify/)
  })

  it('Team ID diverso da quello dell\'app → errore con entrambi', async () => {
    const b = makeFakeApp()
    const { exec } = fakeExec(b, { teamOf: () => 'ALTRO00' })
    await expect(verifyVendorBinaries({ appPath: b.appPath, contentsPath: b.contentsPath, signed: true, exec }))
      .rejects.toThrow(/ALTRO00[\s\S]*TEAMAPP1|TEAMAPP1[\s\S]*ALTRO00/)
  })

  it('hardened runtime ASSENTE → errore', async () => {
    const b = makeFakeApp()
    const { exec } = fakeExec(b, { runtime: false })
    await expect(verifyVendorBinaries({ appPath: b.appPath, contentsPath: b.contentsPath, signed: true, exec }))
      .rejects.toThrow(/runtime/)
  })

  it('architettura x86_64 → errore che la nomina', async () => {
    const b = makeFakeApp()
    const { exec } = fakeExec(b, { file: (rel) => (rel === 'llama/llama-server' ? 'Mach-O 64-bit executable x86_64' : 'Mach-O 64-bit executable arm64') })
    await expect(verifyVendorBinaries({ appPath: b.appPath, contentsPath: b.contentsPath, signed: true, exec }))
      .rejects.toThrow(/llama-server[\s\S]*x86_64|x86_64[\s\S]*llama-server/)
  })

  it('una dipendenza Homebrew nell\'otool di llama-server → errore che la nomina', async () => {
    const b = makeFakeApp()
    const { exec } = fakeExec(b, {
      otoolL: `llama-server:\n\t/opt/homebrew/opt/ggml/lib/libggml.dylib (compatibility version 0.0.0)\n\t/usr/lib/libc++.1.dylib`
    })
    await expect(verifyVendorBinaries({ appPath: b.appPath, contentsPath: b.contentsPath, signed: true, exec }))
      .rejects.toThrow(/\/opt\/homebrew/)
  })

  it('NON firmata: NESSUNA chiamata codesign, ma architettura e otool si controllano lo stesso', async () => {
    const b = makeFakeApp()
    const { exec, calls } = fakeExec(b)
    const r = await verifyVendorBinaries({ appPath: b.appPath, contentsPath: b.contentsPath, signed: false, exec })
    expect(calls.filter((c) => c.cmd === 'codesign')).toEqual([])
    expect(calls.some((c) => c.cmd === 'otool')).toBe(true)
    expect(r.binaries.map((x) => x.team)).toEqual([null, null, null])
    // e un binario x86_64 viene beccato anche senza firma
    const b2 = makeFakeApp()
    const bad = fakeExec(b2, { file: (rel) => (rel === 'llama/llama-server' ? 'Mach-O 64-bit executable x86_64' : 'Mach-O 64-bit executable arm64') })
    await expect(verifyVendorBinaries({ appPath: b2.appPath, contentsPath: b2.contentsPath, signed: false, exec: bad.exec }))
      .rejects.toThrow(/x86_64/)
  })
})

describe('fase rilascio di prova (RP2): il CLI e la firma di electron-builder', () => {
  it('verify-release.mjs chiama verifyVendorBinaries e guarda otool di llama-server', () => {
    const src = readFileSync(join(REPO, 'scripts', 'verify-release.mjs'), 'utf8')
    expect(src).toContain('verifyVendorBinaries')
    expect(src).toMatch(/otool/)
    // il vecchio blocco solo-engramma non c'è più: la verifica è per OGNI Mach-O
    expect(src).toContain('collectVendorMachOs')
  })

  it('i binari vendor NON si aggiungono a mac.binaries: li firma già @electron/osx-sign', () => {
    // app-builder-lib → @electron/osx-sign signApplication: walkAsync di TUTTO
    // Contents raccoglie ogni file binario (Mach-O incluso) e lo firma con
    // entitlementsInherit + hardened runtime. mac.binaries resterebbe un doppione.
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    expect(pkg.build.mac?.binaries).toBeUndefined()
  })
})
void existsSync
