// "Avvia all'accesso" del daemon (fase rilascio, A3 — adattato da homun2).
//
// NELL'APP IMPACCHETTATA lo standard macOS 13+ è SMAppService via
// app.setLoginItemSettings({ type: 'agentService' }): il plist sta DENTRO il
// bundle (Contents/Library/LaunchAgents/app.homun.desktop.daemon.plist, ci lo
// mette electron-builder con extraFiles), l'utente lo vede e lo governa in
// Impostazioni di Sistema › Generali › Elementi login, e sparisce quando si
// cancella l'app. Quelle chiamate Electron vivono in ipc.ts.
//
// IN SVILUPPO (non firmata) resta il plist scritto a mano in
// ~/Library/LaunchAgents, che funziona senza firma: stessa label e stesso
// nome file del servizio impacchettato. Il daemon parte con l'eseguibile
// Electron dell'app in modalità --homun-daemon (A1: MAI ELECTRON_RUN_AS_NODE).
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_FLAG } from './mode'

/** Il nome dell'eseguibile dentro il bundle (build.executableName). */
export const APP_EXECUTABLE_NAME = 'homun'
/** Il bundle id dell'app (build.appId). */
export const APP_BUNDLE_ID = 'app.homun.desktop'

/** Label e nome file del LaunchAgent del daemon (uguali nelle due modalità). */
export const LAUNCH_AGENT_LABEL = 'app.homun.desktop.daemon'
export const LAUNCH_AGENT_PLIST_NAME = `${LAUNCH_AGENT_LABEL}.plist`
/** Il nome servizio per SMAppService (il nome file del plist dentro il bundle). */
export const AGENT_SERVICE_NAME = LAUNCH_AGENT_PLIST_NAME

/** Il vecchio LaunchAgent di SandBot (fase ≤16c): da togliere al primo avvio della 0.3. */
export const LEGACY_LAUNCH_AGENT_LABEL = 'com.fabio.sandbot.daemon'
export const LEGACY_LAUNCH_AGENT_PLIST_NAME = `${LEGACY_LAUNCH_AGENT_LABEL}.plist`

/**
 * Il plist del servizio che sta DENTRO il bundle (A3, puro): BundleProgram
 * RELATIVO al bundle, argomenti ["homun", "--homun-daemon"], associato
 * all'app, RunAtLoad, KeepAlive solo sui crash (SuccessfulExit false: un'uscita
 * pulita per aggiornamento NON va rilanciata da launchd — A2 — la rilancia la
 * UI nuova) e ProcessType Interactive.
 */
export function buildAgentServicePlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>BundleProgram</key>
    <string>Contents/MacOS/${APP_EXECUTABLE_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${APP_EXECUTABLE_NAME}</string>
        <string>${DAEMON_FLAG}</string>
    </array>
    <key>AssociatedBundleIdentifiers</key>
    <array>
        <string>${APP_BUNDLE_ID}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
`
}

export interface LaunchAgentOptions {
  label: string
  /** eseguibile (process.execPath dell'app: Electron) */
  program: string
  /** argomenti: [percorso dell'app (dev), --homun-daemon] */
  args: string[]
  env: Record<string, string>
  logPath: string
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Genera il plist del LaunchAgent di SVILUPPO (puro, testabile). */
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

/** Quale meccanismo usa "Avvia all'accesso" (puro, A3): impacchettata → SMAppService, sviluppo → plist. */
export function loginItemMechanism(isPackaged: boolean): 'agentService' | 'plist' {
  return isPackaged ? 'agentService' : 'plist'
}

export function launchAgentPlistPath(): string {
  const dir = join(homedir(), 'Library', 'LaunchAgents')
  return join(dir, LAUNCH_AGENT_PLIST_NAME)
}

/** Il percorso del VECCHIO plist di SandBot (da pulire al primo avvio). */
export function legacyLaunchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', LEGACY_LAUNCH_AGENT_PLIST_NAME)
}

function launchctl(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile('launchctl', args, { timeout: 10_000 }, () => resolve())
  })
}

/** true se il LaunchAgent di sviluppo è installato. */
export function isLaunchAgentInstalled(): boolean {
  return existsSync(launchAgentPlistPath())
}

/** Installa o rimuove il LaunchAgent del daemon (solo sviluppo). */
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

/**
 * Pulizia del vecchio LaunchAgent di SandBot (A3.4): bootout/unload e via il
 * file — SOLO quello esatto, mai altro nella cartella. Best-effort, idempotente
 * (il controllo di esistenza lo fa il chiamante o la natura no-op dei comandi).
 */
export async function cleanupLegacyLaunchAgent(
  uid: number | undefined,
  opts: { existsSync?: (p: string) => boolean; unlink?: (p: string) => void; launchctl?: (args: string[]) => Promise<void>; plistPath?: string } = {}
): Promise<boolean> {
  const exists = opts.existsSync ?? existsSync
  const unlink = opts.unlink ?? ((p: string) => unlinkSync(p))
  const ctl = opts.launchctl ?? launchctl
  const plist = opts.plistPath ?? legacyLaunchAgentPlistPath()
  if (!exists(plist)) return false
  // bootout (launchd moderno) poi unload (vecchio): no-op se non caricato
  if (typeof uid === 'number') await ctl(['bootout', `gui/${uid}/${LEGACY_LAUNCH_AGENT_LABEL}`])
  await ctl(['unload', plist])
  try {
    unlink(plist)
  } catch {
    // già andato
  }
  return true
}
