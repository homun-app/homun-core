// U6 (fase mcp-ui): chiudere e riaprire Homun funziona SEMPRE. La decisione
// di cosa fare quando arriva un second-instance, PURA (il main la applica):
// con il flag d'uscita impostato in before-quit l'app sta uscendo e il nuovo
// avvio arriverebbe a un processo morente (il caso della beta.15: nessuna
// finestra finché non si rifà ⌘Q) → si chiama app.relaunch() PRIMA di finire
// di uscire, così l'utente vede comunque la finestra, dalla copia nuova.
// Senza flag: la porta unica di W1 (showMainWindow).
export type SecondInstanceDecision = 'relaunch' | 'show-main-window'

/** Cosa fa il main quando arriva second-instance (decisione PURA). */
export function secondInstanceWhileQuitting(quitting: boolean): SecondInstanceDecision {
  return quitting ? 'relaunch' : 'show-main-window'
}
