// S1 (fase isolamento-suite): LA GUARDIA dei servizi locali veri nella suite.
// `npm test` non deve MAI toccare l'Ollama e il LM Studio del Mac (le porte di
// KNOWN_BASE_URLS): un test che li legge passa o fallisce secondo ciò che
// l'utente ha installato, e l'elenco dei SUOI modelli finisce nella corsa. Il
// 26/11, durante `npm test`, il log del servizio vero ha ricevuto una
// GET /api/tags e dodici POST /api/show; con la suite instrumentata (cinque
// corse, ogni connessione contata) nessun test ci ha provato. Il controllo
// resta lo stesso: d'ora in poi chi ci prova fallisce. Il registro di I1
// (main/local-services-registry.ts) non basta: si accende solo in prova
// (SANDBOT_TEST_USER_DATA) e Vitest non ce l'ha. Quindi qui una guardia FISSA,
// per tutta la suite — la installa src/test-setup.ts — come nello stato
// dell'arte (MSW onUnhandledRequest: 'error', nock.disableNetConnect), senza
// pacchetti nuovi.
//
// Gli involucri fermano il tentativo PRIMA che parta (il rosso non dipende dal
// fatto che il servizio vero risponda):
// - fetch: il globale di Node (undici), con l'URL della richiesta;
// - net.connect e net.createConnection (è la stessa funzione);
// - http.request, http.get, https.request e https.get: i .get NON passano
//   dalla proprietà request (chiamano la funzione del loro modulo), quindi si
//   avvolgono da soli;
// - net.Socket.prototype.connect: il punto per cui passano TUTTE le connessioni
//   TCP di Node, anche quelle che gli altri involucri non vedono (l'Agent di
//   http, che lega net.createConnection al CARICAMENTO del modulo; un
//   `import { connect } from 'node:net'`, che è una fotografia della funzione).
//   È l'ultima rete: niente arriva alle porte vere per una strada secondaria.
// Chi decide se una destinazione è un servizio locale vero è il registro
// (eServizioLocaleVero e le funzioni sue): nessun numero di porta scritto qui,
// nessuna regola duplicata.
//
// CHI FALLISCE. Fermare la richiesta non basta: chi la inghiotte (l'elenco
// vivo di Ollama ha un catch per ogni /api/show) farebbe passare il test lo
// stesso. Ogni tentativo si RICORDA, e un hook afterEach di tutta la suite fa
// fallire il test in cui è partito, col nome del test e gli URL. Fuori da un
// test (modulo, beforeAll, afterAll, dopo la fine) non c'è un test da far
// fallire: l'errore parte come rifiuto non gestito e lo riferisce Vitest
// («Unhandled Errors», la corsa esce con 1).
import { afterEach, beforeEach } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { urlToHttpOptions } from 'node:url'
import {
  PORTE_SERVIZI_LOCALI_VERI, destinazioneSocket, eServizioLocaleVero, eUrlServizioLocaleVero, urlDi
} from './main/local-services-registry'

/** L'involucro che ha fermato il tentativo. */
export type ViaGuardia = 'fetch' | 'net.connect' | 'http.request' | 'http.get' | 'https.request' | 'https.get' | 'socket.connect'

/** Un tentativo fermato dalla guardia. */
export interface TentativoGuardia {
  via: ViaGuardia
  /** il metodo della richiesta se l'involucro lo conosce (null per un socket nudo) */
  metodo: string | null
  /** dove voleva arrivare: l'URL della richiesta, o host:port per un socket nudo */
  url: string
  /** il nome completo del test in corso (file > suite > test), null fuori da un test */
  test: string | null
}

/** Un oggetto di opzioni (non una funzione, non un URL: quello si legge come URL). */
const èOggetto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !(v instanceof URL)

/** Il metodo di una richiesta: mai vuoto. */
const metodoDi = (m: unknown): string => (typeof m === 'string' && m !== '' ? m : 'GET').toUpperCase()

/** PURA. Gli uguali (stessa via, stesso metodo, stesso URL) su una riga sola, con quante volte. */
export function raggruppaTentativi(tentativi: readonly TentativoGuardia[]): Array<{ tentativo: TentativoGuardia; n: number }> {
  const righe = new Map<string, { tentativo: TentativoGuardia; n: number }>()
  for (const t of tentativi) {
    const r = righe.get(`${t.via}|${t.metodo}|${t.url}`)
    if (r) r.n++
    else righe.set(`${t.via}|${t.metodo}|${t.url}`, { tentativo: t, n: 1 })
  }
  return [...righe.values()]
}

