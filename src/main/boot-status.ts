// W2 (fase avvio-finestra): lo stato che il main offre al CARICAMENTO della
// finestra (canali locali boot:status / boot:retry). Puro, senza Electron: il
// client del daemon dice «connesso», i riavvii visti da ensureDaemonRunning
// dicono se è in corso l'AGGIORNAMENTO alla versione nuova («Sto avviando il
// motore» diventa «Aggiorno il motore»), e «Riprova» rifà la connessione — se
// il daemon non c'è, client.start() → ensureDaemonRunning lo riavvia con il
// percorso di oggi. Prima la UI restava sul caricamento senza una parola,
// anche per i ~10 s del riavvio per aggiornamento.
export interface BootClientLike {
  readonly connected: boolean
  start(): Promise<void>
}

/** Il motivo di un riavvio del daemon vivo (come lo vede ensureDaemonRunning). */
export type BootRestartReason = 'legacy' | 'update' | 'path'

export interface BootStatusInfo {
  connected: boolean
  /** true solo mentre si aspetta il daemon nuovo dopo un aggiornamento */
  restartingForUpdate: boolean
}

export class BootStatusTracker {
  private restartingForUpdate = false

  constructor(private readonly client: BootClientLike) {}

  /** Un riavvio visto da ensureDaemonRunning: «aggiornamento» per versione (o daemon vecchio stile), non per il solo percorso. */
  handleRestart(reason: BootRestartReason): void {
    if (reason !== 'path') this.restartingForUpdate = true
  }

  /** Lo stato per la riga del caricamento: connesso vince sempre e spegne il flag. */
  status(): BootStatusInfo {
    if (this.client.connected) this.restartingForUpdate = false
    return { connected: this.client.connected, restartingForUpdate: !this.client.connected && this.restartingForUpdate }
  }

  /** «Riprova»: rifà la connessione (avviando il daemon se non c'è). */
  async retry(): Promise<{ ok: true; restarted: boolean }> {
    if (!this.client.connected) {
      void this.client.start().catch(() => undefined)
      return { ok: true, restarted: true }
    }
    return { ok: true, restarted: false }
  }
}
