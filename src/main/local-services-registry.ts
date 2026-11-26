// I1 (fase isolamento-locale): IL REGISTRO delle connessioni verso i servizi
// LLM locali VERI del Mac — Ollama e LM Studio, agli indirizzi di
// KNOWN_BASE_URLS. In prova (SANDBOT_TEST_USER_DATA) l'app non deve
// toccarli: i servizi locali sono finti (indirizzo iniettato dal motore
// delle sonde) o assenti. Questo è il CONTROLLO che lo prende da solo: nel
// processo main — UI e daemon, è lo stesso eseguibile — ogni connessione in
// uscita verso quelle porte di QUESTA macchina si scrive appena PARTE, in
// una riga JSON del registro, con l'URL della richiesta e la scena corrente.
// Così il rosso si vede anche se il servizio vero è spento: non serve che
// risponda.
//
// Due involucri, entrambi attivi SOLO in prova:
// - fetch (il globale di Node): ricorda l'URL della richiesta in corso;
// - net.Socket.prototype.connect: il punto per cui passano TUTTE le
//   connessioni TCP di Node — net.connect, http.Agent (che lega
//   net.createConnection al CARICAMENTO del modulo: un involucro messo
//   dopo su net.connect non lo vedrebbe), tls.connect e il fetch di undici.
// Nell'app vera (senza SANDBOT_TEST_USER_DATA) non si installa nulla.
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { isLoopbackHost } from '../shared/network-host'
import { KNOWN_BASE_URLS } from './agent/live-models'

/** Il registro: una riga JSON per tentativo, nella cartella dati della prova (o dove dice SANDBOT_TEST_LOCAL_LLM_LOG). */
export const NOME_REGISTRO_LOCALI = 'registro-servizi-locali.jsonl'

const portaDi = (url: string): number => Number(new URL(url).port)

/**
 * Le porte dei servizi LLM locali veri: quelle degli indirizzi noti — l'unica
 * tabella è KNOWN_BASE_URLS, così non c'è un numero da tenere allineato.
 */
export const PORTE_SERVIZI_LOCALI_VERI: ReadonlySet<number> = new Set(
  [KNOWN_BASE_URLS.ollama, KNOWN_BASE_URLS.lmstudio]
    .filter((u): u is string => typeof u === 'string')
    .map(portaDi)
)

export type ViaTentativo = 'fetch' | 'socket'

/** Una connessione partita verso un servizio locale vero. */
export interface TentativoServizioLocale {
  /** quando la connessione è PARTITA (ISO) */
  t: string
  pid: number
  modo: 'ui' | 'daemon'
  via: ViaTentativo
  host: string
  porta: number
  /** l'URL della richiesta fetch da cui è partita; null per un socket nudo */
  url: string | null
  /** la scena che il motore stava catturando (letta dal file della scena corrente); null se non c'è */
  scena: string | null
}

/**
 * PURA. La connessione verso (host, porta) va verso un servizio locale VERO?
 * Solo le porte sorvegliate, e solo di questa macchina (localhost,
 * 127.0.0.0/8, ::1): la stessa porta su un altro host non è affare della prova.
 */
export function eServizioLocaleVero(host: string, porta: number, porte: ReadonlySet<number> = PORTE_SERVIZI_LOCALI_VERI): boolean {
  return Number.isInteger(porta) && porte.has(porta) && isLoopbackHost(host)
}

/** PURA. L'URL è quello di un servizio locale vero? Tutto il resto (anche un URL illeggibile) è false. */
export function eUrlServizioLocaleVero(url: string, porte: ReadonlySet<number> = PORTE_SERVIZI_LOCALI_VERI): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && eServizioLocaleVero(u.hostname, Number(u.port), porte)
  } catch {
    return false
  }
}

/**
 * PURA. Dove vuole arrivare una chiamata a socket.connect: (host, porta), o
 * null se non è una connessione TCP (un socket di dominio: { path }) o non
 * si capisce. net.connect(...args) passa a socket.connect UNA volta sola
 * l'elenco normalizzato [opzioni, ascoltatore]; le altre forme di Node sono
 * connect(porta[, host][, ascoltatore]), connect(percorso[, ascoltatore]),
 * connect(opzioni[, ascoltatore]) e connect(opzioni, porta, host) — senza
 * host è «localhost», cioè questa macchina.
 */
