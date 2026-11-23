// B3 (fase b20-bug): il contratto del «Connetti» in un passo della riga
// dell'elenco app (apps:connect). Ogni esito del clic lascia la riga in uno
// stato chiaro: il collegamento è AVVIATO (la pagina di login è aperta nel
// browser di sistema) oppure NON è partito, con il motivo in parole e
// «Riprova». Mai una riga in attesa per sempre: se la risposta non arriva
// entro APP_CONNECT_MAX_MS la riga si sblocca con un avviso.
//
// Modulo PURO (costanti e tipi): lo leggono il renderer (la riga), il daemon
// (apps:connect) e i test. Il browser è quello di sistema — host.openExternal
// → shell.openExternal — non c'è nessuna finestra interna da cercare dietro.

/** Le strade di «Connetti»: il connettore diretto, il login di Composio (poi l'app), l'app dentro Composio. */
export type AppConnectPhase = 'direct' | 'login' | 'app'

/** Perché un «Connetti» NON è partito. */
export type AppConnectFailReason =
  /** Composio non gestisce il login di questa app: manca la sua configurazione di accesso */
  | 'not-connectable'
  /** nessuna risposta entro il tempo massimo */
  | 'timeout'
  /** altro errore: il motivo è in `error` (e il dettaglio, se c'è, in `detail`) */
  | 'connect-failed'

/** L'esito negativo che il daemon pubblica per i flussi che continuano in background. */
export interface AppConnectFailureInfo {
  /** la riga dell'elenco app (id del catalogo) */
  appId: string
  /** quando il daemon ha chiuso la prova (epoch ms): la riga lo confronta col suo clic */
  at: number
  reason: AppConnectFailReason
  /** il motivo in parole, già nella lingua dell'interfaccia (mai segreti né link) */
  error: string
  /** il dettaglio tecnico, ripulito e tagliato, quando c'è */
  detail?: string
}

/**
 * Il tempo massimo (ms) che la riga aspetta la risposta al suo clic: oltre,
 * si sblocca con un avviso e «Riprova» (il clic può rimanere appeso se il
 * daemon non risponde). I login nel browser durano minuti e non c'entrano:
 * questo è il tempo dell'AVVIO. Esportata: i test la accorciano con i timer
 * finti (maxMs del flusso), la sonda legge il tempo del daemon qui sotto.
 */
export const APP_CONNECT_MAX_MS = 25_000

/**
 * Il tempo massimo del daemon sull'avvio di un'app Composio (list, add, link
 * aperto nel browser): STA SOTTO quello della riga, così la risposta del
 * daemon — col motivo vero — arriva prima dell'avviso generico. La sonda lo
 * accorcia con SANDBOT_TEST_APP_CONNECT_TIMEOUT_MS (millisecondi), SOLO
 * insieme a SANDBOT_TEST_USER_DATA (vedi appStartTimeoutMs nel main).
 */
export const APP_CONNECT_DAEMON_TIMEOUT_MS = APP_CONNECT_MAX_MS - 5_000