/** PURA. Il messaggio della guardia per un elenco di tentativi fermati. */
export function messaggioGuardia(tentativi: readonly TentativoGuardia[]): string {
  const test = tentativi.find((t) => t.test !== null)?.test ?? null
  const chi = test === null ? 'fuori da un test' : `il test «${test}»`
  const elenco = raggruppaTentativi(tentativi).map(({ tentativo: t, n }) => `  • ${[t.via, t.metodo, t.url].filter((x) => x !== null && x !== '').join(' ')}${n > 1 ? ` ×${n}` : ''}`)
  return [
    `guardia servizi locali: ${chi} ha provato a collegarsi a un servizio locale VERO di questo Mac (Ollama o LM Studio).`,
    'La connessione NON è partita. Nella suite i servizi locali sono finti: fetch finto, o un server finto su porta 0 (scripts/lib/servizio-locale-finto.mjs).',
    `Tentativi fermati: ${tentativi.length}`,
    ...elenco
  ].join('\n')
}

const NOME_ERRORE = 'ErroreServizioLocale'

/** L'errore della guardia: lo riceve chi ha provato a collegarsi, e lo riferiscono gli hook. */
export class ErroreServizioLocale extends Error {
  constructor(readonly tentativi: TentativoGuardia[]) {
    super(messaggioGuardia(tentativi))
    this.name = NOME_ERRORE
  }
}

/** È l'errore della guardia — l'oggetto vero, o già serializzato (di lui resta il nome). */
const èErroreDellaGuardia = (e: unknown): boolean =>
  e instanceof ErroreServizioLocale || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === NOME_ERRORE)

/**
 * PURA. Dove vuole arrivare una chiamata a http.request/http.get (o a quelli di
 * https): (url[, opzioni][, callback]), (URL[, opzioni]) o (opzioni). Le
 * opzioni vincono sull'URL, senza host è «localhost», senza porta quella del
 * protocollo — come legge Node. null se non è una connessione TCP (lo socket
 * di dominio { path }) o se non si capisce.
 */
export function destinazioneRichiesta(args: readonly unknown[], protocollo: 'http:' | 'https:' = 'http:'): { url: string; metodo: string } | null {
  const [primo, secondo] = args
  let o: Record<string, unknown>
  if (typeof primo === 'string' || primo instanceof URL) {
    try { o = urlToHttpOptions(new URL(primo)) as unknown as Record<string, unknown> } catch { return null }
    if (èOggetto(secondo)) o = { ...o, ...secondo }
  } else if (èOggetto(primo)) {
    o = èOggetto(secondo) ? { ...primo, ...secondo } : { ...primo }
  } else {
    return null
  }
  if (o.socketPath !== undefined && o.socketPath !== null) return null
  const protocolloEffettivo = o.protocol === 'https:' ? 'https:' : o.protocol === 'http:' ? 'http:' : protocollo
  const porta = o.port ?? (protocolloEffettivo === 'https:' ? 443 : 80)
  const host = String(o.hostname ?? o.host ?? 'localhost')
  // l'IPv6 va tra parentesi per stare in un URL
  const hostUrl = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return {
    url: `${protocolloEffettivo}//${hostUrl}:${porta}${typeof o.path === 'string' ? o.path : '/'}`,
    metodo: metodoDi(o.method)
  }
}

export interface OpzioniGuardia {
  /** le porte da sorvegliare: quelle dei servizi veri (default) o altre, per le prove */
  porte?: ReadonlySet<number>
  /** il nome completo del test in corso, null fuori da un test (default: sempre null) */
  testCorrente?: () => string | null
  /** un tentativo fermato FUORI da un test: non c'è un test da far fallire (default: niente) */
  fuoriDalTest?: (errore: ErroreServizioLocale) => void
}

export interface GuardiaServiziLocali {
  /** i tentativi fermati finora in questo processo */
  tentativi: () => TentativoGuardia[]
  /** toglie dall'elenco i tentativi fermati finora e li restituisce (li riferisce l'hook afterEach) */
  ritira: () => TentativoGuardia[]
  /** rimette fetch, net.connect, http/https e socket.connect come erano */
  disinstalla: () => void
}

type ConnettiNet = typeof net.connect
type ConnettiSocket = net.Socket['connect']
type Richiesta = (...args: unknown[]) => unknown
type ModuloRichiesta = { request: Richiesta; get: Richiesta }

/**
 * Installa gli involucri nel processo. Le porte sorvegliate sono quelle dei
 * servizi veri, o altre per le prove (su porte libere: le vere non si toccano
 * nemmeno nei test della guardia).
 */
