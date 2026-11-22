// Uno stdout/stderr chiuso (il processo che leggeva l'uscita è morto: una
// sonda, un `| head`, un terminale chiuso) fa fallire il prossimo
// console.log/error con EPIPE. Senza un ascoltatore 'error' lo stream lo
// rilancia come Uncaught Exception e Electron mostra il dialogo «A JavaScript
// error occurred in the main process». Perdere una riga di log va bene; il
// dialogo no. Gli altri errori restano errori.
import type { EventEmitter } from 'node:events'

export function guardStdioEpipe(streams: EventEmitter[]): void {
  for (const s of streams) {
    s.on('error', (e: NodeJS.ErrnoException) => {
      if (e?.code !== 'EPIPE') throw e
    })
  }
}
