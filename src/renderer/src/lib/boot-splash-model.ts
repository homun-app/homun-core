// W2 (fase avvio-finestra): il modello PURO del caricamento del primo avvio —
// quale riga mostra BootSplash e quando compare «Ci sta mettendo più del
// solito» col «Riprova». L'orologio lo passa il chiamante (nei test è finto):
// elapsedMs conta DALL'ULTIMO «Riprova» (se c'è stato), non dal mount.
export const BOOT_SLOW_AFTER_MS = 20_000

export type BootSplashLine = 'starting' | 'updating'

export interface BootStatusInfo {
  connected: boolean
  restartingForUpdate: boolean
}

export interface BootSplashView {
  /** 'updating' solo mentre si aspetta il daemon nuovo di un aggiornamento */
  line: BootSplashLine
  /** true dopo BOOT_SLOW_AFTER_MS senza connessione: riga d'avviso + «Riprova» */
  slow: boolean
}

export function bootSplashView(info: BootStatusInfo, elapsedMs: number): BootSplashView {
  return {
    line: info.restartingForUpdate && !info.connected ? 'updating' : 'starting',
    slow: !info.connected && elapsedMs >= BOOT_SLOW_AFTER_MS
  }
}
