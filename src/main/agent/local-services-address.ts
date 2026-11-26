// I1 (fase isolamento-locale): l'indirizzo dei servizi LLM locali — Ollama e
// LM Studio — si INIETTA, non si scrive fisso. Fino alla fase
// linguaggio-ritocchi l'app in prova li cercava agli indirizzi di
// KNOWN_BASE_URLS, cioè ai servizi VERI del Mac: la galleria catturava la
// riga «Ollama (locale)» con i modelli che quell'Ollama aveva in quel momento
// (o senza riga, se era spento) — la scena dipendeva da cosa girava sul Mac.
//
// Tre stati, tutti decisi dall'env ALL'AVVIO (main/index.ts e daemon/index.ts
// chiamano installaIndirizziLocaliInProva):
// - APP VERA (senza SANDBOT_TEST_USER_DATA): non cambia niente — ogni richiesta
//   va all'indirizzo letto, come sempre;
// - IN PROVA coi servizi FINTI del motore di sonde e galleria
//   (SANDBOT_TEST_LOCAL_LLM_URLS="ollama=http://127.0.0.1:PORT,lmstudio=…"):
//   al posto dell'indirizzo NOTO di quel kind si usa quello iniettato;
// - IN PROVA senza servizio (la variabile manca, o la voce non è valida):
//   verso l'indirizzo noto non parte NESSUNA richiesta.
// Un indirizzo SCELTO — un'altra porta, un altro host: il provider finto di
// una sonda, l'Ollama di un altro computer — non è quello fisso e resta
// com'è in tutti e tre gli stati. I record salvati non cambiano mai: il
// provider «Ollama (locale)» resta con l'indirizzo noto anche in prova; la
// sostituzione avviene solo al momento della richiesta, nel main (è il main
// — UI e daemon — che parla con i servizi: il renderer non li chiama).
// Il controllo che prende chi sbaglia è il registro delle connessioni
// (local-services-registry.ts): una richiesta verso le porte vere è un rosso.
import type { ProviderKind } from '../../shared/types'
import { isLoopbackHost } from '../../shared/network-host'
import { eServizioLocaleVero } from '../local-services-registry'
import { KNOWN_BASE_URLS, setRisolutoreServizioLocale } from './live-models'

export const ENV_PROVA = 'SANDBOT_TEST_USER_DATA'
export const ENV_INDIRIZZI_LOCALI_IN_PROVA = 'SANDBOT_TEST_LOCAL_LLM_URLS'

/** I servizi locali del Mac: gli unici il cui indirizzo noto si inietta. */
export const KIND_SERVIZI_LOCALI = ['ollama', 'lmstudio'] as const
export type KindServizioLocale = (typeof KIND_SERVIZI_LOCALI)[number]

const eKindServizioLocale = (kind: string): kind is KindServizioLocale => kind === 'ollama' || kind === 'lmstudio'

/**
 * Gli indirizzi dei servizi locali in una corsa: null = l'app VERA (non
 * cambia niente); in prova, per ogni kind l'origine del servizio FINTO
 * iniettato dal motore, o null se in quella prova il servizio è assente.
 */
export interface IndirizziLocaliInProva {
  ollama: string | null
  lmstudio: string | null
}

/**
 * Un indirizzo di questa macchina dove non ascolta nessuno: l'adattatore in
 * prova senza servizio parla lì, e la richiesta cade subito (connessione
 * rifiutata) come verso un servizio spento — mai verso la porta vera.
 */
export const INDIRIZZO_ASSENTE_IN_PROVA = 'http://127.0.0.1:1'

/**
 * PURA. Una voce di SANDBOT_TEST_LOCAL_LLM_URLS: l'origine http(s) di QUESTA
 * macchina, con la porta (scelta dal sistema: i finti nascono su porta 0) e
 * senza percorso. Non è iniettabile l'indirizzo di un servizio VERO (una
 * delle porte note): si vorrebbe sostituire con sé stesso.
 */
