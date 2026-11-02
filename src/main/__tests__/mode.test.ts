// Fase rilascio (A1): il daemon è lo STESSO eseguibile Electron con
// --homun-daemon. Test PURI del parsing degli argomenti e della riga di
// comando costruita per spawnarlo: mai ELECTRON_RUN_AS_NODE, né negli
// argomenti né nell'env (il fuse RunAsNode resta spento nella build).
import { describe, expect, it } from 'vitest'
import { isDaemonMode, resolveDataDirArgv, daemonSpawnSpec, isDaemonCommandLine, isLegacyDaemonCommandLine, DAEMON_FLAG } from '../mode'

describe('fase rilascio (A1): modalità di avvio', () => {
  it('--homun-daemon accende la modalità daemon, senza resta la UI', () => {
    expect(isDaemonMode(['/Applications/Homun.app/Contents/MacOS/Homun', DAEMON_FLAG])).toBe(true)
    expect(isDaemonMode(['/Applications/Homun.app/Contents/MacOS/Homun'])).toBe(false)
    expect(isDaemonMode(['/usr/local/bin/electron', '/Users/x/sandbot', DAEMON_FLAG])).toBe(true)
    // il flag si cerca OVUNQUE in argv: in dev l'app path viene prima
    expect(isDaemonMode(['electron', '.', DAEMON_FLAG, '--other'])).toBe(true)
  })

  it('--data resta accettato per i test (con valore)', () => {
    expect(resolveDataDirArgv(['node', 'daemon.js', '--data', '/tmp/x'])).toBe('/tmp/x')
    expect(resolveDataDirArgv(['node', 'daemon.js'])).toBeNull()
    expect(resolveDataDirArgv(['node', 'daemon.js', '--data'])).toBeNull() // senza valore
  })

  it('riconoscere il processo del daemon dalla riga di comando (per le sonde E2E)', () => {
    expect(isDaemonCommandLine('/Applications/Homun.app/Contents/MacOS/Homun --homun-daemon')).toBe(true)
    expect(isDaemonCommandLine('/opt/electron/Electron.app/Contents/MacOS/Electron /Users/fabio/Projects/Bot/sandbot --homun-daemon')).toBe(true)
    expect(isDaemonCommandLine('/usr/local/bin/node out/main/daemon.js --data /tmp/x')).toBe(false)
  })

  it('riconoscere il daemon VECCHIO (fase ≤16c, daemon.js in ELECTRON_RUN_AS_NODE)', () => {
    expect(isLegacyDaemonCommandLine('/usr/local/bin/node out/main/daemon.js --data /tmp/x')).toBe(true)
    expect(isLegacyDaemonCommandLine('/Applications/Homun.app/Contents/MacOS/Homun --homun-daemon')).toBe(false)
  })
})

describe('fase rilascio (A1): riga di comando del spawn', () => {
  it('impacchettata: solo --homun-daemon (l\'eseguibile porta l\'app con sé)', () => {
    const spec = daemonSpawnSpec({ execPath: '/Applications/Homun.app/Contents/MacOS/Homun', isPackaged: true, appPath: '/ignored', env: {} })
    expect(spec.command).toBe('/Applications/Homun.app/Contents/MacOS/Homun')
    expect(spec.args).toEqual([DAEMON_FLAG])
  })

  it('sviluppo: l\'app path PRIMA del flag (electron <repo> --homun-daemon)', () => {
    const spec = daemonSpawnSpec({ execPath: '/opt/electron/bin/Electron', isPackaged: false, appPath: '/Users/fabio/sandbot', env: {} })
    expect(spec.args).toEqual(['/Users/fabio/sandbot', DAEMON_FLAG])
  })

  it('MAI ELECTRON_RUN_AS_NODE: né negli argomenti né nell\'env', () => {
    const spec = daemonSpawnSpec({
      execPath: '/x/homun', isPackaged: true, appPath: '/y',
      env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:/bin', SANDBOT_TEST_USER_DATA: '/tmp/d' } as NodeJS.ProcessEnv
    })
    expect(spec.args.join(' ')).not.toContain('ELECTRON_RUN_AS_NODE')
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(spec.env.PATH).toBe('/usr/bin:/bin') // il resto dell'env passa
  })
})
