// Fase rilascio — correzioni (K3): il contratto del NOME dell'app, letto dal
// package.json che Electron usa in sviluppo (app.getName() deriva da
// productName di primo livello; build.productName basta solo all'impacchettato).
// Test PURO su file: niente Electron, niente rete.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
  productName?: string
  name: string
  build: { productName?: string; executableName?: string; mac?: { icon?: string; extendInfo?: Record<string, string>; executableName?: string } }
}

describe('fase rilascio — correzioni (K3): il nome dell app', () => {
  it('productName "Homun" a livello RADICE: in sviluppo app.getName() è Homun', () => {
    // Electron: app.getName() = productName di primo livello se presente
    // (il campo dentro build vale solo per l'impacchettatore). Senza questo,
    // in sviluppo il nome sarebbe "homun" e la voce di safeStorage sarebbe
    // «homun Safe Storage» invece di «Homun Safe Storage»: due chiavi diverse
    // sulla stessa cartella dati (il caso di K1).
    expect(pkg.productName).toBe('Homun')
    expect(pkg.build.productName).toBe('Homun')
  })

  it('NESSUN executableName: rinominerebbe anche la CARTELLA .app in homun.app', () => {
    // electron-builder: productFilename = executableName ?? productName —
    // con executableName "homun" il bundle nasceva homun.app (minuscolo) e
    // copiato in /Applications sostituirebbe Homun.app di Homun 2
    expect(pkg.build.executableName).toBeUndefined()
    expect(pkg.build.mac?.executableName).toBeUndefined()
  })

  it('l icona di build.mac è quella di Homun (build/icon.png)', () => {
    expect(pkg.build.mac?.icon).toBe('build/icon.png')
    expect(pkg.name).toBe('homun') // il modulo npm non cambia
  })

  it('NESSUNA descrizione microfono/camera in extendInfo (funzioni inesistenti, A5 nega i permessi)', () => {
    const extend = pkg.build.mac?.extendInfo ?? {}
    expect(Object.keys(extend)).not.toContain('NSMicrophoneUsageDescription')
    expect(Object.keys(extend)).not.toContain('NSCameraUsageDescription')
  })

  it('la cartella dati resta sandbot qualunque sia il nome dell\'app (paths.ts la fissa)', async () => {
    const { userDataDir } = await import('../paths')
    expect(userDataDir('Homun', '/Users/x/Library/Application Support')).toBe('/Users/x/Library/Application Support/sandbot')
  })
})
