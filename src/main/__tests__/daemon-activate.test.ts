// P3.6 (fase primo-avvio): la radice trovata nella riproduzione di P2. UI e
// daemon sono DUE processi dello stesso bundle, e macOS tiene UNA attivazione
// per quell'app. Quando il daemon nasce sotto una UI che non era attiva, il
// sistema considera ATTIVO il daemon (NSRunningApplication: policy regular,
// isActive) — un'app senza finestre — e la UI non riprende il fuoco nemmeno
// con due attivazioni di sistema (3 corse su 3). A quel punto l'icona del
// Dock è del daemon: il clic arriva al processo sbagliato, che oggi lo
// ignora. Il daemon lo INOLTRA: rilancia l'eseguibile della UI — se la UI
// gira, la nuova istanza non prende il lock e consegna il via alla prima
// (second-instance → showMainWindow); se non gira, parte e basta.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createActivateForwarder, uiRelaunchSpec, ACTIVATE_FORWARD_GAP_MS } from '../mode'

const INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')

describe('P3.6: uiRelaunchSpec — come il daemon rilancia la UI (puro)', () => {
  it('nell\'app impacchettata: lo stesso eseguibile, SENZA argomenti (è la UI)', () => {
    expect(uiRelaunchSpec({ execPath: '/Applicazioni/Homun.app/Contents/MacOS/Homun', isPackaged: true, appPath: '/x', env: {} })).toEqual({
      command: '/Applicazioni/Homun.app/Contents/MacOS/Homun',
      args: []
    })
  })

  it('in sviluppo: l\'eseguibile di Electron con il percorso dell\'app (come per il daemon, al contrario)', () => {
    expect(uiRelaunchSpec({ execPath: '/e/Electron', isPackaged: false, appPath: '/repo', env: {} })).toEqual({ command: '/e/Electron', args: ['/repo'] })
  })

  it('MAI --homun-daemon fra gli argomenti (si rilancia la UI, non un secondo daemon)', () => {
    for (const isPackaged of [true, false]) {
      expect(uiRelaunchSpec({ execPath: '/e', isPackaged, appPath: '/repo', env: {} }).args).not.toContain('--homun-daemon')
    }
  })
})

describe('P3.6: createActivateForwarder — un clic inoltrato, i clic ravvicinati no (puro)', () => {
  it('il primo activate rilancia la UI; un altro entro il gap no; dopo il gap sì', () => {
    let now = 10_000
    const launched: number[] = []
    const forward = createActivateForwarder(() => { launched.push(now) }, () => now)
    expect(forward()).toBe(true)
    now += ACTIVATE_FORWARD_GAP_MS - 1
    expect(forward(), 'doppio clic sul Dock: una sola UI').toBe(false)
    now += 1
    expect(forward()).toBe(true)
    expect(launched).toEqual([10_000, 10_000 + ACTIVATE_FORWARD_GAP_MS])
  })
})

describe('P3.6: il cablaggio nel main (guardie sul sorgente)', () => {
  const daemonAt = INDEX.indexOf('if (isDaemonMode(process.argv)) {')
  const daemon = INDEX.slice(daemonAt, INDEX.indexOf('} else {', daemonAt))

  it('in modalità daemon l\'activate si inoltra alla UI, e lo dice nel registro (daemon-activate)', () => {
    const handler = /app\.on\('activate', \(\) => \{[\s\S]*?\n  \}\)/.exec(daemon)?.[0] ?? ''
    expect(handler).toContain("daemonLog.line('daemon-activate')")
    expect(handler).toContain('forwardActivate()')
  })

  it('rilancia con uiRelaunchSpec (staccato, senza ereditare i canali), e non è un handler della UI', () => {
    const launch = /const launchUi = \(\): void => \{[\s\S]*?\n  \}/.exec(daemon)?.[0] ?? ''
    expect(launch).toContain('uiRelaunchSpec({ execPath: process.execPath, isPackaged: app.isPackaged, appPath: app.getAppPath(), env: process.env })')
    expect(launch).toMatch(/detached: true/)
    expect(launch).toMatch(/stdio: 'ignore'/)
    expect(launch).toContain('child.unref()')
    const ui = INDEX.slice(INDEX.indexOf('} else {', daemonAt))
    expect(ui).not.toContain('daemon-activate')
  })
})
