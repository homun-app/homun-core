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
  setDataDir, dataDir, db, getAgent, getSetting, setSetting,
  listAgents, listRoutines, updateRoutine, appendEntry
} from '../main/store/db'
import { requeueAllLeased } from '../main/store/jobs'
import { acquireDaemonLock, releaseDaemonLock, writeDaemonInfo, removeDaemonInfo } from './daemon-files'
import { startWsServer, generateToken } from './ws-server'
import { buildApiMethods } from './api'
import { JobWorker } from './worker'
import { tickScheduler, tickConnectorPolls, enqueueRoutineRun } from './scheduler'
import { attachHostBridge } from './host-bridge'
import { makeJobRunner } from './run-job'
import { wireConnectors } from '../main/connectors/wiring'
import { createPresence } from './presence'
import { handleWebhook } from './webhooks'
import { deliverDueHeld } from './outbox'
import { decideNotification, notifyTexts } from './notifications'
import { enqueueUserMessage } from './enqueue'
import { secondaryPrompts } from '../main/agent/prompts'
import type { SandbotEvent } from '../shared/types'

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
  const token = generateToken()
  let bridge: ReturnType<typeof attachHostBridge> | null = null
  // dichiarati prima della closure del server e riempiti appena pronti
  let broadcast: (e: SandbotEvent) => void = () => undefined
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

  const worker = new JobWorker(
    database,
    {
      now: () => Date.now(),
      runJob: makeJobRunner(database)
    },
    emit
  )
  pokeWorker = () => worker.poke()
  server.methods = buildApiMethods(emit, worker, connectors, presence, { webhookPort: server.port })

  // scheduler: ogni 30s calcola le routine dovute (cron e trigger schedule),
  // fa i poll dei connettori, mette in pausa le routine se l'utente è via da
  // giorni e consegna l'outbox nella finestra (fase 6)
  const schedulerTimer = setInterval(() => {
    const now = Date.now()
    try {
      tickScheduler(database, emit, now)
      const paused = presence.maybePauseForAway()
      if (paused > 0) console.log(`[sandbotd] utente assente: ${paused} routine in pausa (pausedForAway)`)
      deliverDueHeld(emit, now, () => presence.lastSeen())
      worker.poke()
    } catch (e) {
      console.error('[sandbotd] scheduler:', e)
    }
    void tickConnectorPolls({ db: database, emit, now: () => Date.now(), callMcpTool: pollMcpTool }, Date.now())
      .then(() => worker.poke())
      .catch((e) => console.error('[sandbotd] poll connettori:', e))
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
