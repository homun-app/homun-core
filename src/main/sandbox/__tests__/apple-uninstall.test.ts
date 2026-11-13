// OB5 (fase onboarding-b) + OBR2 (fase onboarding-b-rafforzamenti): la
// guardia sullo script di disinstallazione di Apple. La password del Mac
// non si dà MAI a un file (o a una cartella) che chiunque può riscrivere:
// lo script deve essere un FILE REGOLARE di root:wheel senza scrittura per
// gruppo o altri (un collegamento simbolico superava la guardia di OB5:
// i permessi di un symlink su macOS sono lrwxr-xr-x), e anche le cartelle
// /usr/local/bin e /usr/local devono essere di root e non scrivibili da
// gruppo o altri (una cartella scrivibile permette di sostituire lo script
// FRA il controllo e l'esecuzione). Il comando osascript resta FISSO (una
// costante, mai composto con dati); quello MANUALE («sudo … -d») è testo da
// copiare, MAI eseguito da Homun.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'
import {
  uninstallScriptGuardOk, uninstallScriptStat, uninstallGuardFacts,
  setUninstallStatProbeForTests,
  UNINSTALL_OSASCRIPT_ARGV, UNINSTALL_CONTAINER_SCRIPT,
  UNINSTALL_SCRIPT_DIR, UNINSTALL_SCRIPT_PARENT_DIR, UNINSTALL_MANUAL_COMMAND
} from '../apple-uninstall'

/** lo stat di un file regolare in regola (tutti i campi iniettabili). */
const fileStat = (over: Partial<ReturnType<typeof uninstallScriptStat>> = {}) =>
  ({ exists: true, isFile: true, isDirectory: false, uid: 0, gid: 0, mode: 0o755, ...over })

/** lo stat di una cartella in regola. */
const dirStat = (over: Partial<ReturnType<typeof uninstallScriptStat>> = {}) =>
  ({ exists: true, isFile: false, isDirectory: true, uid: 0, gid: 0, mode: 0o755, ...over })

/** i fatti della guardia con script, /usr/local/bin e /usr/local in regola. */
const facts = (over: Partial<ReturnType<typeof uninstallGuardFacts>> = {}) =>
  ({ script: fileStat(), dir: dirStat(), parentDir: dirStat(), ...over })

describe('OBR2: la guardia (pura) su script E cartelle', () => {
  it('tutto in regola → si può: file regolare root:wheel, cartelle di root', () => {
    expect(uninstallScriptGuardOk(facts())).toEqual({ ok: true, reason: null })
    expect(uninstallScriptGuardOk(facts({ script: fileStat({ mode: 0o700 }) }))).toEqual({ ok: true, reason: null })
    expect(uninstallScriptGuardOk(facts({ script: fileStat({ mode: 0o555 }) }))).toEqual({ ok: true, reason: null })
  })

  it('script ASSENTE → niente osascript', () => {
    expect(uninstallScriptGuardOk(facts({ script: fileStat({ exists: false }) }))).toEqual({ ok: false, reason: 'missing' })
    expect(uninstallScriptGuardOk(facts({ script: null }))).toEqual({ ok: false, reason: 'missing' })
  })

  it('SYMLINK → no, con il motivo not-regular (i permessi di un symlink sono lrwxr-xr-x: la guardia di OB5 la faceva passare)', () => {
    // come lstat vede un collegamento simbolico di root che punta a un file
    // scrivibile dall'utente: non è un file regolare
    const symlink = fileStat({ isFile: false, isDirectory: false, mode: 0o777 })
    expect(uninstallScriptGuardOk(facts({ script: symlink }))).toEqual({ ok: false, reason: 'not-regular' })
  })

  it('file NON regolare (una fifo, una socket) → no, not-regular', () => {
    expect(uninstallScriptGuardOk(facts({ script: fileStat({ isFile: false }) }))).toEqual({ ok: false, reason: 'not-regular' })
  })

  it('script NON di root (o non di wheel) → no', () => {
    expect(uninstallScriptGuardOk(facts({ script: fileStat({ uid: 501 }) }))).toEqual({ ok: false, reason: 'not-root' })
    expect(uninstallScriptGuardOk(facts({ script: fileStat({ gid: 20 }) }))).toEqual({ ok: false, reason: 'not-root' })
  })

  it('script SCRIVIBILE da gruppo o da altri → no', () => {
    expect(uninstallScriptGuardOk(facts({ script: fileStat({ mode: 0o775 }) }))).toEqual({ ok: false, reason: 'writable' })
    expect(uninstallScriptGuardOk(facts({ script: fileStat({ mode: 0o757 }) }))).toEqual({ ok: false, reason: 'writable' })
  })

  it('/usr/local/bin SCRIVIBILE da gruppo o altri → no (lo script si sostituirebbe fra controllo ed esecuzione)', () => {
    expect(uninstallScriptGuardOk(facts({ dir: dirStat({ mode: 0o775 }) }))).toEqual({ ok: false, reason: 'writable' })
    expect(uninstallScriptGuardOk(facts({ dir: dirStat({ mode: 0o757 }) }))).toEqual({ ok: false, reason: 'writable' })
  })

  it('/usr/local/bin NON di root → no', () => {
    expect(uninstallScriptGuardOk(facts({ dir: dirStat({ uid: 501 }) }))).toEqual({ ok: false, reason: 'not-root' })
  })

  it('anche /usr/local: scrivibile o non di root → no; assente → missing', () => {
    expect(uninstallScriptGuardOk(facts({ parentDir: dirStat({ mode: 0o775 }) }))).toEqual({ ok: false, reason: 'writable' })
    expect(uninstallScriptGuardOk(facts({ parentDir: dirStat({ uid: 501 }) }))).toEqual({ ok: false, reason: 'not-root' })
    expect(uninstallScriptGuardOk(facts({ parentDir: dirStat({ exists: false }) }))).toEqual({ ok: false, reason: 'missing' })
    expect(uninstallScriptGuardOk(facts({ parentDir: null }))).toEqual({ ok: false, reason: 'missing' })
  })

  it('una cartella che non è una cartella VERA (un symlink) → no, not-regular', () => {
    expect(uninstallScriptGuardOk(facts({ dir: dirStat({ isDirectory: false, isFile: true }) }))).toEqual({ ok: false, reason: 'not-regular' })
    expect(uninstallScriptGuardOk(facts({ parentDir: dirStat({ isDirectory: false, isFile: true }) }))).toEqual({ ok: false, reason: 'not-regular' })
  })
})

