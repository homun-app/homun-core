// Entrypoint del daemon sandbotd: processo Node PURO (nessun import da
// 'electron'). Avviato dall'app o dal LaunchAgent con l'eseguibile Electron
// in modalità ELECTRON_RUN_AS_NODE=1, tiene in vita il runtime degli agenti
// (loop, coda durevole, scheduler, sandbox, MCP) anche a finestra chiusa e
// riprende il lavoro dopo un crash o un riavvio.
//
// Avvio: node daemon.js [--data <dir>]  (oppure env SANDBOT_DATA_DIR)
// All'avvio acquisisce il lock (un solo daemon per directory dati), apre lo
// store, avvia il server WebSocket (porta casuale, token in daemon.json 0600)
// e i tick di worker e scheduler.
//
// Fase 6: sulla stessa porta del WebSocket rispondono i webhook dei trigger
// (POST /hooks/<routineId>); il tick dello scheduler copre anche i poll dei
// connettori, la pausa delle routine per assenza lunga e la consegna
// dell'outbox nelle finestre; le notifiche agent-done/agent-needs-input
// passano dalle regole di soppressione (notifications.ts).
import {
  setDataDir, dataDir, db, getAgent, getEntries, getSetting, setSetting,
  listAgents, listRoutines, updateRoutine, appendEntry, updateEntryMeta, updateAgent, listProviders, createAgent,
  setAgentStopperForDaemon as store_setAgentStopper
} from '../main/store/db'
import { requeueAllLeased, enqueueJob } from '../main/store/jobs'
import { acquireDaemonLock, releaseDaemonLock, writeDaemonInfo, removeDaemonInfo } from './daemon-files'
import { startWsServer, generateToken } from './ws-server'
import { buildApiMethods } from './api'
import { JobWorker } from './worker'
import { tickScheduler, tickConnectorPolls, enqueueRoutineRun } from './scheduler'
import { attachHostBridge } from './host-bridge'
import { makeJobRunner } from './run-job'
import { wireConnectors } from '../main/connectors/wiring'
// fase 13: connettori su larga scala (marketplace, installazioni, registro)
import { createMarketplaceManager } from '../main/connectors/marketplace-manager'
import { createConnectorsSecretStore } from '../main/connectors/sealed-store'
import { findRegistryEntry, fetchRegistryEntries } from '../main/connectors/registry'
import { setConnectorsSearchRunner } from '../main/connectors/search-runtime'
import { setInstallDeps } from '../main/connectors/install-bridge'
import { getConnectorsKey } from './keychain'
import { sandboxMode } from '../main/sandbox'
import { spawn } from 'node:child_process'
import { createPresence, mainAgentOf } from './presence'
import { handleWebhook } from './webhooks'
import { deliverDueHeld } from './outbox'
import { decideNotification, notifyTexts } from './notifications'
import { enqueueUserMessage } from './enqueue'
// fase 17c (C2): notice col testo del catalogo UI
import { uiLanguage, formatUi, ui } from '../main/ui-language'
import { UI } from '../shared/ui-messages'
import { secondaryPrompts } from '../main/agent/prompts'
import { loadTemplates, buildKickstartMessage } from '../main/templates'
import { createOnboarding } from './onboarding'
import { join } from 'node:path'
import type { SandbotEvent } from '../shared/types'
import { currentUserLanguage } from '../main/agent/user-language'

function resolveDataDirArgv(argv: string[]): string | null {
  const i = argv.indexOf('--data')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]!
  return null
}

