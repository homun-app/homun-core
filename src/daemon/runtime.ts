// Runtime del daemon sandbotd, ESTRATTO dall'entrypoint (fase rilascio A1):
// la stessa app Electron lo esegue NEL SUO PROCESSO MAIN con --homun-daemon
// (niente più ELECTRON_RUN_AS_NODE: il fuse RunAsNode va spento nella build
// pubblicata). Il vecchio entry Node (src/daemon/index.ts → out/main/daemon.js)
// resta per i test storici e lo sviluppo, e chiama QUESTO runtime.
//
// Nessun import statico di 'electron': il runtime resta Node puro e le poche
// cose che dipendono dall'app (versione, safeStorage) arrivano iniettate.
//
// Fase rilascio (A2): il daemon scrive in daemon.json anche version e build;
// l'RPC daemon:restart lo fa USCIRE BENE per un aggiornamento — smette di
// prendere job, aspetta al massimo 10 s che i turni in corso arrivino a un
// punto sicuro (la coda è durevole: un turno interrotto riprende come dopo
// un crash) ed esce con 0 (il KeepAlive SuccessfulExit=false di launchd NON
// lo rilancia: lo rilancia la UI nuova).
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
import { buildApiMethods, notifyComposioAppConnected } from './api'
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
// fase rilascio (A6): le chiavi master passano da keys.json/safeStorage
import { setMasterKeyStorage, setMasterKeySealedDataProbe, safeStorageBackendForEnv } from './master-keys'
// fase rilascio — correzioni (K1.3): la sonda dei dati sigillati del daemon
import { daemonHasSealedData } from './sealed-data'
import type { SafeStorageLike } from '../main/vault'
// fase rilascio (A7): docker si trova anche fuori dal Terminale
import { resolveTool, dockerChildEnv } from '../main/tool-paths'
// fase memoria-engramma (M1): il motore Engramma vive solo qui, nel demone
import { openMemoryEngine, closeMemoryEngine, embedPendingAll } from '../main/memory/engine'

/** Tempo massimo di attesa dei turni in corso durante un riavvio pulito (A2). */
export const RESTART_DRAIN_MS = 10_000

export interface DaemonRuntimeOptions {
  /** Directory dati, GIÀ risolta dal chiamante (UI rule: userData/data; entry Node: --data/env). */
  dataDir: string
  /** Versione dell'app (A2: scritta in daemon.json). */
  getVersion(): string
  /** Id di build del bundle (A2: scritto in daemon.json). */
  buildId: string
  /**
   * Backend safeStorage (A6): il daemon Electron passa quello vero; l'entry
   * Node non ne ha — con SANDBOT_TEST_FAKE_SAFESTORAGE subentra il finto.
   */
  safeStorage?: SafeStorageLike | null
}

