import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  // fase 19a: lo schermo del bot (vista dal vivo, presa di controllo, stato)
  screenOpen: (agentId, mode) => ipcRenderer.invoke('screen:open', agentId, mode),
  screenRelease: (agentId, note) => ipcRenderer.invoke('screen:release', agentId, note),
  screenStatus: (agentId) => ipcRenderer.invoke('screen:status', agentId),
  // fase 19b (T2): il terminale del bot (solo docker)
  terminalOpen: (agentId) => ipcRenderer.invoke('terminal:open', agentId),
  // fase 19b (T3): i file del box — elenco, anteprima e le finestre del Mac
  // (il path del Mac lo scelgono i dialog del main o il trascinamento)
  filesList: (agentId, path) => ipcRenderer.invoke('files:list', agentId, path),
  filesRead: (agentId, path) => ipcRenderer.invoke('files:read', agentId, path),
  filesDownload: (agentId, path) => ipcRenderer.invoke('files:download', agentId, path),
  filesUpload: (agentId, dirPath) => ipcRenderer.invoke('files:upload', agentId, dirPath),
  // fase 19b (T3.2, correzioni U1): il file TRASCINATO dal Finder — il path
  // del Mac lo calcola SOLO il preload dall'oggetto File del drop
  // (webUtils.getPathForFile); la pagina NON può passare una stringa e un
  // File costruito col codice dà '' (qui sotto → rifiuto senza chiamare il
  // main). Il path non torna MAI indietro al renderer.
  filesImportDropped: (agentId, dirPath, file, overwrite) => {
    let fromDrop = ''
    try {
      fromDrop = webUtils.getPathForFile(file)
    } catch {
      fromDrop = ''
    }
    if (!fromDrop) return Promise.reject(new Error('not a dropped file'))
    return ipcRenderer.invoke('files:import-dropped', agentId, dirPath, fromDrop, overwrite)
  },
  // fase 19b (T4): il feed dell'attività del computer del bot
  activityList: (agentId, limit) => ipcRenderer.invoke('activity:list', agentId, limit),
  activityOutput: (agentId, id) => ipcRenderer.invoke('activity:output', agentId, id),
  // fase 16c (C5): il feed globale Attività; (C4) la ricerca nel registro MCP
  activityGlobal: (limit) => ipcRenderer.invoke('activity:global', limit),
  connectorsSearchRegistry: (query) => ipcRenderer.invoke('connectors:search-registry', query),
  draftSend: (agentId, entryId, body) => ipcRenderer.invoke('draft:send', agentId, entryId, body),
  draftDiscard: (agentId, entryId) => ipcRenderer.invoke('draft:discard', agentId, entryId),
  draftUpdate: (agentId, entryId, body) => ipcRenderer.invoke('draft:update', agentId, entryId, body),
  // fase 8: mode 'once' | 'always' | 'turn' (fino a fine turno); fase use-app: anche 'minutes10'
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
  // fase 16c (C3.4): la prova di una configurazione NON salvata (la chiave va
  // solo in questa direzione e non torna mai indietro)
  probeProvider: (config) => ipcRenderer.invoke('providers:probe', config),
  listModels: (providerId) => ipcRenderer.invoke('models:list', providerId),
  // fase 18b (K3): le capacità di UN modello (nessun elenco completo in chat)
  modelCapabilities: (providerId, model) => ipcRenderer.invoke('models:capabilities', providerId, model),
  // fase 18b (H6): uso e costi aggregati (per modello/bot/origine)
  usageSummary: (fromMs, toMs, groupBy) => ipcRenderer.invoke('usage:summary', fromMs, toMs, groupBy),
  // fase 11: chiave per la ricerca web (vault sigillato; il valore non torna mai alla UI)
  setWebSearchKey: (providerId, key) => ipcRenderer.invoke('providers:set-web-search-key', providerId, key),
  webSearchKeySet: (providerId) => ipcRenderer.invoke('providers:web-search-key-set', providerId),
  // fase 15: stato dei provider di ricerca (keyless + chiave) per le Impostazioni
  webSearchStatus: () => ipcRenderer.invoke('websearch:status'),
  getPermissions: () => ipcRenderer.invoke('permissions:get'),
  setPermissions: (cfg) => ipcRenderer.invoke('permissions:set', cfg),
  // M4 (fase 0.3.1001): standing grant in elenco/revoca + «sempre le letture di <server>»
  grantsList: () => ipcRenderer.invoke('grants:list'),
  grantRevoke: (id) => ipcRenderer.invoke('grants:revoke', id),
  grantServerReads: (slug) => ipcRenderer.invoke('permissions:grant-server-reads', slug),
  settingsGet: <T,>(key: string, fallback: T) => ipcRenderer.invoke('settings:get', key, fallback) as Promise<T>,
  settingsSet: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  quickAsk: (agentId, question) => ipcRenderer.invoke('quickask', agentId, question),
  pickImage: () => ipcRenderer.invoke('dialog:pick-image'),
  listRoutines: (agentId) => ipcRenderer.invoke('routines:list', agentId),
  createRoutine: (agentId, title, prompt, schedule, model) => ipcRenderer.invoke('routines:create', agentId, title, prompt, schedule, model),
  // fase 6: routine con trigger esteso (schedule every, email, calendar_event, webhook, poll)
  createRoutineTrigger: (agentId, title, prompt, trigger, timezone, model) =>
    ipcRenderer.invoke('routines:create-trigger', agentId, title, prompt, trigger, timezone, model),
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
  // fase 16b (S1.3): squadre create e modificate dalla UI
  groupCreate: (name, memberIds, coordinatorId, description) =>
    ipcRenderer.invoke('groups:create', name, memberIds, coordinatorId, description),
  groupUpdate: (groupId, patch) => ipcRenderer.invoke('groups:update', groupId, patch),
  groupDelete: (groupId) => ipcRenderer.invoke('groups:delete', groupId),
  // fase 12: sottoagenti del padre e bottone Ferma sulla card
  listSubagents: (parentId) => ipcRenderer.invoke('subagents:list', parentId),
  stopSubagent: (id) => ipcRenderer.invoke('subagents:stop', id),
  // fase 4: memoria e skill dell'agente
  listMemories: (agentId) => ipcRenderer.invoke('memory:list', agentId),
  updateMemory: (agentId, id, content) => ipcRenderer.invoke('memory:update', agentId, id, content),
  deleteMemory: (agentId, id) => ipcRenderer.invoke('memory:delete', agentId, id),
  // fase skill: la finestra «Skill» — libreria unica, editor, versioni, GitHub
  skillsLibrary: () => ipcRenderer.invoke('skills:library'),
  // K2 (fase skill ritocchi): l'elenco `/` del compositore, senza i corpi
  skillsInvocable: (agentId) => ipcRenderer.invoke('skills:invocable', agentId),
  skillsGet: (name) => ipcRenderer.invoke('skills:get', name),
  skillsSave: (rec) => ipcRenderer.invoke('skills:save', rec),
  skillsDelete: (name) => ipcRenderer.invoke('skills:delete', name),
  skillsSetEnabledFor: (name, ids) => ipcRenderer.invoke('skills:set-enabled-for', name, ids),
  skillsReadFile: (folder, file) => ipcRenderer.invoke('skills:read-file', folder, file),
  skillsVersions: (name) => ipcRenderer.invoke('skills:versions', name),
  skillsRestoreVersion: (name, file) => ipcRenderer.invoke('skills:restore-version', name, file),
  skillsExport: (name) => ipcRenderer.invoke('skills:export', name),
  skillsShowInFinder: (name) => ipcRenderer.invoke('skills:show-in-finder', name),
  skillsGithubPreview: (url) => ipcRenderer.invoke('skills:github-preview', url),
  skillsGithubAdd: (id, choices, enabledFor) => ipcRenderer.invoke('skills:github-add', id, choices, enabledFor),
  skillsGithubUpdatePreview: (name) => ipcRenderer.invoke('skills:github-update-preview', name),
  skillsGithubUpdateApply: (id, name) => ipcRenderer.invoke('skills:github-update-apply', id, name),
  // fase skill · catalogo (K2/K3): il catalogo curato del repo e l'aggiunta di una voce
  skillsCatalog: () => ipcRenderer.invoke('skills:catalog'),
  skillsCatalogPreview: (id) => ipcRenderer.invoke('skills:catalog-preview', id),
  skillsCatalogInstall: (previewId, enabledFor) => ipcRenderer.invoke('skills:catalog-install', previewId, enabledFor),
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
  // fase mcp-setup (M3): il modulo di configurazione del server (card e foglio)
  connectorsServerSetup: (id) => ipcRenderer.invoke('connectors:server-setup', id),
  connectorsServerConnect: (id, input) => ipcRenderer.invoke('connectors:server-connect', id, input),
  connectorsAddGateway: (input) => ipcRenderer.invoke('connectors:add-gateway', input),
  connectorsGatewayPresets: () => ipcRenderer.invoke('connectors:gateway-presets'),
  connectorsSetClientMetadataUrl: (url) => ipcRenderer.invoke('connectors:set-client-metadata-url', url),
  pluginsResolve: (agentId, entryId, decision) => ipcRenderer.invoke('plugins:resolve', agentId, entryId, decision),
  pluginsUninstall: (name, marketplace) => ipcRenderer.invoke('plugins:uninstall', name, marketplace),
  // fase app (A2–A4): Composio con la chiave dell'utente (la chiave NON torna
  // mai indietro: status porta solo hasKey e le ultime 4 cifre)
  composioStatus: () => ipcRenderer.invoke('composio:status'),
  composioSetKey: (key) => ipcRenderer.invoke('composio:set-key', key),
  composioTest: () => ipcRenderer.invoke('composio:test'),
  composioDisable: () => ipcRenderer.invoke('composio:disable'),
  composioConnect: (slug) => ipcRenderer.invoke('composio:connect', slug),
  composioDisconnect: (slug) => ipcRenderer.invoke('composio:disconnect', slug),
  // fase Composio OAuth (C5): le app dentro il server Composio collegato col login
  composioGatewayStatus: () => ipcRenderer.invoke('composio-gateway:status'),
  composioGatewayRefresh: () => ipcRenderer.invoke('composio-gateway:refresh'),
  composioGatewayConnect: (slug, name) => ipcRenderer.invoke('composio-gateway:connect', slug, name),
  composioGatewayRemove: (slug) => ipcRenderer.invoke('composio-gateway:remove', slug),
  composioGatewayCancel: () => ipcRenderer.invoke('composio-gateway:cancel'),
  composioGatewayCardConnect: (key) => ipcRenderer.invoke('composio-gateway:card-connect', key),
  // fase catalogo app (P4): «Connetti» in un passo dalla riga dell'elenco
  appsConnect: (appId) => ipcRenderer.invoke('apps:connect', appId),
  appsCancelConnect: (appId) => ipcRenderer.invoke('apps:cancel-connect', appId),
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
  // fase rilascio (A3): apre Impostazioni › Elementi login
  openLoginItemsSettings: () => ipcRenderer.invoke('open-login-items-settings'),
  // fase use-app (U4): apre Privacy → Accessibilità dalle Impostazioni di sistema
  openAccessibilitySettings: () => ipcRenderer.invoke('open-accessibility-settings'),
  // fase rilascio (A7): stato di docker
  boxDockerStatus: () => ipcRenderer.invoke('box:docker-status'),
  boxDockerRetry: () => ipcRenderer.invoke('box:docker-retry'),
  // fase rilascio (A8): aggiornamento e rinnovo da Homun 2
  updaterStatus: () => ipcRenderer.invoke('updater:status'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  legacyHomun2: () => ipcRenderer.invoke('app:legacy-homun2'),
  legacyHomun2Dismiss: () => ipcRenderer.invoke('app:legacy-homun2-dismiss'),
  revealInFinder: (dir) => ipcRenderer.invoke('app:reveal-in-finder', dir),
  // fase 17a (L5): il main ricostruisce il tray nella lingua scelta
  uiLanguageChanged: (lang) => ipcRenderer.invoke('ui:language-changed', lang),
  onEvent: (cb) => {
    const listener = (_e: unknown, ev: SandbotEvent) => cb(ev)
    ipcRenderer.on('sandbot:event', listener)
    return () => ipcRenderer.removeListener('sandbot:event', listener)
  }
}

contextBridge.exposeInMainWorld('sandbot', api)
