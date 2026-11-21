// U6 (fase mcp-ui): chiudere e riaprire Homun funziona SEMPRE. La decisione
// PURA del second-instance (con il flag d'uscita → relaunch; senza → finestra)
// e le guardie sul wiring del main: il registro del ciclo di vita attivo, le
// righe attese (boot, lock, second-instance, finestra, before-quit, will-quit,
// quit con la durata), il tray distrutto e la PiP chiusa all'uscita, NESSUNA
// attesa sul daemon (resta acceso per scelta), e il gancio di prova per ⌘Q.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { secondInstanceWhileQuitting } from '../quit-behavior'

const INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
const IPC = readFileSync(fileURLToPath(new URL('../ipc.ts', import.meta.url)), 'utf8')
const TRAY = readFileSync(fileURLToPath(new URL('../tray.ts', import.meta.url)), 'utf8')
const PRELOAD = readFileSync(fileURLToPath(new URL('../../preload/index.ts', import.meta.url)), 'utf8')

describe('U6: second-instance mentre l\'app sta uscendo → relaunch', () => {
  it('con il flag di uscita: RELAUNCH (la copia nuova mostra la finestra)', () => {
    expect(secondInstanceWhileQuitting(true)).toBe('relaunch')
  })

  it('senza flag: la finestra principale (W1, come sempre)', () => {
    expect(secondInstanceWhileQuitting(false)).toBe('show-main-window')
  })
})

describe('U6: il wiring del ciclo di vita nel main (guardie sul sorgente)', () => {
  it('il registro del ciclo di vita c\'è e sta in mainLogDir (probe: temporanea)', () => {
    expect(INDEX).toMatch(/createLifecycleLog\(mainLogDir\(/)
    expect(INDEX).toMatch(/from '\.\/lifecycle-log'/)
  })

  it('le righe attese: boot (pid, versione), lock, second-instance (col flag), finestra creata/mostrata/chiusa, before-quit, will-quit, quit con la durata', () => {
    expect(INDEX).toMatch(/line\('boot'/)
    expect(INDEX).toMatch(/line\(gotTheLock \? 'lock' : 'lock-denied'\)/)
    expect(INDEX).toMatch(/line\('second-instance'/)
    expect(INDEX).toMatch(/line\('window-created'/)
    expect(INDEX).toMatch(/line\('window-shown'/)
    expect(INDEX).toMatch(/line\('window-closed'/)
    expect(INDEX).toMatch(/line\('before-quit'/)
    expect(INDEX).toMatch(/line\('will-quit'/)
    expect(INDEX).toMatch(/line\('quit'/)
    expect(INDEX).toMatch(/exit-ms/)
  })

  it('uscita VELOCE: in before-quit il tray si DISTRUGGE e la PiP si chiude; NESSUNA attesa sul daemon', () => {
    const at = INDEX.indexOf("app.on('before-quit'")
    const block = INDEX.slice(at, INDEX.indexOf("app.on('will-quit'", at))
    expect(block).toMatch(/destroyTray\(\)/)
    expect(block).toMatch(/pip\??\.close\(\)/)
    expect(block).not.toMatch(/waitDaemonExit|stopRunningDaemon/)
  })

  it('second-instance che sta uscendo chiama app.relaunch() PRIMA di finire di uscire', () => {
    const at = INDEX.indexOf("app.on('second-instance'")
    const block = INDEX.slice(at, INDEX.indexOf('\n    })', at) + 6)
    expect(block).toMatch(/secondInstanceWhileQuitting/)
    expect(block).toMatch(/app\.relaunch\(\)/)
    expect(block).toMatch(/showMainWindow\(\)/)
  })

  it('il tray espone destroyTray (l\'icona non sopravvive all\'uscita)', () => {
    expect(TRAY).toMatch(/export function destroyTray/)
    expect(TRAY).toMatch(/tray\??\.destroy\(\)/)
  })

  it('il gancio di prova per ⌘Q: test:emit-quit SOLO con SANDBOT_TEST_USER_DATA (come test:emit-activate, in ipc.ts)', () => {
    expect(IPC).toContain("'test:emit-quit'")
    expect(IPC).toMatch(/SANDBOT_TEST_USER_DATA/)
    expect(PRELOAD).toMatch(/testEmitQuit/)
    expect(PRELOAD).toMatch(/'test:emit-quit'/)
  })
})