describe('OBR2: lo stat di produzione NON segue i symlink (lstat)', () => {
  let dir = ''
  let file = ''
  let link = ''
  beforeAll(() => {
    // un file regolare e un collegamento che ci punta: la prova VERA che lo
    // stat di produzione non segue i symlink
    dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-obr2-stat-'))
    file = join(dir, 'uninstall-container.sh')
    link = join(dir, 'uninstall-link.sh')
    writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })
    symlinkSync(file, link)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('il file regolare è un file; il collegamento che ci punta NON è un file regolare', () => {
    const stFile = uninstallScriptStat(file)
    expect(stFile?.exists).toBe(true)
    expect(stFile?.isFile).toBe(true)
    expect(stFile?.isDirectory).toBe(false)
    const stLink = uninstallScriptStat(link)
    expect(stLink?.exists).toBe(true)
    expect(stLink?.isFile).toBe(false) // lstat: il symlink non è un file regolare
    expect(stLink?.isDirectory).toBe(false)
    // e la guardia, con questi fatti, rifiuta il collegamento
    expect(uninstallScriptGuardOk({ script: stLink, dir: dirStat(), parentDir: dirStat() })).toEqual({ ok: false, reason: 'not-regular' })
  })

  it('un percorso che non esiste → null', () => {
    expect(uninstallScriptStat(join(dir, 'non-esiste'))).toBeNull()
  })


  it('i fatti di produzione guardano script, /usr/local/bin e /usr/local', () => {
    expect(UNINSTALL_CONTAINER_SCRIPT).toBe('/usr/local/bin/uninstall-container.sh')
    expect(UNINSTALL_SCRIPT_DIR).toBe('/usr/local/bin')
    expect(UNINSTALL_SCRIPT_PARENT_DIR).toBe('/usr/local')
    const asked: string[] = []
    setUninstallStatProbeForTests((p) => { asked.push(p); return dirStat() })
    const f = uninstallGuardFacts()
    expect(asked).toEqual([UNINSTALL_CONTAINER_SCRIPT, UNINSTALL_SCRIPT_DIR, UNINSTALL_SCRIPT_PARENT_DIR])
    expect(f.script).not.toBeNull()
    expect(f.dir).not.toBeNull()
    expect(f.parentDir).not.toBeNull()
    setUninstallStatProbeForTests(null)
  })
})

describe('OBR2: i due comandi — quello privilegiato FISSO, quello manuale solo testo', () => {
  it('argv fisso di osascript: -e e l\'unica stringa do shell script … with administrator privileges', () => {
    expect(UNINSTALL_OSASCRIPT_ARGV).toEqual(['-e', 'do shell script "/usr/local/bin/uninstall-container.sh -d" with administrator privileges'])
  })

  it('il comando MANUALE è il testo di Apple da copiare, e NON viene mai eseguito (niente sudo nell\'argv)', () => {
    expect(UNINSTALL_MANUAL_COMMAND).toBe('sudo /usr/local/bin/uninstall-container.sh -d')
    expect(UNINSTALL_OSASCRIPT_ARGV.join(' ')).not.toContain('sudo')
  })
})
