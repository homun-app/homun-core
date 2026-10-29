import { contextBridge, ipcRenderer } from 'electron'
import type { SandbotApi, SandbotEvent } from '../shared/types'

const api: SandbotApi = {
  listAgents: () => ipcRenderer.invoke('agents:list'),
  createAgent: (name, description) => ipcRenderer.invoke('agents:create', name, description),
  updateAgent: (id, patch) => ipcRenderer.invoke('agents:update', id, patch),
  deleteAgent: (id) => ipcRenderer.invoke('agents:delete', id),
  // fase 7: bot principale e template
  setMainAgent: (id) => ipcRenderer.invoke('agents:set-main', id),
  listTemplates: () => ipcRenderer.invoke('templates:list'),
  createAgentFromTemplate: (templateId) => ipcRenderer.invoke('agents:create-from-template', templateId),
  getEntries: (agentId, afterId) => ipcRenderer.invoke('agents:entries', agentId, afterId),
  sendMessage: (agentId, text, images) => ipcRenderer.invoke('chat:send', agentId, text, images),
  interrupt: (agentId) => ipcRenderer.invoke('chat:interrupt', agentId),
  widgetRespond: (agentId, entryId, value) => ipcRenderer.invoke('widget:respond', agentId, entryId, value),
  draftSend: (agentId, entryId, body) => ipcRenderer.invoke('draft:send', agentId, entryId, body),
  draftDiscard: (agentId, entryId) => ipcRenderer.invoke('draft:discard', agentId, entryId),
  draftUpdate: (agentId, entryId, body) => ipcRenderer.invoke('draft:update', agentId, entryId, body),
  // fase 8: mode 'once' | 'always' | 'turn' (fino a fine turno)
  resolveApproval: (agentId, approvalId, decision, mode) =>
    ipcRenderer.invoke('approvals:resolve', agentId, approvalId, decision, mode),
  // fase 8 (§3bis L5): decisione dell'utente sulla regola proposta dal bot
  autoreviewRuleDecision: (agentId, entryId, action) =>
    ipcRenderer.invoke('autoreview:rule-decision', agentId, entryId, action),

  listProviders: () => ipcRenderer.invoke('providers:list'),
  saveProvider: (p) => ipcRenderer.invoke('providers:save', p),
  deleteProvider: (id) => ipcRenderer.invoke('providers:delete', id),
  discoverProviders: () => ipcRenderer.invoke('providers:discover'),
  testProvider: (id) => ipcRenderer.invoke('providers:test', id),
  listModels: (providerId) => ipcRenderer.invoke('models:list', providerId),
  // fase 11: chiave per la ricerca web (vault sigillato; il valore non torna mai alla UI)
  setWebSearchKey: (providerId, key) => ipcRenderer.invoke('providers:set-web-search-key', providerId, key),
  webSearchKeySet: (providerId) => ipcRenderer.invoke('providers:web-search-key-set', providerId),
  // fase 15: stato dei provider di ricerca (keyless + chiave) per le Impostazioni
  webSearchStatus: () => ipcRenderer.invoke('websearch:status'),
  getPermissions: () => ipcRenderer.invoke('permissions:get'),
  setPermissions: (cfg) => ipcRenderer.invoke('permissions:set', cfg),
  settingsGet: <T,>(key: string, fallback: T) => ipcRenderer.invoke('settings:get', key, fallback) as Promise<T>,
  settingsSet: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  quickAsk: (agentId, question) => ipcRenderer.invoke('quickask', agentId, question),
  pickImage: () => ipcRenderer.invoke('dialog:pick-image'),
  listRoutines: (agentId) => ipcRenderer.invoke('routines:list', agentId),
  createRoutine: (agentId, title, prompt, schedule) => ipcRenderer.invoke('routines:create', agentId, title, prompt, schedule),
  // fase 6: routine con trigger esteso (schedule every, email, calendar_event, webhook, poll)
  createRoutineTrigger: (agentId, title, prompt, trigger, timezone) =>
    ipcRenderer.invoke('routines:create-trigger', agentId, title, prompt, trigger, timezone),
  updateRoutineTrigger: (id, patch) => ipcRenderer.invoke('routines:update-trigger', id, patch),
  updateRoutine: (id, patch) => ipcRenderer.invoke('routines:update', id, patch),
  deleteRoutine: (id) => ipcRenderer.invoke('routines:delete', id),
  suggestRoutines: (agentId) => ipcRenderer.invoke('routines:suggest', agentId),
  // fase 6: presenza e consegna outbox
  presenceSignal: (kind) => ipcRenderer.invoke('presence:signal', kind),
  presenceViewing: (agentId) => ipcRenderer.invoke('presence:viewing', agentId),
  outboxOpened: (agentId) => ipcRenderer.invoke('outbox:opened', agentId),
  // fase 8 (§3bis L7): task thread
  listTasks: (agentId) => ipcRenderer.invoke('tasks:list', agentId),
  cancelTask: (taskId) => ipcRenderer.invoke('tasks:cancel', taskId),
  // fase 10: gruppi di bot
  listGroups: () => ipcRenderer.invoke('groups:list'),
  groupMessages: (groupId) => ipcRenderer.invoke('groups:messages', groupId),
  groupSendUser: (groupId, text) => ipcRenderer.invoke('groups:send-user', groupId, text),
  // fase 12: sottoagenti del padre e bottone Ferma sulla card
  listSubagents: (parentId) => ipcRenderer.invoke('subagents:list', parentId),
  stopSubagent: (id) => ipcRenderer.invoke('subagents:stop', id),
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
  // fase 13: registro, plugin, marketplace, gateway
  connectorsInstalled: () => ipcRenderer.invoke('connectors:installed'),
  connectorsResolveMcpServer: (agentId, entryId, decision) =>
    ipcRenderer.invoke('connectors:resolve-mcp-server', agentId, entryId, decision),
  connectorsSaveServerValues: (serverId, kind, values) =>
    ipcRenderer.invoke('connectors:save-server-values', serverId, kind, values),
  connectorsSetEnabledFor: (kind, id, agentIds) =>
    ipcRenderer.invoke('connectors:set-enabled-for', kind, id, agentIds),
  connectorsUninstallServer: (id) => ipcRenderer.invoke('connectors:uninstall-server', id),
  connectorsReconnectServer: (id) => ipcRenderer.invoke('connectors:reconnect-server', id),
  connectorsAddGateway: (input) => ipcRenderer.invoke('connectors:add-gateway', input),
  connectorsGatewayPresets: () => ipcRenderer.invoke('connectors:gateway-presets'),
  connectorsSetClientMetadataUrl: (url) => ipcRenderer.invoke('connectors:set-client-metadata-url', url),
  pluginsResolve: (agentId, entryId, decision) => ipcRenderer.invoke('plugins:resolve', agentId, entryId, decision),
  pluginsUninstall: (name, marketplace) => ipcRenderer.invoke('plugins:uninstall', name, marketplace),
  marketplaceList: () => ipcRenderer.invoke('marketplace:list'),
  marketplaceAdd: (source) => ipcRenderer.invoke('marketplace:add', source),
  marketplaceRemove: (source) => ipcRenderer.invoke('marketplace:remove', source),
  vaultList: () => ipcRenderer.invoke('vault:list'),
  vaultStore: (name, value) => ipcRenderer.invoke('vault:store', name, value),
  vaultDelete: (name) => ipcRenderer.invoke('vault:delete', name),
  // fase 14: vault esteso (login, contatti, concessioni) e modulo sicuro
  vaultItems: () => ipcRenderer.invoke('vault:items'),
  vaultSaveLogin: (input) => ipcRenderer.invoke('vault:save-login', input),
  vaultSaveContact: (input) => ipcRenderer.invoke('vault:save-contact', input),
  vaultDeleteItem: (kind, key) => ipcRenderer.invoke('vault:delete-item', kind, key),
  vaultGetContact: (id) => ipcRenderer.invoke('vault:get-contact', id),
  fillGrants: () => ipcRenderer.invoke('fills:grants'),
  fillGrantRevoke: (id) => ipcRenderer.invoke('fills:revoke', id),
  secureInputSubmit: (agentId, approvalId, values) => ipcRenderer.invoke('secureinput:submit', agentId, approvalId, values),
  // fase 14: la libreria
  libraryList: (query, kind) => ipcRenderer.invoke('library:list', query, kind),
  libraryGet: (id, version) => ipcRenderer.invoke('library:get', id, version),
  libraryDelete: (id) => ipcRenderer.invoke('library:delete', id),
  libraryRename: (id, title) => ipcRenderer.invoke('library:rename', id, title),
  libraryPin: (id, pinned) => ipcRenderer.invoke('library:pin', id, pinned),
  libraryExport: (id, format) => ipcRenderer.invoke('library:export', id, format),
  libraryStats: () => ipcRenderer.invoke('library:stats'),
  libraryRestoreVersion: (id, version) => ipcRenderer.invoke('library:restore-version', id, version),
  getLaunchAtLogin: () => ipcRenderer.invoke('launch-at-login:get'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('launch-at-login:set', enabled),
  onEvent: (cb) => {
    const listener = (_e: unknown, ev: SandbotEvent) => cb(ev)
    ipcRenderer.on('sandbot:event', listener)
    return () => ipcRenderer.removeListener('sandbot:event', listener)
  }
}

contextBridge.exposeInMainWorld('sandbot', api)