export function indirizzoIniettatoDaTesto(testo: string | undefined): string | null {
  if (typeof testo !== 'string' || testo.trim() === '') return null
  let u: URL
  try {
    u = new URL(testo.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!isLoopbackHost(u.hostname)) return null
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') return null
  const porta = Number(u.port)
  if (!Number.isInteger(porta) || porta <= 0) return null
  if (eServizioLocaleVero(u.hostname, porta)) return null
  return u.origin
}

/**
 * PURA. La tabella dall'env: «ollama=http://127.0.0.1:PORTA,lmstudio=…». Nell'app
 * vera (senza SANDBOT_TEST_USER_DATA) è null; in prova una voce che manca o
 * non è valida vale «assente». Le voci di altri kind si ignorano.
 */
export function indirizziLocaliInProvaDaEnv(env: Record<string, string | undefined>): IndirizziLocaliInProva | null {
  if (!env[ENV_PROVA]) return null
  const tabella: IndirizziLocaliInProva = { ollama: null, lmstudio: null }
  for (const voce of (env[ENV_INDIRIZZI_LOCALI_IN_PROVA] ?? '').split(',')) {
    const uguale = voce.indexOf('=')
    if (uguale < 0) continue
    const kind = voce.slice(0, uguale).trim()
    if (!eKindServizioLocale(kind)) continue
    tabella[kind] = indirizzoIniettatoDaTesto(voce.slice(uguale + 1))
  }
  return tabella
}

/**
 * PURA. `base` è l'indirizzo NOTO del kind? Solo l'origine: la porta vera di
 * quel servizio (quella di KNOWN_BASE_URLS) su questa macchina. Un percorso,
 * un'altra porta o un altro host sono scelte, non l'indirizzo fisso.
 */
export function eIndirizzoNoto(kind: KindServizioLocale, base: string): boolean {
  const noto = KNOWN_BASE_URLS[kind]
  if (typeof noto !== 'string') return false
  try {
    const u = new URL(base.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (u.pathname !== '/' || u.search !== '' || u.hash !== '') return false
    return isLoopbackHost(u.hostname) && Number(u.port) === Number(new URL(noto).port)
  } catch {
    return false
  }
}

/**
 * PURA. Il base URL con cui parlare a un provider:
 * - app vera (tabella null): `baseLetto`, sempre;
 * - in prova: l'indirizzo NOTO di Ollama o LM Studio diventa quello iniettato
 *   (stringa) o null — il servizio è assente, nessuna richiesta deve partire;
 *   ogni altro indirizzo, e ogni altro kind, resta `baseLetto`.
 */
export function baseLocaleInProva(kind: ProviderKind, baseLetto: string, tabella: IndirizziLocaliInProva | null): string | null {
  if (tabella === null || !eKindServizioLocale(kind)) return baseLetto
  return eIndirizzoNoto(kind, baseLetto) ? tabella[kind] : baseLetto
}

let tabellaCorrente: IndirizziLocaliInProva | null = null

/** Gli indirizzi in prova di QUESTO corsa (null = app vera). */
export function indirizziLocaliInProva(): IndirizziLocaliInProva | null {
  return tabellaCorrente
}

/**
 * Legge l'env una volta per tutte e mette la regola nel risolutore di
 * live-models — la porta unica di scoperta, elenco vivo, capability e
 * adattatore. Lo chiamano SOLO i due punti d'ingresso del main.
 */
export function installaIndirizziLocaliInProva(env: Record<string, string | undefined>): IndirizziLocaliInProva | null {
  tabellaCorrente = indirizziLocaliInProvaDaEnv(env)
  const tabella = tabellaCorrente
  setRisolutoreServizioLocale((kind, baseLetto) => baseLocaleInProva(kind, baseLetto, tabella))
  return tabellaCorrente
}
