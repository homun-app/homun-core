// OB6 (fase onboarding-b): gli strumenti FINTI dell'installazione — pkgutil
// e spctl rispondono OK o KO a comando (env), il fake open «installa»
// mettendo la CLI finta nel PATH di prova dopo un ritardo. Nessun`pkgutil`
// vero, nessuno `spctl` vero, NESSUN `open` vero: la sonda li pilota.
import { describe, expect, it, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const PKGUTIL = join(ROOT, 'scripts', 'fake-pkgutil.mjs')
const SPCTL = join(ROOT, 'scripts', 'fake-spctl.mjs')
const OPEN = join(ROOT, 'scripts', 'fake-open.mjs')
const TMP = mkdtempSync(join(tmpdir(), 'sandbot-fake-installer-test-'))

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('OB6: pkgutil finto — --check-signature OK o KO a comando', () => {
  it('OK (default): firmato con Developer ID di Apple, catena fidata, la FOGLIA nominata', () => {
    const r = spawnSync(process.execPath, [PKGUTIL, '--check-signature', '/tmp/finto.pkg'], { encoding: 'utf8', env: { PATH: process.env.PATH } })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('signed by a developer certificate issued by Apple for distribution')
    expect(r.stdout).toContain('Developer ID Installer: Apple Inc.')
    expect(r.stdout).toContain('Trusted by the Apple notary service')
  })

  it('KO: esce diverso da 0 e NON dice firmato', () => {
    const r = spawnSync(process.execPath, [PKGUTIL, '--check-signature', '/tmp/finto.pkg'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SANDBOT_TEST_PKGUTIL_RESULT: 'ko' }
    })
    expect(r.status).not.toBe(0)
    expect(r.stdout).not.toContain('signed by a developer certificate')
  })
})

describe('OB6: spctl finto — --assess --type install accettato o rifiutato', () => {
  it('OK (default): esce 0 in silenzio (come il vero)', () => {
    const r = spawnSync(process.execPath, [SPCTL, '--assess', '--type', 'install', '/tmp/finto.pkg'], { encoding: 'utf8', env: { PATH: process.env.PATH } })
    expect(r.status).toBe(0)
  })

  it('KO: esce diverso da 0', () => {
    const r = spawnSync(process.execPath, [SPCTL, '--assess', '--type', 'install', '/tmp/finto.pkg'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SANDBOT_TEST_SPCTL_RESULT: 'ko' }
    })
    expect(r.status).not.toBe(0)
    expect((r.stderr ?? '') + (r.stdout ?? '')).toMatch(/rejected|rejected by/i)
  })
})

describe('OB6: open finto — «installa» la CLI nel PATH di prova, dopo un ritardo', () => {
  it('apre l\'Installer (registra la chiamata), esce SUBITO e installa DOPO, staccato', async () => {
    const binDir = join(TMP, 'bin')
    mkdirSync(binDir, { recursive: true })
    // la CLI finta da «installare»: il wrapper che la sonda prepara
    const cliSrc = join(TMP, 'cli-finta')
    writeFileSync(cliSrc, '#!/bin/sh\nexec finto\n')
    const log = join(TMP, 'open.jsonl')
    const t0 = Date.now()
    const r = spawnSync(process.execPath, [OPEN, '-a', 'Installer', '/tmp/finto.pkg'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SANDBOT_TEST_OPEN_LOG: log,
        SANDBOT_TEST_OPEN_DELAY_MS: '80',
        SANDBOT_TEST_OPEN_CLI_SRC: cliSrc,
        SANDBOT_TEST_OPEN_INSTALL_DIR: binDir
      },
      timeout: 15_000
    })
    expect(r.status).toBe(0)
    // come il VERO open: esce subito, l'utente «installa» dopo un po'
    expect(Date.now() - t0).toBeLessThan(2_000)
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines[0]).toMatchObject({ app: 'Installer', pkg: '/tmp/finto.pkg' })
    // la CLI compare nella cartella del PATH DOPO il ritardo (staccata)
    for (let i = 0; i < 100 && !existsSync(join(binDir, 'container')); i++) {
      await new Promise((res) => setTimeout(res, 40))
    }
    expect(existsSync(join(binDir, 'container'))).toBe(true)
  })

  it('senza le variabili di prova NON fa nulla di strano (esce 0)', () => {
    const r = spawnSync(process.execPath, [OPEN, '-a', 'Installer', '/tmp/finto.pkg'], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 15_000 })
    expect(r.status).toBe(0)
  })
})
