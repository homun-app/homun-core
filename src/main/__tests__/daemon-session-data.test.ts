// P3.1 (fase primo-avvio): il profilo Chromium del daemon è SEPARATO da
// quello della UI. Fino a qui UI e daemon — due processi Chromium dello
// stesso eseguibile — aprivano gli stessi dati in userData (lsof, nella
// riproduzione: il daemon teneva aperti GraphiteDawnCache/index e data_0…3
// insieme alla UI). Electron ≥ 20 stacca i dati di Chromium da userData con
// app.setPath('sessionData', …) PRIMA di whenReady. Qui: la cartella (pura)
// e le guardie del cablaggio — con il daemon sessionData ≠ userData, con la
// UI invariato: i dati di Homun non si spostano.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { daemonSessionDataDir, DAEMON_SESSION_DIR } from '../mode'
import { userDataDir } from '../paths'

const INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')

describe('P3.1: la cartella di Chromium del daemon', () => {
  it('è una cartella sua DENTRO userData: userData resta dov\'è (i dati di Homun non si spostano)', () => {
    const userData = join('/Users/test', 'Library', 'Application Support', 'sandbot')
    const sessionData = daemonSessionDataDir(userData)
    expect(sessionData).not.toBe(userData)
    expect(dirname(sessionData)).toBe(userData)
    expect(sessionData.endsWith(`/${DAEMON_SESSION_DIR}`)).toBe(true)
  })

  it('vale anche nelle prove (SANDBOT_TEST_USER_DATA): la cartella del daemon sta nella temporanea', () => {
    const userData = userDataDir('Homun', '/Users/test/Library/Application Support', { SANDBOT_TEST_USER_DATA: '/T/sonda' } as NodeJS.ProcessEnv)
    expect(daemonSessionDataDir(userData)).toBe(join('/T/sonda', DAEMON_SESSION_DIR))
  })
})

describe('P3.1: il cablaggio nel main (guardie sul sorgente)', () => {
  const daemonAt = INDEX.indexOf('if (isDaemonMode(process.argv)) {')
  const daemon = INDEX.slice(daemonAt, INDEX.indexOf('} else {', daemonAt))
  const ui = INDEX.slice(INDEX.indexOf('} else {', daemonAt))

  it('in modalità daemon sessionData si fissa PRIMA di whenReady (dopo va bene solo userData)', () => {
    const fix = daemon.indexOf("app.setPath('sessionData', daemonSessionDataDir(app.getPath('userData')))")
    expect(fix, 'il daemon fissa sessionData').toBeGreaterThan(-1)
    expect(fix).toBeLessThan(daemon.indexOf('app.whenReady()'))
  })

  it('userData si fissa PRIMA di sessionData (la cartella del daemon sta dentro quella vera)', () => {
    expect(INDEX.indexOf("app.setPath('userData'")).toBeLessThan(INDEX.indexOf("app.setPath('sessionData'"))
  })

  it('la UI è INVARIATA: non tocca sessionData (i suoi dati restano in userData)', () => {
    expect(ui).not.toContain("setPath('sessionData'")
  })
})
