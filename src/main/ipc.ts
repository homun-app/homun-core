// IPC main ↔ renderer: la UI è un client sottile del daemon — i canali RPC
// vengono inoltrati così come sono (stessi nomi e argomenti posizionali di
// fase 1), gli eventi push del daemon arrivano sul canale 'sandbot:event'.
// Restano locali solo le API che dipendono da finestre e dialoghi: pick-image,
// test notifiche e gestione del LaunchAgent "Avvia all'accesso".
import { ipcMain, BrowserWindow, Notification, dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { refreshTray } from './tray'
import { mainStrings, setMainLanguage, publishActiveLanguage } from './i18n'
import type { UiLanguage } from '../shared/ui-language'
import * as db from './store/db'
import { isLaunchAgentInstalled, setLaunchAgent, LAUNCH_AGENT_LABEL } from './launchagent'
import { daemonEntryPath } from './daemon-client'
import type { DaemonClient } from './daemon-client'
import type { SandbotEvent } from '../shared/types'

/** Canali inoltrati 1:1 al daemon (nomi = metodi RPC). */
export const DAEMON_RPC_CHANNELS = [
  'agents:list', 'agents:create', 'agents:update', 'agents:delete', 'agents:set-main',
  'agents:entries', 'chat:send', 'chat:interrupt',
  'widget:respond', 'draft:send', 'draft:discard', 'draft:update',
  'quickask',
  'routines:list', 'routines:create', 'routines:update', 'routines:delete', 'routines:suggest',
  'routines:create-trigger', 'routines:update-trigger',
  'presence:signal', 'presence:viewing', 'outbox:opened',
  // fase 8 (§3bis L7): task thread
  'tasks:list', 'tasks:cancel',
  'subagents:list', 'subagents:stop',
  // fase 10: gruppi di bot (sidebar, vista gruppo, scrittura come utente)
  'groups:list', 'groups:messages', 'groups:send-user',
  'memory:list', 'memory:update', 'memory:delete',
  'skills:list', 'skills:delete',
  'mcp:list', 'mcp:save', 'mcp:delete', 'mcp:test',
  'connectors:list', 'connectors:connect', 'connectors:disconnect',
  'connectors:set-tools', 'connectors:set-instructions', 'connectors:save-static',
  // fase 13: connettori su larga scala (registro, plugin, gateway)
  'connectors:installed', 'connectors:resolve-mcp-server', 'connectors:save-server-values',
  'connectors:set-enabled-for', 'connectors:uninstall-server', 'connectors:reconnect-server', 'connectors:add-gateway',
  'connectors:gateway-presets', 'connectors:set-client-metadata-url',
  'plugins:resolve', 'plugins:uninstall',
  'marketplace:list', 'marketplace:add', 'marketplace:remove',
  'vault:list', 'vault:store', 'vault:delete',
  // fase 14: vault esteso (login, contatti, concessioni fill) e modulo sicuro
  'vault:items', 'vault:save-login', 'vault:save-contact', 'vault:delete-item', 'vault:get-contact',
  'fills:grants', 'fills:revoke', 'secureinput:submit',
  // fase 14: la libreria (documenti, grafici, file; esportazione anche da UI)
  'library:list', 'library:get', 'library:delete', 'library:rename', 'library:pin', 'library:export', 'library:stats', 'library:restore-version',
  'approvals:resolve', 'approvals:resolve-latest',
  // fase 8: regole di auto-review proposte dal bot (salvataggio SOLO al click)
  'autoreview:rule-decision',
  'providers:list', 'providers:save', 'providers:delete', 'providers:discover', 'providers:test', 'models:list',
  // fase 18b (H6): uso e costi aggregati (pagina "Uso e costi")
  'usage:summary',
  // fase 11: chiave per la ricerca web del provider Ollama (vault sigillato)
  'providers:set-web-search-key', 'providers:web-search-key-set',
  // fase 15: stato dei provider di ricerca (sola lettura, per le Impostazioni)
  'websearch:status',
  'permissions:get', 'permissions:set', 'settings:get', 'settings:set',
  // fase 7: template dei bot (catalogo + creazione col kickstart)
  'templates:list', 'agents:create-from-template'
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
      filters: [{ name: mainStrings().dialogs.images, extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    const buf = await readFile(r.filePaths[0])
    if (buf.length > 5_000_000) throw new Error(mainStrings().dialogs.imageTooLarge)
    return buf.toString('base64')
  })

  // diagnostica notifiche (F4)
  ipcMain.handle('notify:test', () => {
    const s = mainStrings().notifyTest
    const n = new Notification({ title: s.title, body: s.body })
    n.show()
    return { shown: true }
  })

  // fase 17a (L5): l'utente ha cambiato la lingua — il tray si ricostruisce.
  // fase 17b (A2): la lingua risolta si pubblica come 'ui.activeLanguage'
  // (settings:set, fire-and-forget: se il daemon non risponde nessun errore)
  ipcMain.handle('ui:language-changed', (_e, lang: UiLanguage) => {
    setMainLanguage(lang)
    void publishActiveLanguage(lang, (method, params) => client.call(method, params))
    refreshTray()
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
  // fase 6: titolo/corpo già decisi dalle regole di soppressione del daemon
  // (agent-done / agent-needs-input); qui resta solo la notifica nativa
  client.registerHost('host.notify', ([title, body]) => {
    const windows = getWindows()
    const n = new Notification({
      title: String(title ?? 'Homun'),
      body: String(body ?? '').slice(0, 120)
    })
    n.on('click', () => { const w = windows[0]; w?.show(); w?.focus() })
    n.show()
    return { shown: true }
  })

  // fase 14 (punto 5): il PDF dell'esportazione lo genera la UI — Electron
  // printToPDF su una finestra NASCOSTA con l'HTML autonomo del documento
  // (nessuna risorsa esterna); il buffer torna al daemon in base64
  client.registerHost('host.printToPDF', async ([html]) => {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
    try {
      await win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(String(html ?? ''), 'utf8').toString('base64'))
      const pdf = await win.webContents.printToPDF({ printBackground: true })
      return pdf.toString('base64')
    } finally {
      win.destroy()
    }
  })
}

/** Broadcast di un evento locale (deep link, primo avvio) a tutte le finestre. */
export function emitLocal(e: SandbotEvent, getWindows: () => BrowserWindow[]): void {
  for (const w of getWindows()) w.webContents.send('sandbot:event', e)
  if (e.type === 'agents') refreshTray()
}
