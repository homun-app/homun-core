// Entrypoint del daemon sandbotd in modalità Node PURO (nessun import da
// 'electron'): FASE RILASCIO (A1) è la via LEGACY — usata dai probe storici
// e dallo sviluppo con ELECTRON_RUN_AS_NODE. Nell'app pubblicata il daemon
// NON passa più di qui: è lo stesso eseguibile Electron lanciato con
// --homun-daemon (src/main/index.ts) che esegue il RUNTIME condiviso
// (src/daemon/runtime.ts) nel suo processo main.
//
// Avvio: node daemon.js [--data <dir>]  (oppure env SANDBOT_DATA_DIR)
// All'avvio acquisisce il lock (un solo daemon per directory dati), apre lo
// store, avvia il server WebSocket (porta casuale, token in daemon.json 0600)
// e i tick di worker e scheduler.
import { resolveDataDirArgv } from '../main/mode'
import { runDaemonRuntime } from './runtime'
import { APP_BUILD_ID } from '../main/build-id'

const dir = resolveDataDirArgv(process.argv) ?? process.env.SANDBOT_DATA_DIR
if (dir === undefined || dir === null || dir === '') {
  // senza --data si usa il default dello store (~/.sandbot/data): lo store
  // stesso lo crea. In modalità Electron (A1) la directory arriva SEMPRE.
  console.error('[sandbotd] manca --data <dir> (o SANDBOT_DATA_DIR): modalità Node legacy')
  process.exit(2)
}

void runDaemonRuntime({
  dataDir: dir,
  // entry Node: nessuna app Electron da interrogare; la versione del
  // pacchetto arriva dall'env del chiamante (probe), il build id dal define
  getVersion: () => process.env.SANDBOT_VERSION ?? 'node-legacy',
  buildId: APP_BUILD_ID
}).catch((e) => {
  console.error('[sandbotd] avvio fallito:', e)
  process.exit(1)
})
