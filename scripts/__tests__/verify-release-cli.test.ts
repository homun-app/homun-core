// Fase verify-release CLI (RT1): la CLI di verify-release.mjs non era mai
// arrivata in fondo dopo RP2. Due bug: main() chiamava verifyVendorBinaries
// con `contentsPath`, variabile che lì NON esiste (si chiama `contents`) —
// il try/catch trasformava il ReferenceError in un exit 1 per qualunque
// bundle; e con APP_PATH relativo (in CI esce da `find dist-installers …`)
// checkVendorDeps confrontava i candidati, assoluti perché nati da
// path.resolve, con un contentsPath relativo: ogni dipendenza risultava
// «FUORI dal bundle». Qui la CLI si lancia DAVVERO (spawnSync di node) su un
// Homun.app minimo in mkdtemp, con percorso RELATIVO (cwd = la cartella del
// bundle) e ASSOLUTO (da un cwd diverso): il fixture passa tutto ciò che
// viene prima del passo vendor e si ferma lì («nessun binario Mach-O sotto
// …»), il punto più lontano che un bundle senza Mach-O raggiunge — e il
// percorso nel messaggio dev'essere ASSOLUTO, perché la normalizzazione sta
// all'ingresso. Nessuna firma e nessuna rete: i binari sono finti e --signed
// serve solo a saltare il confronto dell'hash di Engramma col lock VERO
// del repo (che un .node finto non può matchare).
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO, 'scripts', 'verify-release.mjs')
// la versione attesa dalla CLI è quella del package.json del repo (default)
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-verify-release-cli-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

/**
 * Un Homun.app minimo che passa TUTTI i controlli prima del passo vendor:
 * nome esatto, eseguibile, app.asar, Info.plist (bundle id, versione del
 * repo, icona presente, nessuna NS*UsageDescription), .node di Engramma al
 * suo posto. NESSUN Mach-O sotto vendor: la CLI deve fermarsi al passo
 * vendor con «nessun binario Mach-O sotto …».
 */
function makeMinimalApp(): string {
  const appPath = join(ROOT, 'Homun.app')
  const contents = join(appPath, 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  mkdirSync(join(contents, 'Resources', 'vendor', 'engramma'), { recursive: true })
  writeFileSync(join(contents, 'MacOS', 'Homun'), 'eseguibile finto (non Mach-O)')
  writeFileSync(join(contents, 'Resources', 'app.asar'), 'asar finto')
  writeFileSync(join(contents, 'Resources', 'icona-di-homun.icns'), 'icns finto')
  writeFileSync(join(contents, 'Resources', 'vendor', 'engramma', 'engramma.darwin-arm64.node'), 'modulo nativo finto (non Mach-O)')
  writeFileSync(
    join(contents, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '  <key>CFBundleIdentifier</key><string>app.homun.desktop</string>',
      `  <key>CFBundleShortVersionString</key><string>${VERSION}</string>`,
      '  <key>CFBundleIconFile</key><string>icona-di-homun.icns</string>',
      '</dict>',
      '</plist>'
    ].join('\n')
  )
  return appPath
}

/** La CLI lanciata davvero: node scripts/verify-release.mjs <appPath> --signed. */
function runCli(appArg: string, cwd: string) {
  return spawnSync(process.execPath, [SCRIPT, appArg, '--signed'], { encoding: 'utf8', cwd })
}

describe('fase verify-release CLI (RT1): la CLI arriva al passo vendor, con percorso relativo o assoluto', () => {
  const appPath = makeMinimalApp()
  const vendorDir = resolve(join(appPath, 'Contents', 'Resources', 'vendor'))

  it('percorso RELATIVO (cwd = cartella del bundle): niente ReferenceError, errore del passo vendor col percorso ASSOLUTO', () => {
    const r = runCli('Homun.app', ROOT)
    // esce 1 (die), ma NON per il ReferenceError di contentsPath
    expect(r.status).toBe(1)
    expect(r.stderr).not.toMatch(/is not defined/)
    // l'errore è quello del passo vendor, e il percorso nel messaggio è
    // assoluto: la normalizzazione sta all'ingresso di main()/verifyVendorBinaries
    expect(r.stderr).toMatch(/verify-release: nessun binario Mach-O sotto/)
    expect(r.stderr).toContain(vendorDir)
  })

  it('percorso ASSOLUTO (da un cwd diverso): stesso esito', () => {
    const r = runCli(appPath, REPO)
    expect(r.status).toBe(1)
    expect(r.stderr).not.toMatch(/is not defined/)
    expect(r.stderr).toMatch(/verify-release: nessun binario Mach-O sotto/)
    expect(r.stderr).toContain(vendorDir)
  })
})
