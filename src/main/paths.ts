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
 *
 * Fase rilascio (A8): SANDBOT_TEST_USER_DATA sposta la cartella dati
 * dell'INTERA app (è un override di userData, non solo del DB) anche
 * nell'app impacchettata — le prove manuali con la .app non toccano MAI i
 * dati veri. Variabile SANDBOT_TEST_*: in produzione non esiste.
 */
export function userDataDir(_appName: string, appData: string, env: NodeJS.ProcessEnv = process.env): string {
  const test = env.SANDBOT_TEST_USER_DATA
  if (test) return test
  return join(appData, 'sandbot')
}

/**
 * Fase rilascio (A8): la cartella dati non coincide MAI con quelle di Homun
 * 2 (<appData>/Homun2 o <appData>/Homun, engine compreso) — su APFS le
 * maiuscole non contano, il confronto è case-insensitive. True quando il
 * percorso è SICURO (non è una delle cartelle di Homun 2).
 */
export function isSafeUserDataDir(dir: string, appData: string): boolean {
  const norm = (p: string): string => p.toLowerCase().replace(/\/+$/, '')
  return norm(dir) !== norm(join(appData, 'homun')) && norm(dir) !== norm(join(appData, 'homun2'))
}
