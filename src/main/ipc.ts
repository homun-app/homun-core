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
import { assertDroppedMacPath } from './dropped-file'
import type { SandbotEvent } from '../shared/types'

/** Canali inoltrati 1:1 al daemon (nomi = metodi RPC). */
export const DAEMON_RPC_CHANNELS = [
  'agents:list', 'agents:create', 'agents:update', 'agents:delete', 'agents:set-main',
  'agents:entries', 'chat:send', 'chat:interrupt',
  // fase 19a: lo schermo del bot (vista dal vivo e presa di controllo)
  'screen:open', 'screen:release', 'screen:status',
  // fase 19b: terminale, file e attività del computer del bot. files:export e
  // files:import NON ci sono: li chiama SOLO il main dopo il dialog del Mac
  // (il renderer non vede né sceglie mai un path del Mac se non da quelli o
  // dal trascinamento, che passa da files:import-dropped)
  'terminal:open',
  'files:list', 'files:read',
  'activity:list', 'activity:output',
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
  // fase 16b (S1.3): squadre create e modificate dalla UI
  'groups:create', 'groups:update', 'groups:delete',
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
  // fase 16c correzioni (R1): le tre RPC nuove della 16c mancavano qui — in
  // Electron rispondevano «No handler registered» (la prova della chiave, la
  // ricerca nel registro MCP e l'Attività globale sempre vuota). Il test di
  // coerenza ipc-rpc-coherence.test.ts le tiene d'occhio: ogni canale del
  // preload dev'essere inoltrato o gestito dal main, e ogni canale inoltrato
  // dev'avere un handler nel daemon.
  'providers:probe', 'activity:global', 'connectors:search-registry',
  // fase 18b (K3): le capacità di UN modello, senza l'elenco completo
  'models:capabilities',
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

  // ---- fase 19b (T3.2): le finestre del Mac della vista File ----
  // Il macPath lo sceglie SEMPRE l'utente nel dialog: il renderer non vede
  // né sceglie mai un path del Mac se non da questi dialog o dal
  // trascinamento (che passa da files:import-dropped col path del drop).

  /** files:download — finestra «Salva», poi files:export del daemon. null = annullato. */
  ipcMain.handle('files:download', async (_e, agentId: string, path: string) => {
    const win = getWindows()[0]
    const name = String(path).split('/').pop() || 'file'
    const r = await dialog.showSaveDialog(win!, {
      title: mainStrings().dialogs.saveFile,
      defaultPath: name
    })
    if (r.canceled || !r.filePath) return null
    return client.call('files:export', [agentId, path, r.filePath])
  })

  /** files:upload — finestra «Apri» (anche più file), poi files:import per ciascuno. */
  ipcMain.handle('files:upload', async (_e, agentId: string, dirPath: string) => {
    const win = getWindows()[0]
    const r = await dialog.showOpenDialog(win!, {
      title: mainStrings().dialogs.openFiles,
      properties: ['openFile', 'multiSelections']
    })
    if (r.canceled || !r.filePaths.length) return []
    const out: Array<{ name: string; ok: boolean; skipped?: boolean; bytes?: number }> = []
    for (const macPath of r.filePaths) {
      const name = macPath.split('/').pop() ?? macPath
      let res = (await client.call('files:import', [agentId, dirPath, macPath])) as
        | { ok: true; name: string; bytes: number }
        | { ok: false; reason: string; name: string }
      if (res.ok === false && res.reason === 'exists') {
        // «Sostituire?» — il dialog nativo del main, così il path del Mac non
        // torna mai indietro al renderer
        const ask = await dialog.showMessageBox(win!, {
          type: 'question',
          title: mainStrings().dialogs.replaceTitle,
          message: mainStrings().dialogs.replaceMessage.replace('{name}', name),
          buttons: [mainStrings().dialogs.replaceYes, mainStrings().dialogs.replaceNo],
          defaultId: 1,
          cancelId: 1
        })
        if (ask.response !== 0) {
          out.push({ name, ok: false, skipped: true })
          continue
        }
        res = (await client.call('files:import', [agentId, dirPath, macPath, true])) as typeof res
      }
      out.push(res.ok ? { name: res.name, ok: true, bytes: res.bytes } : { name, ok: false })
    }
    return out
  })

  /** files:import-dropped — il file TRASCINATO dal Finder (path dal drop, preload). */
  ipcMain.handle('files:import-dropped', async (_e, agentId: string, dirPath: string, macPath: string, overwrite?: boolean) => {
    // correzioni U1: il path lo calcola il preload dal File del drop; qui il
    // controllo in più — assoluto, senza byte nulli, file regolare e NON un symlink
    await assertDroppedMacPath(macPath)
    return client.call('files:import', [agentId, dirPath, macPath, overwrite === true ? true : undefined])
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
  // (agent-done / agent-needs-input); qui resta solo la notifica nativa.
  // fase 16b (S1.2): openGroupId dice che il click apre la SQUADRA
  // (riepilogo del coordinatore), non la chat del bot
  client.registerHost('host.notify', ([title, body, openGroupId]) => {
    const windows = getWindows()
    const n = new Notification({
      title: String(title ?? 'Homun'),
      body: String(body ?? '').slice(0, 120)
    })
    n.on('click', () => {
      const w = windows[0]
      w?.show()
      w?.focus()
      if (typeof openGroupId === 'number') {
        w?.webContents.send('sandbot:event', { type: 'open-group', groupId: openGroupId })
      }
    })
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