export function destinazioneSocket(args: readonly unknown[]): { host: string; porta: number } | null {
  const [primo, secondo] = Array.isArray(args[0]) ? (args[0] as readonly unknown[]) : args
  if (typeof primo === 'object' && primo !== null) {
    const o = primo as { port?: unknown; host?: unknown; path?: unknown }
    if (typeof o.path === 'string') return null
    const porta = o.port === undefined || o.port === null ? secondo : o.port
    if (typeof porta !== 'number' && typeof porta !== 'string') return null
    const n = Number(porta)
    if (!/^\d+$/.test(String(porta)) || n <= 0) return null
    return { host: typeof o.host === 'string' && o.host !== '' ? o.host : 'localhost', porta: n }
  }
  if (typeof primo === 'number' || (typeof primo === 'string' && /^\d+$/.test(primo))) {
    return { host: typeof secondo === 'string' && secondo !== '' ? secondo : 'localhost', porta: Number(primo) }
  }
  return null
}

/** L'URL di ciò che è stato passato a fetch (una stringa, un URL, una Request). */
function urlDi(input: unknown): string | null {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (typeof input === 'object' && input !== null && 'url' in input && typeof (input as { url: unknown }).url === 'string') {
    return (input as { url: string }).url
  }
  return null
}

export interface RegistroServiziLocali {
  /** i tentativi registrati FINORA in questo processo */
  tentativi: () => TentativoServizioLocale[]
  /** rimette fetch e socket.connect come erano */
  disinstalla: () => void
}

export interface OpzioniRegistro {
  env: Record<string, string | undefined>
  modo: 'ui' | 'daemon'
  /** le porte da sorvegliare: quelle dei servizi veri (default) o altre, per le prove */
  porte?: ReadonlySet<number>
  /** chi riceve le righe su stderr (default: process.stderr) */
  stderr?: (riga: string) => void
}

/**
 * Installa il registro nel processo. Nell'app vera (senza
 * SANDBOT_TEST_USER_DATA) restituisce null e non tocca nulla.
 */
export function installaRegistroServiziLocali(opz: OpzioniRegistro): RegistroServiziLocali | null {
  const { env, modo } = opz
  if (!env.SANDBOT_TEST_USER_DATA) return null
  const porte = opz.porte ?? PORTE_SERVIZI_LOCALI_VERI
  const percorso = env.SANDBOT_TEST_LOCAL_LLM_LOG?.trim() || join(env.SANDBOT_TEST_USER_DATA, NOME_REGISTRO_LOCALI)
  const fileScena = env.SANDBOT_TEST_LOCAL_LLM_SCENE?.trim() || null
  const suStderr = opz.stderr ?? ((riga: string) => { process.stderr.write(riga) })

  const scenaCorrente = (): string | null => {
    if (fileScena === null) return null
    try { return readFileSync(fileScena, 'utf8').trim() || null } catch { return null }
  }

  const registro: TentativoServizioLocale[] = []
  const registra = (via: ViaTentativo, host: string, porta: number, url: string | null): void => {
    const r: TentativoServizioLocale = { t: new Date().toISOString(), pid: process.pid, modo, via, host, porta, url, scena: scenaCorrente() }
    registro.push(r)
    const riga = JSON.stringify(r)
    // sincrono e subito: il processo può essere ucciso un istante dopo, la riga dev'essere già nel file
    try { appendFileSync(percorso, riga + '\n') } catch { /* la cartella non c'è più: la riga resta su stderr */ }
    try { suStderr(`[servizi-locali] ${riga}\n`) } catch { /* stderr chiuso: la riga sta nel registro */ }
  }

  // il contesto di una richiesta fetch verso un servizio locale vero: l'URL e
  // se la sua connessione è già stata registrata (una riga per richiesta)
  const contesto = new AsyncLocalStorage<{ url: string; registrato: boolean }>()

  const fetchOriginale = globalThis.fetch
  const fetchRegistrata: typeof fetch = (input, init) => {
    const url = urlDi(input)
    if (url !== null && eUrlServizioLocaleVero(url, porte)) {
      return contesto.run({ url, registrato: false }, () => fetchOriginale(input, init))
    }
    return fetchOriginale(input, init)
  }

  type Connetti = net.Socket['connect']
  const connettiOriginale: Connetti = net.Socket.prototype.connect
  const connettiRegistrato: Connetti = function (this: net.Socket, ...args: unknown[]) {
    const d = destinazioneSocket(args)
    if (d !== null && eServizioLocaleVero(d.host, d.porta, porte)) {
      const dentro = contesto.getStore()
      if (dentro === undefined) registra('socket', d.host, d.porta, null)
      else if (!dentro.registrato) {
        dentro.registrato = true
        registra('fetch', d.host, d.porta, dentro.url)
      }
    }
    return connettiOriginale.apply(this, args as never)
  } as Connetti

  globalThis.fetch = fetchRegistrata
  net.Socket.prototype.connect = connettiRegistrato

  return {
    tentativi: () => [...registro],
    disinstalla: () => {
      globalThis.fetch = fetchOriginale
      net.Socket.prototype.connect = connettiOriginale
    }
  }
}
