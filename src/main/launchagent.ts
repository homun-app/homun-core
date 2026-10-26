// "Avvia all'accesso": LaunchAgent che tiene il daemon sempre acceso
// (RunAtLoad + KeepAlive al crash). Il plist è generato da una funzione pura
// (testata); l'installazione scrive in ~/Library/LaunchAgents e carica con
// launchctl. Il daemon parte con l'eseguibile Electron in ELECTRON_RUN_AS_NODE.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LAUNCH_AGENT_LABEL = 'com.fabio.sandbot.daemon'

export interface LaunchAgentOptions {
  label: string
  /** eseguibile (process.execPath dell'app: Electron) */
  program: string
  /** argomenti: [bundle del daemon, --data, directory dati] */
  args: string[]
  env: Record<string, string>
  logPath: string
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Genera il plist del LaunchAgent (puro, testabile). */
export function buildLaunchAgentPlist(o: LaunchAgentOptions): string {
  const env = Object.entries(o.env)
    .map(([k, v]) => `        <key>${xmlEscape(k)}</key>\n        <string>${xmlEscape(v)}</string>`)
    .join('\n')
  const args = o.args.map((a) => `        <string>${xmlEscape(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(o.label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(o.program)}</string>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(o.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(o.logPath)}</string>
</dict>
</plist>
`
}

export function launchAgentPlistPath(): string {
  const dir = join(homedir(), 'Library', 'LaunchAgents')
  return join(dir, `${LAUNCH_AGENT_LABEL}.plist`)
}

function launchctl(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile('launchctl', args, { timeout: 10_000 }, () => resolve())
  })
}

/** true se il LaunchAgent è installato. */
export function isLaunchAgentInstalled(): boolean {
  return existsSync(launchAgentPlistPath())
}

/** Installa o rimuove il LaunchAgent del daemon. */
export async function setLaunchAgent(enabled: boolean, opts: LaunchAgentOptions): Promise<void> {
  const plist = launchAgentPlistPath()
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  // unload sempre: ricarica pulita se era già attivo, no-op altrimenti
  await launchctl(['unload', plist])
  if (!enabled) {
    try {
      unlinkSync(plist)
    } catch {
      // non esiste
    }
    return
  }
  writeFileSync(plist, buildLaunchAgentPlist(opts))
  await launchctl(['load', plist])
}
