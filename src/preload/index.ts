import { contextBridge, ipcRenderer } from 'electron'
import type { SandbotApi, SandbotEvent } from '../shared/types'

const api: SandbotApi = {
  listAgents: () => ipcRenderer.invoke('agents:list'),
  createAgent: (name, description) => ipcRenderer.invoke('agents:create', name, description),
  updateAgent: (id, patch) => ipcRenderer.invoke('agents:update', id, patch),
  deleteAgent: (id) => ipcRenderer.invoke('agents:delete', id),
  getEntries: (agentId, afterId) => ipcRenderer.invoke('agents:entries', agentId, afterId),
  sendMessage: (agentId, text, images) => ipcRenderer.invoke('chat:send', agentId, text, images),
  interrupt: (agentId) => ipcRenderer.invoke('chat:interrupt', agentId),
  resolveApproval: (agentId, approvalId, decision, always) =>
    ipcRenderer.invoke('approvals:resolve', agentId, approvalId, decision, always),

  listProviders: () => ipcRenderer.invoke('providers:list'),
  saveProvider: (p) => ipcRenderer.invoke('providers:save', p),
  deleteProvider: (id) => ipcRenderer.invoke('providers:delete', id),
  discoverProviders: () => ipcRenderer.invoke('providers:discover'),
  testProvider: (id) => ipcRenderer.invoke('providers:test', id),
  listModels: (providerId) => ipcRenderer.invoke('models:list', providerId),
  getPermissions: () => ipcRenderer.invoke('permissions:get'),
  setPermissions: (cfg) => ipcRenderer.invoke('permissions:set', cfg),
  quickAsk: (agentId, question) => ipcRenderer.invoke('quickask', agentId, question),
  pickImage: () => ipcRenderer.invoke('dialog:pick-image'),
  listRoutines: (agentId) => ipcRenderer.invoke('routines:list', agentId),
  createRoutine: (agentId, title, prompt, schedule) => ipcRenderer.invoke('routines:create', agentId, title, prompt, schedule),
  updateRoutine: (id, patch) => ipcRenderer.invoke('routines:update', id, patch),
  deleteRoutine: (id) => ipcRenderer.invoke('routines:delete', id),
  suggestRoutines: (agentId) => ipcRenderer.invoke('routines:suggest', agentId),
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpSave: (s) => ipcRenderer.invoke('mcp:save', s),
  mcpDelete: (id) => ipcRenderer.invoke('mcp:delete', id),
  mcpTest: (id) => ipcRenderer.invoke('mcp:test', id),
  vaultList: () => ipcRenderer.invoke('vault:list'),
  vaultStore: (name, value) => ipcRenderer.invoke('vault:store', name, value),
  vaultDelete: (name) => ipcRenderer.invoke('vault:delete', name),
  getLaunchAtLogin: () => ipcRenderer.invoke('launch-at-login:get'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('launch-at-login:set', enabled),
  onEvent: (cb) => {
    const listener = (_e: unknown, ev: SandbotEvent) => cb(ev)
    ipcRenderer.on('sandbot:event', listener)
    return () => ipcRenderer.removeListener('sandbot:event', listener)
  }
}

contextBridge.exposeInMainWorld('sandbot', api)
