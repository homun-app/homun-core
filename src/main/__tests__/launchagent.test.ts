// Test della generazione del plist del LaunchAgent (funzione pura).
import { describe, expect, it } from 'vitest'
import { buildLaunchAgentPlist, LAUNCH_AGENT_LABEL } from '../launchagent'

const OPTS: Parameters<typeof buildLaunchAgentPlist>[0] = {
  label: LAUNCH_AGENT_LABEL,
  program: '/Applications/SandBot.app/Contents/MacOS/SandBot',
  args: ['/Applications/SandBot.app/Contents/Resources/app.asar.unpacked/main/daemon.js', '--data', '/Users/fabio/data'],
  env: { ELECTRON_RUN_AS_NODE: '1', SANDBOT_DATA_DIR: '/Users/fabio/data' },
  logPath: '/Users/fabio/data/daemon.log'
}

function plistOf(over: Record<string, unknown> = {}): string {
  return buildLaunchAgentPlist({ ...OPTS, ...over } as Parameters<typeof buildLaunchAgentPlist>[0])
}

describe('buildLaunchAgentPlist', () => {
  it('contiene Label, ProgramArguments con eseguibile e argomenti, RunAtLoad e KeepAlive', () => {
    const p = plistOf()
    expect(p).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`)
    expect(p).toContain(`<string>${OPTS.program}</string>`)
    expect(p).toContain(`<string>${OPTS.args[0]}</string>`)
    expect(p).toContain('<key>RunAtLoad</key>')
    expect(p).toContain('<true/>')
    expect(p).toContain('<key>KeepAlive</key>')
    expect(p).toContain('<key>StandardOutPath</key>')
    expect(p).toContain(`<string>${OPTS.logPath}</string>`)
  })

  it('le variabili d\'ambiente finiscono in EnvironmentVariables', () => {
    const p = plistOf()
    expect(p).toContain('<key>EnvironmentVariables</key>')
    expect(p).toContain('<key>ELECTRON_RUN_AS_NODE</key>')
    expect(p).toContain('<string>1</string>')
    expect(p).toContain('<key>SANDBOT_DATA_DIR</key>')
    expect(p).toContain(`<string>${OPTS.env.SANDBOT_DATA_DIR}</string>`)
  })

  it('i path con & < > " vengono escapati in XML', () => {
    const p = plistOf({
      program: '/bin/we&ird',
      args: ['<path>', '"quoted"'],
      env: { X: '>v' },
      logPath: '/tmp/a&b.log'
    })
    expect(p).toContain('<string>/bin/we&amp;ird</string>')
    expect(p).toContain('<string>&lt;path&gt;</string>')
    expect(p).toContain('<string>&quot;quoted&quot;</string>')
    expect(p).toContain('<string>&gt;v</string>')
    expect(p).toContain('<string>/tmp/a&amp;b.log</string>')
    expect(p).not.toContain('/bin/we&ird')
  })

  it('è XML ben formato (check di bilanciamento dict/array/plist)', () => {
    const p = plistOf()
    expect(p.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    for (const tag of ['dict', 'array']) {
      const open = p.split(`<${tag}>`).length - 1
      const close = p.split(`</${tag}>`).length - 1
      expect(open, tag).toBe(close)
    }
    // <plist version="1.0"> ha un attributo: confronto prefisso contro chiusura
    expect(p.split('<plist').length - 1).toBe(p.split('</plist>').length - 1)
  })
})
