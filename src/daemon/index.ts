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
import { setDataDir, dataDir, db } from '../main/store/db'
import { acquireDaemonLock, releaseDaemonLock, writeDaemonInfo, removeDaemonInfo } from './daemon-files'
import { startWsServer, generateToken } from './ws-server'
import { buildApiMethods } from './api'
import { JobWorker } from './worker'
import { tickScheduler } from './scheduler'
import { attachHostBridge } from './host-bridge'
import { runTurn } from '../main/agent/loop'
import type { Job } from '../main/store/jobs'
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

  const server = await startWsServer({
    token,
    onUiChange: (connected) => {
      if (connected) bridge?.refreshScale()
    }
  })
  bridge = attachHostBridge({ callUi: (m, p) => server.callUi(m, p), hasUi: () => server.hasUi() })

  const emit = (e: SandbotEvent): void => {
    server.broadcast(e)
    // notifica "bot ha risposto" (come in fase 1): con la UI aperta la decide
    // lei (nativa, se la finestra non è a fuoco), senza UI passa da osascript
    if (e.type === 'status' && e.status === 'idle') bridge?.notifyDone(e.agentId)
  }

  const worker = new JobWorker(
    database,
    {
      now: () => Date.now(),
      runJob: async (job: Job, emitTurn) => {
        if (job.kind === 'user-message') {
          const p = job.payload as { text: string; images?: string[] }
          await runTurn(job.agent_id, p.text, emitTurn, p.images, { source: 'user' })
          return
        }
        const p = job.payload as { routineId: number; title: string; prompt: string }
        await runTurn(job.agent_id, `[routine ricorrente: ${p.title}] ${p.prompt}`, emitTurn, undefined, { source: 'routine', title: p.title })
      }
    },
    emit
  )
  server.methods = buildApiMethods(emit, worker)

  // scheduler: ogni 30s calcola le routine dovute e accoda i job
  const schedulerTimer = setInterval(() => {
    try {
      tickScheduler(database, emit, Date.now())
      worker.poke()
    } catch (e) {
      console.error('[sandbotd] scheduler:', e)
    }
  }, 30_000)
  schedulerTimer.unref()
  // tick immediato all'avvio: recupera anche le routine scadute mentre era giù
  tickScheduler(database, emit, Date.now())
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

void main().catch((e) => {
  console.error('[sandbotd] avvio fallito:', e)
  process.exit(1)
})