async function main(): Promise<void> {
  const argDir = resolveDataDirArgv(process.argv)
  const dir = argDir ?? process.env.SANDBOT_DATA_DIR
  if (dir) setDataDir(dir)

  const lock = acquireDaemonLock(dataDir())
  if (!lock.ok) {
    console.error(`[sandbotd] daemon già attivo (pid ${lock.pid}): esco`)
    process.exit(1)
  }

  const database = db()

  // fase 12: il broadcast si riempie quando il server ws esiste; il boot lo
  // usa per il risveglio dei lotti (gli eventi persi prima della connessione
  // della UI si ricaricano comunque al primo 'agents'/'subagents')
  let broadcast: (e: SandbotEvent) => void = () => undefined
  const emitBoot = (e: SandbotEvent): void => broadcast(e)

  // fase 11 (punto 2): la web search API di Ollama legge la chiave dal vault
  // sigillato (chiave AES dal Keychain, come i connettori)
  {
    const { setWebSearchKeyGetter } = await import('../main/agent/web-tools')
    const { getConnectorsKey } = await import('./keychain')
    setWebSearchKeyGetter(() => getConnectorsKey())
  }

  // fase 11 (punto 1): migrazione una tantum dei vecchi box (uno per agente)
  // nel box CONDIVISO — COPIA, niente cancellazioni; notice al bot principale
  // con cosa è stato migrato e dove restano i vecchi dati (la cancellazione
  // la decide l'utente). Idempotente: un marker nel box evita di rifarla.
  try {
    const { migrateLegacyBoxes } = await import('../main/sandbox')
    const migration = await migrateLegacyBoxes(listAgents())
    if (migration.migrated.length || migration.failed.length) {
      const main = mainAgentOf(listAgents(), getSetting<string | null>('mainAgentId', null))
      if (main) {
        // fase 17c (C2): i pezzi fissi sono id del catalogo; i path delle
        // copie sono DATI (valori), restano invariati
        const migrationUi = ui(UI.boxMigrated, {
          root: join(dataDir(), 'box'),
          copied: migration.migrated.map((m) => `- ${m.from} → ${m.to}`).join('\n'),
          failed: migration.failed.length ? formatUi(ui(UI.boxMigratedFailed, { list: migration.failed.map((f) => f.from).join(', ') }), uiLanguage()) : ''
        })
        appendEntry({
          agentId: main.id, kind: 'notice', role: 'system',
          content: formatUi(migrationUi, uiLanguage()),
          meta: { ui: migrationUi }
        })
      }
      console.log(`[sandbotd] migrazione box condiviso: copiati ${migration.migrated.length} vecchi box (gli originali restano)${migration.failed.length ? `, ${migration.failed.length} non copiati (riprova al prossimo avvio)` : ''}`)
    }
  } catch (e) {
    console.error('[sandbotd] migrazione box fallita (si riprova al prossimo avvio):', e)
  }

  // fase 11b (punto 2): gli orfani del browser (server Playwright MCP rimasti
  // vivi nel container alla morte del daemon) si uccidono dal pid file —
  // best effort: senza docker o senza container non c'è nessun orfano.
  // Fase 12 (punto 1): anche i pid file dei FIGLI (browser-<childId>.pid)
  try {
    const { killBrowserOrphans } = await import('../main/agent/browser')
    const { allSubagentIds } = await import('../main/store/subagents')
    await killBrowserOrphans([...listAgents().map((a) => a.id), ...allSubagentIds(database)])
  } catch {
    // niente da uccidere
  }

  // fase 12 (punto 1): il loop registra qui il suo interrupt, così deleteAgent
  // può fermare i figli di un padre eliminato
  const loopMod = await import('../main/agent/loop')
  store_setAgentStopper(loopMod.interrupt)

  // fase 12 (correzione J2): i lotti mai SIGILLATI (crash del padre a metà
  // turno) si sigillano ora — al boot nessun padre ha un turno in corso — e
  // si controllano subito: un lotto già completo parte da qui
  {
    const { sealBatchesAtBoot } = await import('./subagent-ops')
    const sealed = sealBatchesAtBoot(database, emitBoot)
    if (sealed > 0) console.log(`[sandbotd] ${sealed} lotti di sottoagenti sigillati all'avvio (padre fermo a metà turno)`)
  }

  // fase 12 (punto 5): i lotti TUTTI terminali mai svegliati (crash tra la
  // fine dell'ultimo figlio e l'accodamento del risveglio) si svegliano ora
  {
    const { wakeDueBatchesAtBoot } = await import('./subagent-ops')
    const woken = wakeDueBatchesAtBoot(database, emitBoot)
    if (woken > 0) console.log(`[sandbotd] ${woken} lotti di sottoagenti completati svegliati all'avvio`)
  }

  const token = generateToken()
  let bridge: ReturnType<typeof attachHostBridge> | null = null
  // pokeWorker si riempie quando il worker esiste
  let pokeWorker: () => void = () => undefined

  // fase 6: presenza, look-around al rientro, pausa routine per assenza
  const presence = createPresence({
    now: () => Date.now(),
    getSetting,
    setSetting,
    emit: (e) => broadcast(e),
    listAgents,
    listRoutines,
    updateRoutine,
    appendSystemSend: (agentId, message, meta) => {
      const content = message.type === 'text' ? message.text : message.type === 'widget' ? message.prompt : ''
      const entry = appendEntry({
        agentId, kind: 'send-message', role: 'assistant',
        content,
        meta: { message, ...(meta ?? {}) }
      })
      broadcast({ type: 'entries', agentId, entries: [entry] })
    },
    enqueueLookaround: (agentId) => {
      enqueueUserMessage(database, agentId, secondaryPrompts.lookAround(), undefined, (e) => broadcast(e), undefined, 'LOOK_AROUND')
      pokeWorker()
    },
    enqueueRoutineRun: (routine, event) => {
      enqueueRoutineRun(database, routine, Date.now(), event)
      pokeWorker()
    },
    pokeWorker: () => pokeWorker()
  })

  const server = await startWsServer({
    token,
    // fase 6: i webhook dei trigger sulla stessa porta del ws (spec: porta del daemon)
    httpHandler: (req, res) => handleWebhook(req, res, { db: database, emit: (e) => broadcast(e), now: () => Date.now() }),
    // fase 19a (V3.2): l'endpoint /screen/<cap> — il ponte binario col desktop
    // del bot (la capability monouso la consuma il gestore)
    onScreenUpgrade: (cap, req, socket, head) => {
      void import('../main/agent/screen').then((m) => m.handleScreenUpgrade(cap, req, socket, head))
    },
    onUiChange: (connected) => {
      if (connected) {
        bridge?.refreshScale()
        // fase 5: con la finestra riaperta partono le autorizzazioni rimaste
        // in sospesa (i connettori in needs_auth aspettavano il browser)
        connectors.retryPendingAuth()
        // fase 6 (residuo 0b): con la UI aperta la chiave master del vault
        // migra dal setting safeStorage al Keychain, dove il daemon la legge
        // anche a finestra chiusa (le routine usano {{secret:...}} di notte)
        void import('../main/vault').then((v) => v.migrateVaultKeyToKeychain()).catch(() => undefined)
      }
    }
  })
  bridge = attachHostBridge({ callUi: (m, p) => server.callUi(m, p), hasUi: () => server.hasUi() })

  // fase 19a (V3): lo schermo del bot — capability monouso, ponte binario,
  // richieste di presa di controllo. Le dipendenze del daemon si registrano
  // QUI (dopo il server ws: serve la porta per l'URL delle capability); il
  // flag di test SANDBOT_TEST_FAKE_SCREEN_SOCKET sostituisce docker exec con
  // un socket unix locale del test.
  {
    const screen = await import('../main/agent/screen')
    screen.initScreen({
      emit: (e) => broadcast(e),
      wsPort: server.port,
      isBusy: (id) => loopMod.isRunning(id),
      enqueueTurn: (agentId, text, initiator, extraMeta) => {
        enqueueUserMessage(database, agentId, text, undefined, (e) => broadcast(e), undefined, initiator, extraMeta)
        pokeWorker()
      },
      markTakeoverCard: (agentId, entryId, status) => {
        const entry = getEntries(agentId).find((e) => e.id === entryId)
        if (!entry) return
        updateEntryMeta(entryId, { ...(entry.meta ?? {}), takeover: status })
        const updated = getEntries(agentId).find((e) => e.id === entryId)
        if (updated) broadcast({ type: 'entries', agentId, entries: [updated] })
      }
    })
  }

  // fase 6 (§3bis L9): ultima notifica consegnata per agente (throttle 5 s)
  const lastNotified = new Map<string, number>()
  const emit = (e: SandbotEvent): void => {
    server.broadcast(e)
    if (e.type !== 'agent-notify') return
    const agent = getAgent(e.agentId)
    if (!agent) return
    const decision = decideNotification({
      enabled: !getSetting<string[]>('notifications.disabledAgents', []).includes(e.agentId),
      viewing: server.hasUi() && presence.viewingAgent() === e.agentId,
      read: presence.readAt(e.agentId) >= e.at,
      lastNotifiedAt: lastNotified.get(e.agentId) ?? null,
      now: Date.now()
    })
    if (decision.deliver) {
      lastNotified.set(e.agentId, Date.now())
      const { title, body } = notifyTexts(agent.name, e)
      bridge?.notify(title, body)
    }
  }
  broadcast = emit

  // fase 5: connettori MCP+OAuth (store cifrato con chiave Keychain, catalogo,
  // resolver d'autenticazione del client MCP); gli eventi {type:'connectors'}
  // dicono alla UI di ricaricare la vista "Connetti app"
  const connectors = wireConnectors(
    { callUi: (m, p) => server.callUi(m, p), hasUi: () => server.hasUi() },
    () => emit({ type: 'connectors' })
  )

  // fase 13 (punti 1, 2, 4, 5, 7): connettori su larga scala — marketplace dei
  // plugin, deps d'installazione (registro/plugin/gateway), ricerca unificata
  // sulle tre fonti e migrazione enabledFor dei server esistenti (restano per
  // tutti: per l'utente non cambia nulla)
  const mcpServers = await import('../main/mcp')
  const marketplaces = createMarketplaceManager()
  const installDeps: import('../main/connectors/install').InstallDeps = {
    store: createConnectorsSecretStore({
      getKey: () => getConnectorsKey(),
      getSetting,
      setSetting
    }),
    marketplaces,
    findRegistryEntry: (name) => findRegistryEntry(name),
    listServers: () => mcpServers.listServers(),
    saveServers: (sv) => mcpServers.saveServers(sv),
    toolsOfServer: async (id) => mcpServers.toolsOfServer(id),
    openExternal: (url) => server.callUi('host.openExternal', [url]).then(() => undefined),
    hasUi: () => server.hasUi(),
    dockerMode: () => sandboxMode() === 'docker',
    dataDir,
    runDocker: (argv) =>
      new Promise((res, rej) => {
        const child = spawn('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('error', rej)
        child.on('close', (code) => res({ code: code ?? 1, stdout, stderr }))
      }),
    clientMetadataUrl: () => getSetting<string>('connectors.oauth.clientMetadataUrl', ''),
    onChange: () => emit({ type: 'connectors' })
  }
  setInstallDeps(installDeps)
  // la ricerca unificata: catalogo + plugin dei marketplace + registro (host
  // fisso, fetch con guardia SSRF, cache 10 minuti); il registro giù non
  // ferma le altre fonti
  setConnectorsSearchRunner(async (query) => {
    const { loadCatalog } = await import('../main/connectors')
    const { mergeConnectorResults, formatSearchResults } = await import('../main/connectors/search')
    const states = getSetting<Record<string, import('../main/connectors').ConnectorState>>('connectors.state', {})
    const catalog = loadCatalog().map((entry) => ({ entry, state: states[entry.id] }))
    const { ok } = await marketplaces.catalogs()
    const plugins = ok.flatMap((c) =>
      c.parsed.plugins.map((plugin) => ({ marketplace: c.parsed.name, official: c.marketplace.official, plugin }))
    )
    const registry = await fetchRegistryEntries(query).catch(() => null)
    const out = mergeConnectorResults({ catalog, plugins, registry }, query)
    // le descrizioni di registro e marketplace sono testo di TERZI: il result
    // va nel blocco dati esterni e contamina il turno (punto 1)
    const thirdParty = out.rows.some((r) => r.source !== 'catalog')
    return { text: formatSearchResults(out), thirdParty }
  })
  // migrazione enabledFor: i server GIÀ ESISTENTI restano abilitati a tutti
  {
    const mcpMod = await import('../main/mcp')
    const migrated = mcpMod.migrateEnabledFor(mcpMod.listServers())
    if (migrated.changed) mcpMod.saveServers(migrated.servers)
  }

  const worker = new JobWorker(
    database,
    {
      now: () => Date.now(),
      runJob: makeJobRunner(database)
    },
    emit
  )
  pokeWorker = () => worker.poke()

  // fase 7: onboarding al primo avvio — bot principale "Bot" + widget di
  // sistema sul ruolo; i due bot da template partono col kickstart in coda.
  // Il catalogo dei template si valida QUI all'avvio: un JSON rotto ferma il
  // daemon con l'errore chiaro invece di sorprendere a runtime.
  loadTemplates()
  const onboarding = createOnboarding({
    now: () => Date.now(),
    getSetting,
    setSetting,
    listAgents,
    createAgent: (name, description) => createAgent(name, description),
    updateAgent,
    listProviders,
    // fase 9 (punto 1): provider attivo + modello predefinito (capability "tools"
    // verificata via /api/show), non più il primo modello dell'elenco
    assignDefaultModel: async () => {
      const { assignDefaultModel } = await import('../main/agent/model-defaults')
      type ModelDefaultsMap = import('../main/agent/model-defaults').ModelDefaultsMap
      const providersMod = await import('../main/agent/providers')
      return assignDefaultModel({
        listProviders,
        getOverrides: () => getSetting<ModelDefaultsMap>('providers.modelDefaults', {}),
        supportsTools: (p, model) => {
          const full = providersMod.getProvider(p.id)
          // fase 18a (E0): l'errore finisce nell'avviso dell'onboarding —
          // testo del catalogo UI
          return full ? providersMod.modelSupportsTools(full, model) : Promise.resolve({ ok: false, checked: false, error: formatUi(ui(UI.rpcProviderNotFoundLower), uiLanguage()) })
        }
      })
    },
    appendSystemSend: (agentId, message, meta) => {
      const content = message.type === 'text' ? message.text : message.type === 'widget' ? message.prompt : ''
      const entry = appendEntry({
        agentId, kind: 'send-message', role: 'assistant',
        content,
        meta: { message, ...(meta ?? {}) }
      })
      broadcast({ type: 'entries', agentId, entries: [entry] })
    },
    markWidgetResponded: (agentId, entryId, value) => {
      const entry = getEntries(agentId).find((e) => e.id === entryId)
      if (entry) {
        updateEntryMeta(entryId, { ...(entry.meta ?? {}), respondedValue: value })
        const updated = getEntries(agentId).find((e) => e.id === entryId)
        if (updated) broadcast({ type: 'entries', agentId, entries: [updated] })
      }
    },
    enqueueKickstart: (agentId, template) => {
      const now = Date.now()
      enqueueJob(database, {
        agentId,
        kind: 'user-message',
        payload: {
          // fase 17c (C4): il kickstart parte nella lingua dell'utente
          text: buildKickstartMessage(template, currentUserLanguage()),
          initiator: 'TEMPLATE_IMPORT',
          extraMeta: { templateName: template.name }
        },
        runAt: now,
        now
      })
      pokeWorker()
    },
    emit: (e) => broadcast(e)
  })
  server.methods = buildApiMethods(emit, worker, connectors, presence, { webhookPort: server.port, onboarding, marketplaces })

  // scheduler: ogni 30s calcola le routine dovute (cron e trigger schedule),
  // fa i poll dei connettori, mette in pausa le routine se l'utente è via da
  // giorni e consegna l'outbox nella finestra (fase 6)
  const schedulerTimer = setInterval(() => {
    void (async () => {
    const now = Date.now()
    try {
      tickScheduler(database, emit, now)
      const paused = presence.maybePauseForAway()
      if (paused > 0) console.log(`[sandbotd] utente assente: ${paused} routine in pausa (pausedForAway)`)
      deliverDueHeld(emit, now, () => presence.lastSeen())
      // fase 19a (V3/V5): le scadenze dello schermo — capability non usate e
      // richieste di presa di controllo oltre i 30 minuti
      try {
        const screen = await import('../main/agent/screen')
        screen.tickScreen(Date.now())
      } catch (e) {
        console.error('[sandbotd] scadenze schermo:', e)
      }
      // fase 11 (punto 3): il tick dei comandi in background (exit file comparsi
      // in docker, scadenza delle 6 ore) — le notifiche SHELL_DONE partono da qui
      void import('../main/agent/shells').then((m) => m.tickShellJobs()).catch((e) => console.error('[sandbotd] shell jobs:', e))
      // fase 12 (punto 4): la scadenza dei figli (queued/running oltre
      // deadline_at) — interrupt, expired, risveglio del lotto
      try {
        const loop = await import('../main/agent/loop')
        const ops = await import('./subagent-ops')
        ops.tickSubagentDeadlines(database, { interrupt: loop.interrupt, now: () => Date.now() }, emit)
      } catch (e) {
        console.error('[sandbotd] scadenze sottoagenti:', e)
      }
      worker.poke()
    } catch (e) {
      console.error('[sandbotd] scheduler:', e)
    }
    void tickConnectorPolls({ db: database, emit, now: () => Date.now(), callMcpTool: pollMcpTool }, Date.now())
      .then(() => worker.poke())
      .catch((e) => console.error('[sandbotd] poll connettori:', e))
    })()
  }, 30_000)
  schedulerTimer.unref()
  // tick immediato all'avvio: recupera anche le routine scadute mentre era giù
  tickScheduler(database, emit, Date.now())
  presence.maybePauseForAway()
  // residuo fase 2b: il lock garantisce che ogni job 'leased' appartenga a un
  // processo morto — subito in coda, prima che il worker claimi qualsiasi cosa
  const requeued = requeueAllLeased(database)
  if (requeued > 0) console.log(`[sandbotd] ${requeued} job con lease orfano rimessi in coda all'avvio`)
  worker.start()

  // fase 7: primo avvio su dati vuoti → bot principale + widget del ruolo;
  // se l'onboarding era fermo sul provider e ora c'è, riprende da qui
  onboarding.maybeStart()
  void onboarding.resume().catch((e) => console.error('[sandbotd] ripresa onboarding:', e))

  // autodiscovery dei provider locali silenziosa al boot (come faceva l'app)
  void import('../main/agent/providers').then((p) => p.discoverProviders().catch(() => undefined))

  writeDaemonInfo(dataDir(), { pid: process.pid, port: server.port, token, startedAt: Date.now() })
  console.log(`[sandbotd] attivo: pid ${process.pid}, ws 127.0.0.1:${server.port}, dati ${dataDir()}`)

  const shutdown = (): void => {
    console.log('[sandbotd] arresto')
    worker.stop()
    clearInterval(schedulerTimer)
    removeDaemonInfo(dataDir())
    releaseDaemonLock(dataDir())
    void server.close().finally(() => process.exit(0))
    // se il close si blocca (socket appesi), si esce comunque
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

/** Chiama un tool MCP per i poll dei trigger (nome completo mcp__…). */
async function pollMcpTool(tool: string, args: Record<string, unknown>): Promise<string> {
  const { callTool } = await import('../main/mcp')
  return callTool(tool, args)
}

void main().catch((e) => {
  console.error('[sandbotd] avvio fallito:', e)
  process.exit(1)
})
