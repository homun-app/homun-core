// IPC main ↔ renderer: invoke handlers + eventi push sul canale 'sandbot:event'.
import { ipcMain, BrowserWindow, Notification, dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import * as db from './store/db'
import * as loop from './agent/loop'
import * as providers from './agent/providers'
import { refreshTray } from './tray'
import { getAgent } from './store/db'
import { reloadScheduler, suggestRoutines } from './routines'
import { llmStream } from './agent/llm'
import { secondaryPrompts } from './agent/prompts'
import type { SandbotEvent } from '../shared/types'

export function emit(e: SandbotEvent): void {
  const windows = BrowserWindow.getAllWindows()
  for (const w of windows) {
    w.webContents.send('sandbot:event', e)
  }
  if (e.type === 'agents') refreshTray()
  // notifica nativa "wake" quando un bot risponde e la finestra non è a fuoco
  if (e.type === 'status' && e.status === 'idle') {
    const focused = windows.some((w) => w.isFocused())
    if (!focused) {
      const agent = getAgent(e.agentId)
      const last = db.getEntries(e.agentId).findLast((x) => x.kind === 'message' && x.role === 'assistant')
      if (agent && last && last.content) {
        const n = new Notification({
          title: `${agent.name} ha risposto`,
          body: last.content.replace(/[#*`>]/g, '').slice(0, 120)
        })
        n.on('click', () => { const w = windows[0]; w?.show(); w?.focus() })
        n.show()
      }
    }
  }
}

export function registerIpc(): void {
  // ---- agenti ----
  ipcMain.handle('agents:list', () => db.listAgents())
  ipcMain.handle('agents:create', (_e, name: string, description?: string) => {
    const a = db.createAgent(name, description ?? '')
    emit({ type: 'agents' })
    return a
  })
  ipcMain.handle('agents:update', (_e, id: string, patch) => {
    db.updateAgent(id, patch)
    emit({ type: 'agents' })
  })
  ipcMain.handle('agents:delete', (_e, id: string) => {
    loop.interrupt(id)
    db.deleteAgent(id)
    emit({ type: 'agents' })
  })

  // ---- transcript ----
  ipcMain.handle('agents:entries', (_e, agentId: string, afterId?: number) => db.getEntries(agentId, afterId ?? 0))
  ipcMain.handle('chat:send', (_e, agentId: string, text: string, images?: string[]) => {
    db.updateAgent(agentId, { unread: 0 })
    void loop.runTurn(agentId, text, emit, images)
  })
  ipcMain.handle('chat:interrupt', (_e, agentId: string) => {
    loop.interrupt(agentId)
  })

  // ---- allegati immagine (multimodal) ----
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

  // ---- quick-ask (domanda effimera sul contesto, non inquina il transcript) ----
  ipcMain.handle('quickask', async (_e, agentId: string, question: string) => {
    const agent = getAgent(agentId)
    if (!agent?.providerId || !agent.model) throw new Error('Configura prima provider e modello.')
    const provider = providers.getProvider(agent.providerId)
    if (!provider) throw new Error('Provider non trovato')
    const context = db.getEntries(agentId)
      .slice(-20)
      .filter((e) => e.kind === 'message')
      .map((e) => `${e.role === 'user' ? 'UTENTE' : 'BOT'}: ${e.content.slice(0, 400)}`)
      .join('\n')
    const prompt = secondaryPrompts.quickAsk(context, question)
    const controller = new AbortController()
    const stream = llmStream(provider, agent.model, [{ role: 'user', content: prompt }], [], controller.signal)
    let acc = ''
    for await (const ch of stream) if (ch.textDelta) acc += ch.textDelta
    return acc
  })

  // ---- routines ----
  ipcMain.handle('routines:list', (_e, agentId?: string) => db.listRoutines(agentId))
  ipcMain.handle('routines:create', (_e, agentId: string, title: string, prompt: string, schedule: string) => {
    const r = db.createRoutine(agentId, title, prompt, schedule)
    reloadScheduler(emit)
    return r
  })
  ipcMain.handle('routines:update', (_e, id: number, patch) => {
    db.updateRoutine(id, patch)
    reloadScheduler(emit)
  })
  ipcMain.handle('routines:delete', (_e, id: number) => {
    db.deleteRoutine(id)
    reloadScheduler(emit)
  })
  ipcMain.handle('routines:suggest', (_e, agentId: string) => suggestRoutines(agentId))

  // ---- MCP ----
  ipcMain.handle('mcp:list', () => (async () => (await import('./mcp')).listServers())())
  ipcMain.handle('mcp:save', (_e, s) => (async () => {
    const mcp = await import('./mcp')
    mcp.saveServers([...mcp.listServers().filter((x) => x.id !== s.id), s])
    return mcp.listServers()
  })())
  ipcMain.handle('mcp:delete', (_e, id: string) => (async () => {
    const mcp = await import('./mcp')
    mcp.saveServers(mcp.listServers().filter((x) => x.id !== id))
  })())
  ipcMain.handle('mcp:test', (_e, id: string) => (async () => (await import('./mcp')).testServer(id))())

  // ---- vault credenziali ----
  ipcMain.handle('vault:list', () => (async () => (await import('./vault')).listSecretNames())())
  ipcMain.handle('vault:store', (_e, name: string, value: string) => (async () => (await import('./vault')).storeSecret(name, value))())
  ipcMain.handle('vault:delete', (_e, name: string) => (async () => (await import('./vault')).deleteSecret(name))())

  // ---- approvazioni ----
  ipcMain.handle('approvals:resolve', (_e, agentId: string, approvalId: string, decision: 'allow' | 'deny', always: boolean) => {
    loop.resolveApproval(agentId, approvalId, decision, always)
  })
  // debug/test: risolve l'approval pending più recente di un agente
  ipcMain.handle('approvals:resolve-latest', (_e, agentId: string, decision: 'allow' | 'deny') => {
    const pending = db.getEntries(agentId).findLast((x) => x.kind === 'approval' && x.meta?.status === 'pending')
    if (!pending) return null
    loop.resolveApproval(agentId, String(pending.meta?.approvalId), decision, false)
    return String(pending.meta?.approvalId)
  })

  // ---- provider ----
  ipcMain.handle('providers:list', () => db.listProviders())
  ipcMain.handle('providers:save', (_e, p) => {
    const ps = db.listProviders().filter((x) => x.id !== p.id)
    ps.push(p)
    db.saveProviders(ps)
    emit({ type: 'agents' })
  })
  ipcMain.handle('providers:delete', (_e, id: string) => {
    db.saveProviders(db.listProviders().filter((x) => x.id !== id))
  })
  ipcMain.handle('providers:discover', () => providers.discoverProviders())
  ipcMain.handle('providers:test', (_e, id: string) => {
    const p = providers.getProvider(id)
    return p ? providers.testProvider(p) : { ok: false, error: 'provider non trovato' }
  })
  ipcMain.handle('models:list', (_e, providerId: string) => {
    const p = providers.getProvider(providerId)
    if (!p) throw new Error('provider non trovato')
    return providers.listProviderModels(p)
  })

  // ---- permessi & impostazioni ----
  ipcMain.handle('permissions:get', () => db.getPermissions())
  ipcMain.handle('permissions:set', (_e, cfg) => db.setPermissions(cfg))
  ipcMain.handle('settings:get', (_e, key: string, fallback) => db.getSetting(key, fallback))
  ipcMain.handle('settings:set', (_e, key: string, value) => db.setSetting(key, value))

  // avvia lo scheduler delle routine con l'emitter corrente
  reloadScheduler(emit)

  // diagnostica notifiche (F4)
  ipcMain.handle('notify:test', () => {
    const n = new Notification({ title: 'SandBot', body: 'Test notifica — se la vedi, i permessi sono ok.' })
    n.show()
    return { shown: true }
  })
}
