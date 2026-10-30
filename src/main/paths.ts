// Percorsi dell'app Electron (fase 16, U0b): funzioni pure, testabili senza
// avviare Electron.
import { join } from 'node:path'

/**
 * La cartella dati dell'app è QUELLA STORICA dell'utente:
 * <appData>/sandbot, in MINUSCOLO (creata quando l'app si chiamava
 * "sandbot"). Electron la ricava dal nome dell'app: con il nuovo nome
 * visibile "Homun" (build.productName) l'app impacchettata userebbe invece
 * <appData>/Homun e l'utente ritroverebbe i bot vuoti. Si fissa qui, con il
 * nome esatto della cartella esistente — non ci si affida al fatto che APFS
 * di solito ignori le maiuscole. Il nome dell'app entra solo da documento:
 * qualunque sia, la cartella dati resta sandbot.
 */
export function userDataDir(_appName: string, appData: string): string {
  return join(appData, 'sandbot')
}
