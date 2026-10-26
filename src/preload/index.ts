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
  widgetRespond: (agentId, entryId, value) => ipcRenderer.invoke('widget:respond', agentId, entryId, value),
  draftSend: (agentId, entryId, body) => ipcRenderer.invoke('draft:send', agentId, entryId, body),
  draftDiscard: (agentId, entryId) => ipcRenderer.invoke('draft:discard', agentId, entryId),
  draftUpdate: (agentId, entryId, body) => ipcRenderer.invoke('draft:update', agentId, entryId, body),
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
  // fase 4: memoria e skill dell'agente
  listMemories: (agentId) => ipcRenderer.invoke('memory:list', agentId),
  updateMemory: (agentId, id, content) => ipcRenderer.invoke('memory:update', agentId, id, content),
  deleteMemory: (agentId, id) => ipcRenderer.invoke('memory:delete', agentId, id),
  listSkills: (agentId) => ipcRenderer.invoke('skills:list', agentId),
  deleteSkill: (agentId, name) => ipcRenderer.invoke('skills:delete', agentId, name),
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpSave: (s, secret) => ipcRenderer.invoke('mcp:save', s, secret),
  mcpDelete: (id) => ipcRenderer.invoke('mcp:delete', id),
  mcpTest: (id) => ipcRenderer.invoke('mcp:test', id),
  // fase 5: connettori del catalogo ("Connetti app")
  connectorsList: () => ipcRenderer.invoke('connectors:list'),
  connectorsConnect: (id) => ipcRenderer.invoke('connectors:connect', id),
  connectorsDisconnect: (id) => ipcRenderer.invoke('connectors:disconnect', id),
  connectorsSetTools: (id, disabledTools) => ipcRenderer.invoke('connectors:set-tools', id, disabledTools),
  connectorsSetInstructions: (id, instructions) => ipcRenderer.invoke('connectors:set-instructions', id, instructions),
  connectorsSaveStaticClient: (id, clientId, clientSecret) =>
    ipcRenderer.invoke('connectors:save-static', id, clientId, clientSecret),
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