export async function runDaemonRuntime(opts: DaemonRuntimeOptions): Promise<void> {
  setDataDir(opts.dataDir)
  // A6: il backend delle chiavi master si registra PRIMA delle migrazioni che
  // ne hanno bisogno (providers, vault); nei test mai il Portachiavi vero
  setMasterKeyStorage(safeStorageBackendForEnv(opts.safeStorage ?? null))
  // K1.3: con dati sigillati e nessuna chiave recuperabile il daemon si
  // rifiuta di generare (una chiave nuova renderebbe i segreti illeggibili)
  setMasterKeySealedDataProbe(daemonHasSealedData)

  const lock = acquireDaemonLock(dataDir())
  if (!lock.ok) {
    console.error(`[sandbotd] daemon già attivo (pid ${lock.pid}): esco`)
    process.exit(1)
  }

  const database = db()

  // fase skill (S2.4): migrazione una tantum delle skill PER BOT nella
  // LIBRERIA UNICA — PRIMA di tutto ciò che legge le skill (prompt, tool,
  // finestra). Idempotente per flag; un errore lascia tutto com'era e si
  // riprova al prossimo avvio.
  {
    const { migrateAgentSkills } = await import('../main/store/skills-migrations')
    try {
      migrateAgentSkills()
    } catch (e) {
      console.error('[sandbotd] migrazione skill rimandata al prossimo avvio:', e instanceof Error ? e.message : e)
    }
  }

  // fase 16c (C1): migrazione delle chiavi API dei provider — il chiaro nel
  // setting 'providers' si cifra (chiave master del servizio providers, oggi
  // keys.json) e si toglie. Idempotente; se il Portachiavi non risponde il
  // chiaro resta (avviso SENZA la chiave) e si riprova al prossimo avvio.
  // Fase 16c correzioni (R2.1): se la migrazione ha cifrato qualcosa, i byte
  // del chiaro restano nel WAL e nelle pagine libere del file — checkpoint
  // TRUNCATE + VACUUM una volta sola (flag 'providers.migrationVacuumed').
  {
    const { migrateProviderKeys, vacuumAfterKeyMigration } = await import('../main/agent/providers')
    let changed = false
    try {
      changed = await migrateProviderKeys()
    } catch (e) {
      console.error('[sandbotd] migrazione chiavi provider rimandata al prossimo avvio:', e instanceof Error ? e.message : e)
    }
    try {
      vacuumAfterKeyMigration(database, changed)
    } catch (e) {
      console.error('[sandbotd] pulizia post-migrazione rimandata al prossimo avvio:', e instanceof Error ? e.message : e)
    }
  }

  // fase 16c (C5): lo storico delle routine si pota all'avvio (90 giorni)
  {
    const { pruneRoutineRuns } = await import('../main/store/routine-runs')
    const pruned = pruneRoutineRuns(database, Date.now())
    if (pruned > 0) console.log(`[sandbotd] ${pruned} esecuzioni di routine oltre i 90 giorni rimosse`)
  }

  // fase impostazioni (I3/I4/I8): migrazioni dei SETTING, una tantum con flag
  // (idempotenti) — riserva implicita e revisore silenzioso diventano visibili,
  // approvals.mode nasce da autoReview.enabled
  {
    const { migrateImpostazioniSettings } = await import('../main/store/settings-migrations')
    try {
      migrateImpostazioniSettings()
    } catch (e) {
      console.error('[sandbotd] migrazione impostazioni rimandata al prossimo avvio:', e instanceof Error ? e.message : e)
    }
  }

  // fase mcp-setup ritocchi (R1): i toolSlug si congelano col nome di OGGI,
  // PRIMA di qualsiasi rinomina (la migrazione dei template e il titolo del
  // registro vengono dopo) — una tantum, flag idempotente
  {
    const { migrateToolSlugFreeze } = await import('../main/store/mcp-migrations')
    try {
      migrateToolSlugFreeze()
    } catch (e) {
      console.error('[sandbotd] congelamento dei toolSlug rimandato al prossimo avvio:', e instanceof Error ? e.message : e)
    }
  }

  // fase mcp-setup (M7): i server del registro salvati con l'URL coi
  // segnaposto letterali diventano urlTemplate + needsAuth 'setup' (una
  // tantum, flag idempotente)
  {
    const { migrateMcpServers } = await import('../main/store/mcp-migrations')
    try {
      migrateMcpServers()
    } catch (e) {
      console.error('[sandbotd] migrazione server del registro rimandata al prossimo avvio:', e instanceof Error ? e.message : e)
    }
  }

  // fase memoria-engramma (M1): il motore della memoria — UNA volta per
  // processo (il modello occupa ~400 MB), su <dataDir>/memory, con il modello
  // in <dataDir>/models (mai scaricato da solo). Se il modulo non si carica
  // il resto di Homun va avanti: gli strumenti di memoria e l'interfaccia
  // dicono il problema (nessun ripiego silenzioso). Il log porta solo lo
  // stato, mai contenuti di note.
  {
    const st = await openMemoryEngine({ dataDir: dataDir() })
    if (st.available) {
      console.log(`[sandbotd] memoria Engramma attiva (motore ${st.version}, ${st.model.present ? 'modello presente' : 'senza modello: ricerca testo+grafo'})`)
    } else {
      console.error(`[sandbotd] memoria Engramma NON disponibile: ${st.error}`)
    }
  }

  // fase 12: il broadcast si riempie quando il server ws esiste; il boot lo
  // usa per il risveglio dei lotti (gli eventi persi prima della connessione
  // della UI si ricaricano comunque al primo 'agents'/'subagents')
  let broadcast: (e: SandbotEvent) => void = () => undefined
  const emitBoot = (e: SandbotEvent): void => broadcast(e)

  // fase 11 (punto 2): la web search API di Ollama legge la chiave dal vault
  // sigillato (chiave AES master, come i connettori)
  {
    const { setWebSearchKeyGetter } = await import('../main/agent/web-tools')
    const { getConnectorsKey } = await import('./keychain')
    setWebSearchKeyGetter(() => getConnectorsKey())
  }

  // M10 (fase 0.3.1001): prefisso dei nomi del box di prova PRESENTE ma non
  // valido → errore chiaro nel log del daemon fin dal boot (la sandbox non
  // partirà mai coi nomi dell'utente; la riga Docker della UI lo ripete)
  {
    const { INVALID_TEST_BOX_PREFIX, invalidTestBoxPrefixError } = await import('../main/sandbox/docker-argv')
    if (INVALID_TEST_BOX_PREFIX) console.error('[sandbotd]', invalidTestBoxPrefixError(INVALID_TEST_BOX_PREFIX))
  }

  // fase 11 (punto 1): migrazione una tantum dei vecchi box (uno per agente)
  // nel box CONDIVISO — COPIA, niente cancellazioni; notice al bot principale
  // con cosa è stato migrato e dove restano i vecchi dati (la cancellazione
  // la decide l'utente). Idempotente: un marker nel box evita di rifarla.
  try {
    const { migrateLegacyBoxes } = await import('../main/sandbox')
    // R1 (fase app — ritocchi, sonda): la cartella dei vecchi box si può
    // spostare SOLO nei test (SANDBOT_TEST_LEGACY_BOX_ROOT, come le altre
    // SANDBOT_TEST_*: in produzione non esiste) — così la sonda provoca la
    // notice di migrazione senza toccare la home vera
    const migration = await migrateLegacyBoxes(
      listAgents(),
      process.env.SANDBOT_TEST_LEGACY_BOX_ROOT && process.env.SANDBOT_TEST_USER_DATA
        ? { legacyRoot: process.env.SANDBOT_TEST_LEGACY_BOX_ROOT }
        : {}
    )
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

  // fase 19b (T2.3): gli orfani del TERMINALE — i programmi PTY rimasti vivi
  // dopo un crash si chiudono dai pid file in <home>/.sandbot/terminals/
  // (stesso schema del browser e delle shell), poi i file si cancellano
  try {
    const { killTerminalOrphans } = await import('../main/agent/terminal')
    await killTerminalOrphans([...listAgents().map((a) => a.id), ...(await import('../main/store/subagents')).allSubagentIds(database)])
  } catch {
    // niente da chiudere
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
    // fase 19b (T2.3): l'endpoint /term/<cap> — il ponte binario col PTY del
    // terminale del bot (capability monouso, stessa validazione rigida di L8)
    onTermUpgrade: (cap, req, socket, head) => {
      void import('../main/agent/terminal').then((m) => m.handleTermUpgrade(cap, req, socket, head))
    },
    onUiChange: (connected) => {
      if (connected) {
        bridge?.refreshScale()
        // fase 5: con la finestra riaperta partono le autorizzazioni rimaste
        // in sospesa (i connettori in needs_auth aspettavano il browser)
        connectors.retryPendingAuth()
        // fase 6 (residuo 0b): con la UI aperta la chiave master del vault
        // migra dal setting safeStorage a keys.json (A6), dove il daemon la
        // legge anche a finestra chiusa (le routine usano {{secret:...}} di notte)
        void import('../main/vault').then((v) => v.migrateVaultKeyToKeychain()).catch(() => undefined)
      }
    }
  })
  bridge = attachHostBridge({ callUi: (m, p) => server.callUi(m, p), hasUi: () => server.hasUi() })

  // fase 19b (T2): il terminale del bot — la porta del server ws per gli URL
  // delle capability (l'orologio è quello reale; i test lo iniettano da soli)
  {
    const terminal = await import('../main/agent/terminal')
    terminal.setTerminalWsPort(server.port)
  }

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
      // fase 16b (S1.2): il click porta alla SQUADRA quando è il riepilogo
      bridge?.notify(title, body, e.openGroupId)
    }
  }
  broadcast = emit

  // fase 19b (T4): l'evento computer-activity — il feed «Attività» e la vista
  // File ricaricano a ogni nuova riga di computer_actions e a ogni cambio di
  // stato di shell_jobs (nessun payload pesante: la UI ricarica)
  {
    const activity = await import('../main/agent/computer-activity')
    activity.setComputerActivityEmitter(emit)
  }

  // fase 5: connettori MCP+OAuth (store cifrato con chiave master, catalogo,
  // resolver d'autenticazione del client MCP); gli eventi {type:'connectors'}
  // dicono alla UI di ricaricare la vista "Connetti app"
  const connectors = wireConnectors(
    { callUi: (m, p) => server.callUi(m, p), hasUi: () => server.hasUi() },
    () => emit({ type: 'connectors' })
  )

  // fase app (A2–A5): Composio con la chiave dell'utente — tutto nel daemon,
  // client iniettabile (SANDBOT_TEST_FAKE_COMPOSIO per la sonda); la chiave
  // nello STESSO store cifrato dei connettori. Il manager si registra in
  // connectors/composio.ts così loop/mcp/permissions lo raggiungono senza
  // import inversi.
  const { createComposioManager, setActiveComposio } = await import('../main/connectors/composio')
  const composio = createComposioManager({
    store: createConnectorsSecretStore({
      getKey: () => getConnectorsKey(),
      getSetting,
      setSetting
    }),
    getSetting,
    setSetting,
    openExternal: (url) => server.callUi('host.openExternal', [url]).then(() => undefined),
    hasUi: () => server.hasUi(),
    emit: (e) => emit(e),
    dataDir
  })
  setActiveComposio(composio)

  // fase 13 (punti 1, 2, 4, 5, 7): connettori su larga scala — marketplace dei
  // plugin, deps d'installazione (registro/plugin/gateway), ricerca unificata
  // sulle tre fonti e migrazione enabledFor dei server esistenti (restano per
  // tutti: per l'utente non cambia nulla)
  const mcpServers = await import('../main/mcp')

  // fase Composio OAuth (C5): il gateway delle app dentro il server Composio
  // collegato col login (C1) — MANAGE_CONNECTIONS/WAIT_FOR_CONNECTIONS con i
  // link nelle card, mai nel testo libero. Il manager si registra come
  // setActiveComposioGateway, così loop e permissions lo raggiungono.
  const { createComposioGatewayManager, setActiveComposioGateway } = await import('../main/connectors/composio-gateway')
  // fase mcp-setup (M5.3): il worker nasce DOPO il gateway; il richiamo di
  // onAppActive lo legge quando serve (un'app diventa ACTIVE più tardi)
  let gatewayWorker: import('./worker').JobWorker | null = null
  const composioGatewayActive = (): boolean =>
    connectors.stateOf('composio').status === 'connected' && mcpServers.listServers().some((s) => s.catalogId === 'composio')
  const composioGatewayManager = createComposioGatewayManager({
    callMcp: (tool, args, opts) => mcpServers.callTool(tool, args, opts),
    gatewayActive: composioGatewayActive,
    getSetting,
    setSetting,
    openExternal: (url) => server.callUi('host.openExternal', [url]).then(() => undefined),
    hasUi: () => server.hasUi(),
    emit: (e) => emit(e),
    // K6 (ritocchi): i nomi degli strumenti dal nome VERO del server Composio
    // del catalogo (mcp__<slug>__…), non più lo slug scritto a mano
    serverTools: () => mcpServers.composioServerTools(),
    // fase mcp-setup (M5.3): un'app diventata ACTIVE che chiude l'offerta
    // pendente di una curata DIRETTA dello stesso marchio avvisa il bot
    // (CONNECTOR_CONNECTED, coi nomi degli strumenti di Composio)
    onAppActive: (slug, name) => {
      if (!gatewayWorker) return
      void notifyComposioAppConnected(slug, name, (e) => emit(e), gatewayWorker).catch(() => undefined)
    }
  })
  setActiveComposioGateway(composioGatewayManager)

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
    // fase rilascio (A7): il percorso di docker risolto (PATH minimo di launchd)
    runDocker: (argv) =>
      new Promise((res, rej) => {
        const child = spawn(resolveTool('docker'), argv, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: dockerChildEnv(process.env)
        })
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
  // ferma le altre fonti. Fase app (A4 punto 6): anche le app Composio
  // (id composio:<slug> per offer_connector), subito dopo le curate.
  setConnectorsSearchRunner(async (query) => {
    const { loadCatalog } = await import('../main/connectors')
    const { mergeConnectorResults, formatSearchResults } = await import('../main/connectors/search')
    const { searchComposioApps } = await import('../main/connectors/composio')
    const states = getSetting<Record<string, import('../main/connectors').ConnectorState>>('connectors.state', {})
    const catalog = loadCatalog().map((entry) => ({ entry, state: states[entry.id] }))
    const { ok } = await marketplaces.catalogs()
    const plugins = ok.flatMap((c) =>
      c.parsed.plugins.map((plugin) => ({ marketplace: c.parsed.name, official: c.marketplace.official, plugin }))
    )
    const registry = await fetchRegistryEntries(query).catch(() => null)
    const out = mergeConnectorResults({ catalog, plugins, registry }, query)
    const composioApps = await searchComposioApps(query).catch(() => [])
    const composioLines = composioApps.map(
      (a) => `- composio:${a.slug} — ${a.name} · source: Composio (the user's own key) · trust: verified · remote (OAuth via Composio): ${a.description ?? ''}`
    )
    // le descrizioni di registro, marketplace e Composio sono testo di TERZI:
    // il result va nel blocco dati esterni e contamina il turno (punto 1)
    const thirdParty = out.rows.some((r) => r.source !== 'catalog') || composioLines.length > 0
    const text = [formatSearchResults(out), ...composioLines].filter((l) => l).join('\n')
    return { text, thirdParty }
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
  // fase mcp-setup (M5.3): il gateway può finalmente svegliare il worker
  gatewayWorker = worker

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

  // fase rilascio (A2): chiusura pulita per aggiornamento — smette di prendere
  // job, aspetta i turni in corso (≤10 s) ed esce con 0
  let draining = false
  const shutdown = (): void => {
    console.log('[sandbotd] arresto')
    worker.stop()
    clearInterval(schedulerTimer)
    removeDaemonInfo(dataDir())
    releaseDaemonLock(dataDir())
    // fase memoria-engramma (M1): close aspetta le operazioni in volo; dopo,
    // ogni chiamata risponde CLOSED e closeMemoryEngine lo rende silenzio
    // (niente errori nei log allo spegnimento)
    void closeMemoryEngine()
      .catch(() => undefined)
      .finally(() => { void server.close().finally(() => process.exit(0)) })
    // se il close si blocca (socket appesi), si esce comunque
    setTimeout(() => process.exit(0), 3000).unref()
  }
  const restartForUpdate = async (): Promise<void> => {
    if (draining) return
    draining = true
    console.log('[sandbotd] riavvio per aggiornamento: i turni in corso hanno 10 s per chiudere')
    worker.stop() // niente nuovi job
    clearInterval(schedulerTimer)
    await Promise.race([worker.drain(), new Promise((r) => setTimeout(r, RESTART_DRAIN_MS).unref?.())])
    shutdown()
  }

  server.methods = {
    ...buildApiMethods(emit, worker, connectors, presence, { webhookPort: server.port, onboarding, marketplaces, composio, composioGateway: composioGatewayManager }),
    // fase rilascio (A2): la UI chiede CHI sei (versione/build) e di uscire bene
    'daemon:describe': () => ({ pid: process.pid, version: opts.getVersion(), build: opts.buildId }),
    'daemon:restart': async () => {
      void restartForUpdate()
      return { ok: true }
    }
  }

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
      // fase 19b (T2.3): le scadenze del terminale — capability non usate e
      // sessioni senza input da 30 minuti (chiuse col codice 4002)
      try {
        const terminal = await import('../main/agent/terminal')
        terminal.tickTerminal(Date.now())
      } catch (e) {
        console.error('[sandbotd] scadenze terminale:', e)
      }
      // fase 11 (punto 3): il tick dei comandi in background (exit file comparsi
      // in docker, scadenza delle 6 ore) — le notifiche SHELL_DONE partono da qui
      void import('../main/agent/shells').then((m) => m.tickShellJobs()).catch((e) => console.error('[sandbotd] shell jobs:', e))
      // fase memoria-engramma (M1): il ripiego del fondo coda — le note ancora
      // senza vettore si incorporano qui SOLO se il modello c'è (no-op
      // silenzioso altrimenti: il modello non si scarica mai da solo)
      void embedPendingAll().catch(() => undefined)
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
    // fase app (A4): lo stato degli account Composio si rilegge ogni 10 minuti
    // mentre la finestra è aperta (throttle interno del manager; senza UI no-op)
    composio.maybeRefreshAccounts()
    // fase Composio OAuth (C5): anche le app collegate DENTRO il server
    // Composio si rileggono (list tollerante, mai un'eccezione)
    void composioGatewayManager.refreshAccounts().catch(() => undefined)
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

  writeDaemonInfo(dataDir(), { pid: process.pid, port: server.port, token, startedAt: Date.now(), version: opts.getVersion(), build: opts.buildId })
  console.log(`[sandbotd] attivo: pid ${process.pid}, ws 127.0.0.1:${server.port}, dati ${dataDir()}`)

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

/** Chiama un tool MCP per i poll dei trigger (nome completo mcp__…). */
async function pollMcpTool(tool: string, args: Record<string, unknown>): Promise<string> {
  const { callTool } = await import('../main/mcp')
  return callTool(tool, args)
}
