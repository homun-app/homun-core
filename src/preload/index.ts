import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SandbotApi, SandbotEvent } from '../shared/types'

const api: SandbotApi = {
  listAgents: () => ipcRenderer.invoke('agents:list'),
  createAgent: (name, description) => ipcRenderer.invoke('agents:create', name, description),
  updateAgent: (id, patch) => ipcRenderer.invoke('agents:update', id, patch),
  deleteAgent: (id) => ipcRenderer.invoke('agents:delete', id),
  // K2 (fase team-bot): archivia/ripristina dal menu «⋯» della barra
  archiveAgent: (id) => ipcRenderer.invoke('agents:archive', id),
  unarchiveAgent: (id) => ipcRenderer.invoke('agents:unarchive', id),
  restoreAgent: (id) => ipcRenderer.invoke('agents:restore', id),
  // fase 7: bot principale e template
  setMainAgent: (id) => ipcRenderer.invoke('agents:set-main', id),
  listTemplates: () => ipcRenderer.invoke('templates:list'),
  createAgentFromTemplate: (templateId) => ipcRenderer.invoke('agents:create-from-template', templateId),
  getEntries: (agentId, afterId) => ipcRenderer.invoke('agents:entries', agentId, afterId),
  // fase pagine (G2/G6): readingPage = la pagina aperta mentre l'utente scrive
  sendMessage: (agentId, text, images, readingPage) => ipcRenderer.invoke('chat:send', agentId, text, images, readingPage),
  interrupt: (agentId) => ipcRenderer.invoke('chat:interrupt', agentId),
  widgetRespond: (agentId, entryId, value) => ipcRenderer.invoke('widget:respond', agentId, entryId, value),
  // fase 19a: lo schermo del bot (vista dal vivo, presa di controllo, stato)
  // SV1 (fase schermo-vivo): opts.peek = anteprima che non avvia mai il browser
  screenOpen: (agentId, mode, opts) => ipcRenderer.invoke('screen:open', agentId, mode, opts),
  screenRelease: (agentId, note) => ipcRenderer.invoke('screen:release', agentId, note),
  screenStatus: (agentId) => ipcRenderer.invoke('screen:status', agentId),
  // SV4 (fase schermo-vivo): la finestra PiP (canali LOCALI del main)
  pipOpen: (agentId) => ipcRenderer.invoke('pip:open', agentId),
  pipClose: () => ipcRenderer.invoke('pip:close'),
  pipFocusMain: (agentId) => ipcRenderer.invoke('pip:focus-main', agentId),
  pipState: () => ipcRenderer.invoke('pip:state'),
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
  // fase 8: mode 'once' | 'always' | 'turn' (fino a fine turno); fase use-app: anche 'minutes10';
  // A2 (fase approvazioni-chiare): via 'chat' | 'center' | 'notification' — finisce nel registro
  resolveApproval: (agentId, approvalId, decision, mode, via) =>
    ipcRenderer.invoke('approvals:resolve', agentId, approvalId, decision, mode, via),
  // A1 (fase centro-autorizzazioni): tutte le richieste pendenti, per il centro
  approvalsPendingAll: () => ipcRenderer.invoke('approvals:pending-all'),
  // A3 (fase approvazioni-chiare): il numero delle richieste sull'icona del Dock
  setDockBadge: (count) => ipcRenderer.invoke('app:dock-badge', count),
  // A2 (fase approvazioni-chiare): il registro delle decisioni (e delle passate da sole)
  approvalsLog: (limit) => ipcRenderer.invoke('approvals:log', limit),
  // D2 (fase deleghe): lo stato dei job delle deleghe accodate e l'Annulla
  delegationsStatus: (jobIds) => ipcRenderer.invoke('delegations:status', jobIds),
  delegationsCancel: (jobId) => ipcRenderer.invoke('delegations:cancel', jobId),
  // B2 (fase b20-bug): «Riprova» dopo una risposta vuota — lo stesso turno, un'altra volta
  turnRetry: (agentId, entryId) => ipcRenderer.invoke('turn:retry', agentId, entryId),
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
  // fase locale (L3/L4): il modello integrato (stato, download, annullamento, rimozione)
  localModelStatus: () => ipcRenderer.invoke('local-model:status'),
  localModelInstall: () => ipcRenderer.invoke('local-model:install'),
  localModelCancel: () => ipcRenderer.invoke('local-model:cancel'),
  localModelRestart: () => ipcRenderer.invoke('local-model:restart'),
  localModelRemove: () => ipcRenderer.invoke('local-model:remove'),
  // OBV4: la Continua del pannello Integrato — models.main se manca, passo chiuso
  localModelEnsureMain: () => ipcRenderer.invoke('local-model:ensure-main'),
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
  // OA1 (fase onboarding-a): lo stato del primo avvio (caricamento finché non risponde).
  // OA2: advance chiude il passo corrente (done|skipped), reopen riapre un passo saltato o rifà da capo
  onboardingState: () => ipcRenderer.invoke('onboarding:state') as Promise<import('../shared/types').OnboardingStatus>,
  onboardingAdvance: (step, outcome) => ipcRenderer.invoke('onboarding:advance', step, outcome) as Promise<import('../shared/types').OnboardingStatus | false>,
  onboardingReopen: (target) => ipcRenderer.invoke('onboarding:reopen', target) as Promise<import('../shared/types').OnboardingStatus | false>,
  onboardingFocusDismiss: (entryId) => ipcRenderer.invoke('onboarding:focus-dismiss', entryId) as Promise<{ ok: boolean }>,
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
  presenceWindowFocus: (focused) => ipcRenderer.invoke('presence:window-focus', focused),
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
  groupDelete: (groupId, alsoDeleteMembers) => ipcRenderer.invoke('groups:delete', groupId, alsoDeleteMembers),
  // K2 (fase team-bot): archivia/ripristina il team dal menu «⋯» della barra
  groupArchive: (groupId) => ipcRenderer.invoke('groups:archive', groupId),
  groupUnarchive: (groupId) => ipcRenderer.invoke('groups:unarchive', groupId),
  groupRestore: (groupId) => ipcRenderer.invoke('groups:restore', groupId),
  /** Q2 (fase squadra): le card pendenti dei membri e dei loro sottoagenti */
  groupPendingApprovals: (groupId: number) => ipcRenderer.invoke('groups:pending-approvals', groupId),
  /** Q4 (fase squadra): le card di approvazione della timeline della squadra */
  groupApprovalCards: (groupId: number) => ipcRenderer.invoke('groups:approval-cards', groupId),
  /** Q5 (fase squadra): la vista del team (stati, contatori, prodotto) */
  groupOverview: (groupId: number) => ipcRenderer.invoke('groups:overview', groupId),
  // fase 12: sottoagenti del padre e bottone Ferma sulla card
  listSubagents: (parentId) => ipcRenderer.invoke('subagents:list', parentId),
  stopSubagent: (id) => ipcRenderer.invoke('subagents:stop', id),
  // fase 4: memoria e skill dell'agente
  // fase memoria-engramma (M6): la sezione Memoria sul motore Engramma
  memoryOverview: (agentId) => ipcRenderer.invoke('memory:overview', agentId),
  memoryList: (agentId, opts) => ipcRenderer.invoke('memory:list', agentId, opts),
  memorySearch: (agentId, query, opts) => ipcRenderer.invoke('memory:search', agentId, query, opts),
  memoryNote: (agentId, id) => ipcRenderer.invoke('memory:note', agentId, id),
  memorySave: (agentId, input) => ipcRenderer.invoke('memory:save', agentId, input),
  memoryConfirm: (agentId, id) => ipcRenderer.invoke('memory:confirm', agentId, id),
  memoryDiscard: (agentId, id) => ipcRenderer.invoke('memory:discard', agentId, id),
  memoryDelete: (agentId, id) => ipcRenderer.invoke('memory:delete', agentId, id),
  memoryRestore: (agentId, id) => ipcRenderer.invoke('memory:restore', agentId, id),
  memoryPurge: (agentId, id) => ipcRenderer.invoke('memory:purge', agentId, id),
  memoryModelPull: () => ipcRenderer.invoke('memory:model-pull'),
  // fase skill: la finestra «Skill» — libreria unica, editor, versioni, GitHub
  skillsLibrary: () => ipcRenderer.invoke('skills:library'),
  // K2 (fase skill ritocchi): l'elenco `/` del compositore, senza i corpi
  skillsInvocable: (agentId) => ipcRenderer.invoke('skills:invocable', agentId),
  skillsGet: (name) => ipcRenderer.invoke('skills:get', name),
  skillsSave: (rec) => ipcRenderer.invoke('skills:save', rec),
  skillsDelete: (name) => ipcRenderer.invoke('skills:delete', name),
  skillsSetEnabledFor: (name, ids) => ipcRenderer.invoke('skills:set-enabled-for', name, ids),
  skillsSetEnabled: (name, enabled) => ipcRenderer.invoke('skills:set-enabled', name, enabled),
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
  // PP2 (fase plugin-pulita): «Cambia token» nella scheda del plugin — solo il segreto, poi il test da solo
  mcpReplaceSecret: (id, secret) => ipcRenderer.invoke('mcp:replace-secret', id, secret),
  // PP2: i nomi dei segreti salvati (mai i valori) — la riga Account e la Cassaforte «Dei plugin»
  mcpSecretNames: () => ipcRenderer.invoke('mcp:secret-names'),
  // PL2 (fase plugin): gli strumenti di un server (nome, descrizione,
  // annotazioni) per la scheda «Autorizzazioni» della pagina Plugin
  mcpTools: (id) => ipcRenderer.invoke('mcp:tools', id),
  // PL3 (fase plugin): l'uso degli strumenti (ultimo uso + settimana, indice)
  pluginsUsage: () => ipcRenderer.invoke('plugins:usage'),
  // PL6 (fase plugin): «Importa skill» — la scansione parte SOLO al clic
  skillsImportScan: (extraDirs) => ipcRenderer.invoke('skills-import:scan', extraDirs),
  skillsImportPickFolder: () => ipcRenderer.invoke('skills-import:pick-folder'),
  skillsImportApply: (payload) => ipcRenderer.invoke('skills-import:apply', payload),
  /**
   * E2 (fase mcp-env): «Importa da Cursor, Claude o ZCode» — la scansione e
   * la conferma leggono quei file SOLO al clic, nel main. Le righe non
   * portano MAI valori (solo nomi e quali sono segreti).
   */
  mcpImportScan: () => ipcRenderer.invoke('mcp-import:scan'),
  mcpImportApply: (picks) => ipcRenderer.invoke('mcp-import:apply', picks),
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
  pluginsEnableCard: (agentId, entryId, decision) => ipcRenderer.invoke('plugins:enable', agentId, entryId, decision),
  pluginsUninstall: (name, marketplace) => ipcRenderer.invoke('plugins:uninstall', name, marketplace),
  // fase app (A2–A4): Composio con la chiave dell'utente (la chiave NON torna
  // mai indietro: status porta solo hasKey e le ultime 4 cifre)
  composioStatus: () => ipcRenderer.invoke('composio:status'),
  composioSetKey: (key) => ipcRenderer.invoke('composio:set-key', key),
  composioSetConnectorEnabled: (slug, enabled) => ipcRenderer.invoke('composio:set-connector-enabled', slug, enabled),
  composioTest: () => ipcRenderer.invoke('composio:test'),
  composioDisable: () => ipcRenderer.invoke('composio:disable'),
  composioConnect: (slug) => ipcRenderer.invoke('composio:connect', slug),
  composioDisconnect: (slug) => ipcRenderer.invoke('composio:disconnect', slug),
  // fase Composio OAuth (C5): le app dentro il server Composio collegato col login
  composioGatewayStatus: () => ipcRenderer.invoke('composio-gateway:status'),
  composioGatewayRefresh: () => ipcRenderer.invoke('composio-gateway:refresh'),
  composioGatewayConnect: (slug, name, opts) => ipcRenderer.invoke('composio-gateway:connect', slug, name, opts),
  composioGatewayRemove: (slug) => ipcRenderer.invoke('composio-gateway:remove', slug),
  composioGatewayRenameAccount: (slug, accountId, alias) => ipcRenderer.invoke('composio-gateway:rename-account', slug, accountId, alias),
  composioGatewayRemoveAccount: (slug, accountId) => ipcRenderer.invoke('composio-gateway:remove-account', slug, accountId),
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
  // fase pagine (G2): il SVG di un blocco vega-lite lo produce il daemon (CSP)
  renderChartSpec: (spec) => ipcRenderer.invoke('library:render-chart', spec),
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
  // fase box-container (BX3): «Spazio su disco» nelle Impostazioni
  boxDiskSpace: () => ipcRenderer.invoke('box:disk-space'),
  boxImageRemove: () => ipcRenderer.invoke('box:image-remove'),
  boxBoxFilesRemove: () => ipcRenderer.invoke('box:box-files-remove'),
  boxSpacePrune: () => ipcRenderer.invoke('box:space-prune'),
  /** CC2 (fase computer-card): lo stato del box (la RPC RILEGGE e risponde) */
  boxRuntime: () => ipcRenderer.invoke('box:runtime'),
  memoryModelRemove: () => ipcRenderer.invoke('memory:model-remove'),
  // fase box-container (BX4): il motore nelle Impostazioni
  boxEngineStatus: () => ipcRenderer.invoke('box:engine-status'),
  boxEngineSet: (engine) => ipcRenderer.invoke('box:engine-set', engine),
  boxEngineStart: () => ipcRenderer.invoke('box:engine-start'),
  boxEngineKernelInstall: () => ipcRenderer.invoke('box:engine-kernel-install'),
  // OB1 (fase onboarding-b): la preparazione del computer del bot
  boxSetupState: () => ipcRenderer.invoke('box:setup-state'),
  /** OBD2: il piano — i passi che la preparazione farà (il consenso elenca solo quelli) */
  boxSetupPlan: () => ipcRenderer.invoke('box:setup-plan'),
  boxSetupStart: () => ipcRenderer.invoke('box:setup-start'),
  /** MB3 (fase modalita-box): la scelta dell'utente — dove girano i comandi del bot */
  boxModeSet: (mode: 'box' | 'host') => ipcRenderer.invoke('box:mode-set', mode),
  boxSetupCancel: () => ipcRenderer.invoke('box:setup-cancel'),
  boxSetupRetry: () => ipcRenderer.invoke('box:setup-retry'),
  boxSetupOpenInstaller: () => ipcRenderer.invoke('box:setup-open-installer'),
  boxEngineUninstall: () => ipcRenderer.invoke('box:engine-uninstall'),
  // fase rilascio (A8): aggiornamento e rinnovo da Homun 2.
  // RP3 (fase rilascio di prova): il canale si cambia dall'interruttore delle
  // Impostazioni e ha effetto immediato (nessun riavvio)
  updaterStatus: () => ipcRenderer.invoke('updater:status'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  setUpdaterChannel: (channel) => ipcRenderer.invoke('updater:set-channel', channel),
  // RV1 (fase beta.2): ripropone lo spostamento in Applicazioni
  moveToApplications: () => ipcRenderer.invoke('app:move-to-applications'),
  legacyHomun2: () => ipcRenderer.invoke('app:legacy-homun2'),
  legacyHomun2Dismiss: () => ipcRenderer.invoke('app:legacy-homun2-dismiss'),
  revealInFinder: (dir) => ipcRenderer.invoke('app:reveal-in-finder', dir),
  // W2 (fase avvio-finestra): lo stato del caricamento (e «Riprova») mentre
  // il daemon si avvia — canali LOCALI del main
  bootStatus: () => ipcRenderer.invoke('boot:status'),
  bootRetry: () => ipcRenderer.invoke('boot:retry'),
  // P1 (fase primo-avvio): il primo paint di React — il main lo scrive nel
  // registro del ciclo di vita (renderer-ready)
  firstPaint: (framed) => ipcRenderer.invoke('app:first-paint', framed),
  /**
   * W3 (fase avvio-finestra): gancio delle SONDE — emette l'activate vero
   * (il clic sul Dock non si può simulare altrimenti). Rifiuta fuori dalle
   * prove (SANDBOT_TEST_USER_DATA).
   */
  testEmitActivate: () => ipcRenderer.invoke('test:emit-activate'),
  // U6 (fase mcp-ui): il ⌘Q di prova delle sonde (come testEmitActivate)
  testEmitQuit: () => ipcRenderer.invoke('test:emit-quit'),
  // fase 17a (L5): il main ricostruisce il tray nella lingua scelta
  uiLanguageChanged: (lang) => ipcRenderer.invoke('ui:language-changed', lang),
  onEvent: (cb) => {
    const listener = (_e: unknown, ev: SandbotEvent) => cb(ev)
    ipcRenderer.on('sandbot:event', listener)
    return () => ipcRenderer.removeListener('sandbot:event', listener)
  }
}

contextBridge.exposeInMainWorld('sandbot', api)