export function installaGuardiaServiziLocali(opz: OpzioniGuardia = {}): GuardiaServiziLocali {
  const porte = opz.porte ?? PORTE_SERVIZI_LOCALI_VERI
  const fermati: TentativoGuardia[] = []
  const ferma = (via: ViaGuardia, metodo: string | null, url: string): ErroreServizioLocale => {
    const t: TentativoGuardia = { via, metodo, url, test: opz.testCorrente?.() ?? null }
    fermati.push(t)
    const errore = new ErroreServizioLocale([t])
    if (t.test === null) opz.fuoriDalTest?.(errore)
    return errore
  }
  const hostPorta = (d: { host: string; porta: number }): string => `${d.host}:${d.porta}`

  const fetchOriginale = globalThis.fetch
  const fetchGuardia: typeof fetch = function (this: unknown, input, init) {
    const url = urlDi(input)
    if (url !== null && eUrlServizioLocaleVero(url, porte)) return Promise.reject(ferma('fetch', metodoDi(init?.method), url))
    return fetchOriginale.call(this, input, init)
  }

  const connettiOriginale: ConnettiNet = net.connect
  const connettiGuardia = function (this: unknown, ...args: unknown[]) {
    const d = destinazioneSocket(args)
    if (d !== null && eServizioLocaleVero(d.host, d.porta, porte)) throw ferma('net.connect', null, hostPorta(d))
    return connettiOriginale.apply(this, args as never)
  } as ConnettiNet

  const socketConnettiOriginale: ConnettiSocket = net.Socket.prototype.connect
  const socketConnettiGuardia = function (this: net.Socket, ...args: unknown[]) {
    const d = destinazioneSocket(args)
    if (d !== null && eServizioLocaleVero(d.host, d.porta, porte)) throw ferma('socket.connect', null, hostPorta(d))
    return socketConnettiOriginale.apply(this, args as never)
  } as ConnettiSocket

  const ripristini: Array<() => void> = []
  for (const [nome, protocollo, modulo] of [['http', 'http:', http], ['https', 'https:', https]] as const) {
    for (const funzione of ['request', 'get'] as const) {
      const moduloRichiesta = modulo as ModuloRichiesta
      const originale = moduloRichiesta[funzione]
      moduloRichiesta[funzione] = function (this: unknown, ...args: unknown[]) {
        const d = destinazioneRichiesta(args, protocollo)
        if (d !== null && eUrlServizioLocaleVero(d.url, porte)) throw ferma(`${nome}.${funzione}` as ViaGuardia, d.metodo, d.url)
        return Reflect.apply(originale, this, args)
      }
      ripristini.push(() => { moduloRichiesta[funzione] = originale })
    }
  }

  globalThis.fetch = fetchGuardia
  net.connect = connettiGuardia
  net.createConnection = connettiGuardia
  net.Socket.prototype.connect = socketConnettiGuardia

  return {
    tentativi: () => [...fermati],
    ritira: () => fermati.splice(0),
    disinstalla: () => {
      globalThis.fetch = fetchOriginale
      net.connect = connettiOriginale
      net.createConnection = connettiOriginale
      net.Socket.prototype.connect = socketConnettiOriginale
      for (const ripristina of ripristini) ripristina()
    }
  }
}

/**
 * L'hook afterEach della guardia: il test corrente ha fermato dei tentativi?
 * Allora fallisce, col nome del test e gli URL — anche se lui l'errore se l'è
 * inghiottito. Se invece l'errore della guardia è arrivato fino al test, che
 * è già rosso per quello, lo dice una volta sola.
 */
export function afterEachDellaGuardia(guardia: GuardiaServiziLocali, task: { result?: { errors?: unknown[] } }): void {
  const fermati = guardia.ritira()
  if (fermati.length === 0) return
  if (task.result?.errors?.some(èErroreDellaGuardia)) return
  throw new ErroreServizioLocale(fermati)
}

/**
 * La guardia di tutta la suite (la installa src/test-setup.ts, una volta per
 * processo di test): gli involucri più gli hook che fanno FALLIRE il test.
 * Il beforeEach di un setup file corre PRIMA di quelli del file, l'afterEach
 * per ULTIMO: un tentativo che parte nel test o nei suoi hook resta nel suo elenco.
 * Le porte sono quelle dei servizi veri; le prove ne passano altre, libere.
 */
export function guardiaServiziLocaliDellaSuite(opz: Pick<OpzioniGuardia, 'porte'> = {}): void {
  let test: string | null = null
  const guardia = installaGuardiaServiziLocali({
    porte: opz.porte,
    testCorrente: () => test,
    fuoriDalTest: (errore) => { void Promise.reject(errore) }
  })
  beforeEach(({ task }) => {
    // un tentativo partito fuori da un test l'ha già riferito fuoriDalTest:
    // non lo si appioppa al primo test che viene
    guardia.ritira()
    test = task.fullName
  })
  afterEach(({ task }) => {
    test = null
    afterEachDellaGuardia(guardia, task)
  })
}
