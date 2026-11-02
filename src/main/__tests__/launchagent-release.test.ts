// Fase rilascio (A3): «Avvia all'accesso» passa a SMAppService nell'app
// impacchettata — il plist del servizio sta DENTRO il bundle; in sviluppo
// resta il plist scritto a mano, con la NUOVA label (mai più
// ELECTRON_RUN_AS_NODE). Qui: il contenuto del plist di entrambe le vie, la
// scelta del meccanismo e la pulizia del VECCHIO plist di SandBot.
import { describe, expect, it } from 'vitest'
import {
  buildAgentServicePlist, buildLaunchAgentPlist, loginItemMechanism,
  LAUNCH_AGENT_LABEL, AGENT_SERVICE_NAME, LEGACY_LAUNCH_AGENT_LABEL,
  cleanupLegacyLaunchAgent, type LaunchAgentOptions
} from '../launchagent'

const devOpts: LaunchAgentOptions = {
  label: LAUNCH_AGENT_LABEL,
  program: '/opt/electron/bin/Electron',
  args: ['/Users/fabio/sandbot', '--homun-daemon'],
  env: {},
  logPath: '/Users/fabio/Library/Application Support/sandbot/data/daemon.log'
}

describe('fase rilascio (A3): il plist del servizio DENTRO il bundle', () => {
  const plist = buildAgentServicePlist()

  it('label e nome servizio (SMAppService usa il nome file del plist)', () => {
    expect(plist).toContain('<string>app.homun.desktop.daemon</string>')
    expect(AGENT_SERVICE_NAME).toBe('app.homun.desktop.daemon.plist')
  })

  it('BundleProgram RELATIVO al bundle e argomenti ["Homun", "--homun-daemon"]', () => {
    expect(plist).toContain('<key>BundleProgram</key>')
    expect(plist).toContain('<string>Contents/MacOS/Homun</string>')
    expect(plist).toMatch(/<string>Homun<\/string>\s*<string>--homun-daemon<\/string>/)
    expect(plist).not.toContain('/Applications/') // nessun percorso assoluto
  })

  it('associato all\'app, RunAtLoad, KeepAlive SOLO sui crash, Interactive', () => {
    expect(plist).toContain('<string>app.homun.desktop</string>') // AssociatedBundleIdentifiers
    expect(plist).toContain('<key>RunAtLoad</key>')
    // un'uscita PULITA (aggiornamento, A2) non va rilanciata da launchd
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(plist).toContain('<string>Interactive</string>')
  })

  it('MAI ELECTRON_RUN_AS_NODE', () => {
    expect(plist).not.toContain('ELECTRON_RUN_AS_NODE')
  })
})

describe('fase rilascio (A3): il plist di sviluppo (non firmata)', () => {
  it('nuova label e avvio con --homun-daemon, senza ELECTRON_RUN_AS_NODE', () => {
    const plist = buildLaunchAgentPlist(devOpts)
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`)
    expect(plist).toContain('<string>--homun-daemon</string>')
    expect(plist).not.toContain('ELECTRON_RUN_AS_NODE')
  })

  it('nessuna EnvironmentVariables quando l\'env è vuoto', () => {
    const plist = buildLaunchAgentPlist(devOpts)
    expect(plist).toContain('<key>EnvironmentVariables</key>')
    expect(plist).not.toMatch(/<key>[A-Z_]+<\/key>\s*<string>[^<]+<\/string>\s*<\/dict>\s*<key>RunAtLoad/) // nessuna variabile dentro
  })
})

describe('fase rilascio (A3): scelta del meccanismo (puro)', () => {
  it('impacchettata → agentService (SMAppService); sviluppo → plist', () => {
    expect(loginItemMechanism(true)).toBe('agentService')
    expect(loginItemMechanism(false)).toBe('plist')
  })
})

describe('fase rilascio (A3): pulizia del vecchio LaunchAgent di SandBot', () => {
  it('bootout + unload + unlink di SOLO quel file esatto', async () => {
    const cmds: string[][] = []
    const unlinked: string[] = []
    const files = new Set(['/Users/x/Library/LaunchAgents/com.fabio.sandbot.daemon.plist'])
    const done = await cleanupLegacyLaunchAgent(501, {
      plistPath: '/Users/x/Library/LaunchAgents/com.fabio.sandbot.daemon.plist',
      existsSync: (p) => files.has(p),
      unlink: (p) => {
        unlinked.push(p)
        files.delete(p)
      },
      launchctl: async (args) => {
        cmds.push(args)
      }
    })
    expect(done).toBe(true)
    expect(cmds).toEqual([
      ['bootout', 'gui/501/com.fabio.sandbot.daemon'],
      ['unload', '/Users/x/Library/LaunchAgents/com.fabio.sandbot.daemon.plist']
    ])
    expect(unlinked).toEqual(['/Users/x/Library/LaunchAgents/com.fabio.sandbot.daemon.plist'])
    // idempotente: senza il file non fa NIENTE
    expect(await cleanupLegacyLaunchAgent(501, { plistPath: '/Users/x/Library/LaunchAgents/com.fabio.sandbot.daemon.plist', existsSync: () => false, unlink: () => { throw new Error('mai') }, launchctl: async () => undefined })).toBe(false)
  })

  it('senza uid (contesto strano) si salta solo il bootout, il file resta l\'unico toccato', async () => {
    const cmds: string[][] = []
    const files = new Set(['/Users/x/Library/LaunchAgents/com.fabio.sandbot.daemon.plist'])
    await cleanupLegacyLaunchAgent(undefined, {
      plistPath: '/Users/x/Library/LaunchAgents/com.fabio.sandbot.daemon.plist',
      existsSync: (p) => files.has(p),
      unlink: (p) => files.delete(p),
      launchctl: async (args) => {
        cmds.push(args)
      }
    })
    expect(cmds).toEqual([['unload', '/Users/x/Library/LaunchAgents/com.fabio.sandbot.daemon.plist']])
  })

  it('il nome del vecchio label è quello esatto della fase ≤16c', () => {
    expect(LEGACY_LAUNCH_AGENT_LABEL).toBe('com.fabio.sandbot.daemon')
  })
})

describe('fase rilascio (A3): il plist nel bundle è quello della funzione', () => {
  it('build/launchagent/app.homun.desktop.daemon.plist coincide con buildAgentServicePlist()', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const bundled = readFileSync(fileURLToPath(new URL('../../../build/launchagent/app.homun.desktop.daemon.plist', import.meta.url)), 'utf8')
    expect(trimmed(bundled)).toBe(trimmed(buildAgentServicePlist()))
  })
})

function trimmed(s: string): string {
  return s.trim().replace(/\s+$/, '')
}
