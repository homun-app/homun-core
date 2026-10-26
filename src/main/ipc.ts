// IPC main ↔ renderer: la UI è un client sottile del daemon — i canali RPC
// vengono inoltrati così come sono (stessi nomi e argomenti posizionali di
// fase 1), gli eventi push del daemon arrivano sul canale 'sandbot:event'.
// Restano locali solo le API che dipendono da finestre e dialoghi: pick-image,
// test notifiche e gestione del LaunchAgent "Avvia all'accesso".
import { ipcMain, BrowserWindow, Notification, dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { refreshTray } from './tray'
import * as db from './store/db'
import { isLaunchAgentInstalled, setLaunchAgent, LAUNCH_AGENT_LABEL } from './launchagent'
import { daemonEntryPath } from './daemon-client'
import type { DaemonClient } from './daemon-client'
import type { SandbotEvent } from '../shared/types'

/** Canali inoltrati 1:1 al daemon (nomi = metodi RPC). */
export const DAEMON_RPC_CHANNELS = [
  'agents:list', 'agents:create', 'agents:update', 'agents:delete',
  'agents:entries', 'chat:send', 'chat:interrupt',
  'quickask',
  'routines:list', 'routines:create', 'routines:update', 'routines:delete', 'routines:suggest',
  'mcp:list', 'mcp:save', 'mcp:delete', 'mcp:test',
  'vault:list', 'vault:store', 'vault:delete',
  'approvals:resolve', 'approvals:resolve-latest',
  'providers:list', 'providers:save', 'providers:delete', 'providers:discover', 'providers:test', 'models:list',
  'permissions:get', 'permissions:set', 'settings:get', 'settings:set'
] as const

export function registerIpc(client: DaemonClient, getWindows: () => BrowserWindow[]): void {
  // ---- inoltro RPC al daemon ----
  for (const ch of DAEMON_RPC_CHANNELS) {
    ipcMain.handle(ch, (_e, ...args: unknown[]) => client.call(ch, args))
  }

  // ---- API locali (finestre/dialoghi/sistema) ----
  ipcMain.handle('dialog:pick-image', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Immagini', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    const buf = await readFile(r.filePaths[0])
    if (buf.length > 5_000_000) throw new Error('Immagine troppo grande (max 5MB)')
    return buf.toString('base64')
  })

  // diagnostica notifiche (F4)
  ipcMain.handle('notify:test', () => {
    const n = new Notification({ title: 'SandBot', body: 'Test notifica — se la vedi, i permessi sono ok.' })
    n.show()
    return { shown: true }
  })

  // ---- "Avvia all'accesso": LaunchAgent del daemon ----
  ipcMain.handle('launch-at-login:get', () => isLaunchAgentInstalled())
  ipcMain.handle('launch-at-login:set', (_e, enabled: boolean) =>
    setLaunchAgent(enabled, {
      label: LAUNCH_AGENT_LABEL,
      program: process.execPath,
      args: [daemonEntryPath(), '--data', db.dataDir()],
      env: { ELECTRON_RUN_AS_NODE: '1', SANDBOT_DATA_DIR: db.dataDir() },
      logPath: join(db.dataDir(), 'daemon.log')
    })
  )

  // ---- eventi push del daemon → renderer (+ tray e notifiche) ----
  client.onEvent((e) => {
    for (const w of getWindows()) w.webContents.send('sandbot:event', e)
    if (e.type === 'agents') refreshTray()
  })

  // ---- host API: il daemon chiama la UI quando è aperta ----
  client.registerHost('host.notify', ([agentId]) => {
    const windows = getWindows()
    const focused = windows.some((w) => w.isFocused())
    if (focused) return { shown: false }
    const agent = db.getAgent(agentId as string)
    const last = db.getEntries(agentId as string).findLast((x) => x.kind === 'message' && x.role === 'assistant')
    if (!agent || !last?.content) return { shown: false }
    const n = new Notification({
      title: `${agent.name} ha risposto`,
      body: last.content.replace(/[#*`>]/g, '').slice(0, 120)
    })
    n.on('click', () => { const w = windows[0]; w?.show(); w?.focus() })
    n.show()
    return { shown: true }
  })
}

/** Broadcast di un evento locale (deep link, primo avvio) a tutte le finestre. */
export function emitLocal(e: SandbotEvent, getWindows: () => BrowserWindow[]): void {
  for (const w of getWindows()) w.webContents.send('sandbot:event', e)
  if (e.type === 'agents') refreshTray()
}
