// S1 (fase isolamento-suite): le prove della GUARDIA dei servizi locali veri
// (src/test-local-services-guard.ts), quella che src/test-setup.ts installa in
// tutta la suite. Qui si prova ogni involucro da solo, su una porta LIBERA di
// 127.0.0.1 (la sceglie il sistema: mai una porta fissa, mai le porte dei
// servizi veri, che qui si leggono solo come testo): ferma il tentativo verso
// la porta sorvegliata PRIMA che parta (il server lì non vede nessuna
// connessione), lascia passare gli altri, e sa rimettersi com'era.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
import { KNOWN_BASE_URLS } from '../main/agent/live-models'
import { PORTE_SERVIZI_LOCALI_VERI, eUrlServizioLocaleVero } from '../main/local-services-registry'
import {
  ErroreServizioLocale, afterEachDellaGuardia, destinazioneRichiesta, installaGuardiaServiziLocali,
  messaggioGuardia, type GuardiaServiziLocali, type TentativoGuardia
} from '../test-local-services-guard'

/** Gli indirizzi noti dei due servizi: si leggono da KNOWN_BASE_URLS, mai scritti qui (la guardia F3 vieterebbe la porta). */
const noto = { ollama: KNOWN_BASE_URLS.ollama!, lmstudio: KNOWN_BASE_URLS.lmstudio! }
const portaDi = (base: string): string => new URL(base).port
/** Lo stesso indirizzo (stessa porta), su un altro host. */
const conHost = (url: string, host: string): string => { const u = new URL(url); u.hostname = host; return u.toString() }

/** Un server su 127.0.0.1, porta scelta dal sistema, che conta le connessioni che arrivano. */
const serverFinto = async (risposta = 'ok'): Promise<{ porta: number; arrivate: () => number; chiudi: () => Promise<void> }> => {
  let arrivate = 0
  const srv = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(risposta) })
  srv.on('connection', () => { arrivate++ })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const indirizzo = srv.address()
  if (indirizzo === null || typeof indirizzo === 'string') throw new Error('il server finto non ha una porta')
  return { porta: indirizzo.port, arrivate: () => arrivate, chiudi: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()) }) }
}

describe('S1: dove vuole arrivare una chiamata a http.request (puro)', () => {
  it('legge (url), (url, opzioni), (URL), (opzioni): le opzioni vincono sull\'URL', () => {
    expect(destinazioneRichiesta(['http://127.0.0.1:4321/api/tags'])).toEqual({ url: 'http://127.0.0.1:4321/api/tags', metodo: 'GET' })
    expect(destinazioneRichiesta([new URL('http://127.0.0.1:4321/api/tags?x=1'), () => undefined])).toEqual({ url: 'http://127.0.0.1:4321/api/tags?x=1', metodo: 'GET' })
    expect(destinazioneRichiesta(['http://127.0.0.1:4321/api/tags', { path: '/api/show', method: 'POST' }, () => undefined])).toEqual({ url: 'http://127.0.0.1:4321/api/show', metodo: 'POST' })
    // hostname vince su host, la porta può essere una stringa
    expect(destinazioneRichiesta([{ host: '127.0.0.1', hostname: 'localhost', port: '4321', path: '/v1/models', method: 'post' }])).toEqual({ url: 'http://localhost:4321/v1/models', metodo: 'POST' })
  })

  it('senza host è «localhost», senza porta quella del protocollo; l\'IPv6 sta tra parentesi', () => {
    expect(destinazioneRichiesta([{ port: 4321, path: '/x' }])?.url).toBe('http://localhost:4321/x')
    expect(destinazioneRichiesta(['http://localhost/api/tags'])?.url).toBe('http://localhost:80/api/tags')
    expect(destinazioneRichiesta(['https://example.com/x'], 'https:')?.url).toBe('https://example.com:443/x')
    expect(destinazioneRichiesta(['https://example.com/x'])?.url).toBe('https://example.com:443/x')
    expect(destinazioneRichiesta([{ host: '::1', port: 4321 }])?.url).toBe('http://[::1]:4321/')
    expect(destinazioneRichiesta([{ host: '[::1]', port: 4321 }])?.url).toBe('http://[::1]:4321/')
  })

  it('non è una connessione TCP (lo socket di dominio) o non si capisce: null', () => {
    expect(destinazioneRichiesta([{ socketPath: '/socket/compito.sock' }])).toBeNull()
    expect(destinazioneRichiesta([])).toBeNull()
    expect(destinazioneRichiesta([42])).toBeNull()
    expect(destinazioneRichiesta([undefined, () => undefined])).toBeNull()
    expect(destinazioneRichiesta(['non è un url'])).toBeNull()
  })

  it('le due richieste che l\'app fa a Ollama e quella a LM Studio sono di un servizio locale vero (è il registro a dirlo)', () => {
    const tags = destinazioneRichiesta([`${noto.ollama}/api/tags`])
    expect(tags).toEqual({ url: `${noto.ollama}/api/tags`, metodo: 'GET' })
    expect(destinazioneRichiesta([`${noto.ollama}/api/show`, { method: 'POST' }])).toEqual({ url: `${noto.ollama}/api/show`, metodo: 'POST' })
    expect(destinazioneRichiesta([`${noto.lmstudio}/v1/models`])?.url).toBe(`${noto.lmstudio}/v1/models`)
  })
})

describe('S1: il messaggio della guardia', () => {
  const t = (via: TentativoGuardia['via'], metodo: string | null, url: string, test: string | null = 'file.test.ts > suite > il test'): TentativoGuardia => ({ via, metodo, url, test })
  it('dice il nome del test, gli URL e quante volte (gli uguali su una riga sola)', () => {
    // l'elenco vivo di Ollama, com'è nel log del servizio: una /api/tags e dodici /api/show
    const dodici = Array.from({ length: 12 }, () => t('fetch', 'POST', `${noto.ollama}/api/show`))
    const msg = messaggioGuardia([t('fetch', 'GET', `${noto.ollama}/api/tags`), ...dodici, t('net.connect', null, `localhost:${portaDi(noto.lmstudio)}`)])
    expect(msg).toContain('il test «file.test.ts > suite > il test»')
    expect(msg).toContain('La connessione NON è partita')
    expect(msg).toContain('Tentativi fermati: 14')
    expect(msg).toContain(`  • fetch GET ${noto.ollama}/api/tags`)
    expect(msg).toContain(`  • fetch POST ${noto.ollama}/api/show ×12`)
    expect(msg).toContain(`  • net.connect localhost:${portaDi(noto.lmstudio)}`)
    expect(msg.split('\n').filter((r) => r.includes('/api/show'))).toHaveLength(1)
  })
  it('fuori da un test lo dice, invece del nome', () => {
    expect(messaggioGuardia([t('socket.connect', null, `127.0.0.1:${portaDi(noto.ollama)}`, null)])).toContain('fuori da un test ha provato')
  })
})

describe('S1: il registro dice quali sono i servizi locali veri (la guardia non ha una regola sua)', () => {
  it('le porte sorvegliate sono quelle degli indirizzi noti di Ollama e LM Studio', () => {
    expect([...PORTE_SERVIZI_LOCALI_VERI].sort()).toEqual([portaDi(noto.ollama), portaDi(noto.lmstudio)].map(Number).sort())
  })
  it('è un servizio locale vero solo la porta nota, su questa macchina — mai un\'altra porta, mai la stessa porta su un altro host', () => {
    expect(eUrlServizioLocaleVero(`${noto.ollama}/api/tags`)).toBe(true)
    expect(eUrlServizioLocaleVero(`${noto.lmstudio}/v1/models`)).toBe(true)
    expect(eUrlServizioLocaleVero(conHost(`${noto.ollama}/api/show`, '127.0.0.1'))).toBe(true)
    expect(eUrlServizioLocaleVero(conHost(`${noto.ollama}/api/tags`, '[::1]'))).toBe(true)
    expect(eUrlServizioLocaleVero('http://127.0.0.1:41134/api/tags')).toBe(false) // il server finto di un test: passa
    expect(eUrlServizioLocaleVero(conHost(`${noto.ollama}/api/tags`, '192.168.1.5'))).toBe(false)
    expect(eUrlServizioLocaleVero('ftp://localhost/x')).toBe(false)
    expect(eUrlServizioLocaleVero('non è un url')).toBe(false)
  })
})

describe('S1: l\'hook afterEach fa fallire chi ha inghiottito l\'errore, e lo dice una volta sola', () => {
  let sorvegliato: Awaited<ReturnType<typeof serverFinto>>
  let guardia: GuardiaServiziLocali
  const NOME = 'dopo.test.ts > suite > il test che inghiotte'
  beforeEach(async () => {
    sorvegliato = await serverFinto()
    guardia = installaGuardiaServiziLocali({ porte: new Set([sorvegliato.porta]), testCorrente: () => NOME, fuoriDalTest: () => undefined })
  })
  afterEach(async () => {
    guardia.disinstalla()
    await sorvegliato.chiudi()
  })

  it('nessun tentativo: l\'hook non dice niente', () => {
    expect(() => afterEachDellaGuardia(guardia, { result: { errors: [] } })).not.toThrow()
    expect(() => afterEachDellaGuardia(guardia, {})).not.toThrow()
  })

  it('il test ha inghiottito il rifiuto (come l\'elenco vivo di Ollama): l\'hook lo fa fallire col nome e l\'URL', async () => {
    // verde agli occhi di chi l'ha scritto: il rifiuto è finito in un catch
    await fetch(`http://localhost:${sorvegliato.porta}/api/tags`).catch(() => undefined)
    expect(guardia.tentativi()).toHaveLength(1)
    let errore: unknown
    try { afterEachDellaGuardia(guardia, { result: { errors: [] } }) } catch (e) { errore = e }
    expect(errore).toBeInstanceOf(ErroreServizioLocale)
    expect((errore as Error).message).toContain(`il test «${NOME}»`)
    expect((errore as Error).message).toContain(`fetch GET http://localhost:${sorvegliato.porta}/api/tags`)
    // i tentativi li ha presi lui: un secondo giro non ripete l\'errore
    expect(() => afterEachDellaGuardia(guardia, { result: { errors: [] } })).not.toThrow()
  })

  it('il test è già rosso per l\'errore della guardia: l\'hook non lo aggiunge una seconda volta', () => {
    expect(() => http.get(`http://127.0.0.1:${sorvegliato.porta}/api/show`)).toThrow(ErroreServizioLocale)
    const già = guardia.tentativi()
    expect(() => afterEachDellaGuardia(guardia, { result: { errors: [new ErroreServizioLocale(già)] } })).not.toThrow()
    // rosso per un ALTRO errore, col tentativo in mezzo: la guardia lo dice lo stesso
    expect(() => http.get(`http://127.0.0.1:${sorvegliato.porta}/v1/models`)).toThrow(ErroreServizioLocale)
    expect(() => afterEachDellaGuardia(guardia, { result: { errors: [new Error('un altro errore')] } })).toThrow(ErroreServizioLocale)
    // e anche se l'errore della guardia arrivasse all'hook già serializzato (di lui resta il nome)
    expect(() => http.get(`http://127.0.0.1:${sorvegliato.porta}/x`)).toThrow(ErroreServizioLocale)
    expect(() => afterEachDellaGuardia(guardia, { result: { errors: [{ name: 'ErroreServizioLocale', message: 'x' }] } })).not.toThrow()
  })
})

describe('S1: la guardia ferma ogni strada verso la porta sorvegliata e lascia passare le altre', () => {
  let sorvegliato: Awaited<ReturnType<typeof serverFinto>>
  let libero: Awaited<ReturnType<typeof serverFinto>>
  let guardia: GuardiaServiziLocali
  const fuori: ErroreServizioLocale[] = []
  const NOME = 'guardia.test.ts > suite > il test'
  const creaConnessionePrima = net.createConnection // scattata PRIMA dell'installazione: la strada sotto net.connect
  const fetchPrima = globalThis.fetch
  const connettiPrima = net.connect
  const socketConnettiPrima = net.Socket.prototype.connect
  const requestPrima = http.request
  const getPrima = http.get
  const httpsRequestPrima = https.request
  const httpsGetPrima = https.get

  beforeEach(async () => {
    fuori.length = 0
    ;[sorvegliato, libero] = await Promise.all([serverFinto(), serverFinto('passato')])
    guardia = installaGuardiaServiziLocali({ porte: new Set([sorvegliato.porta]), testCorrente: () => NOME, fuoriDalTest: (e) => fuori.push(e) })
  })
  afterEach(async () => {
    guardia.disinstalla()
    await Promise.all([sorvegliato.chiudi(), libero.chiudi()])
  })

  it('fetch verso la porta sorvegliata rifiuta col nome del test e l\'URL: la connessione non parte', async () => {
    const p = fetch(`http://localhost:${sorvegliato.porta}/api/tags`)
    await expect(p).rejects.toThrow(ErroreServizioLocale)
    await expect(p).rejects.toThrow(`il test «${NOME}»`)
    await expect(p).rejects.toThrow('fetch GET http://localhost:' + sorvegliato.porta + '/api/tags')
    await new Promise((r) => setTimeout(r, 50))
    expect(sorvegliato.arrivate()).toBe(0)
    expect(fuori).toEqual([]) // dentro un test: lo riferisce l'hook afterEach, non parte nulla di non gestito
    expect(guardia.tentativi()).toEqual([{ via: 'fetch', metodo: 'GET', url: `http://localhost:${sorvegliato.porta}/api/tags`, test: NOME }])
  })

  it('net.connect, http.request, http.get, https.request e https.get fermano subito (nessuna connessione)', () => {
    const host = `127.0.0.1:${sorvegliato.porta}`
    expect(() => net.connect(sorvegliato.porta, '127.0.0.1')).toThrow(ErroreServizioLocale)
    expect(() => net.createConnection({ port: sorvegliato.porta, host: '127.0.0.1' })).toThrow('net.connect 127.0.0.1:' + sorvegliato.porta)
    expect(() => http.request(`http://${host}/api/tags`)).toThrow('http.request GET http://' + host + '/api/tags')
    expect(() => http.get({ host: '127.0.0.1', port: sorvegliato.porta, path: '/api/tags' })).toThrow('http.get GET http://' + host + '/api/tags')
    expect(() => https.request(`https://${host}/api/show`, { method: 'POST' })).toThrow('https.request POST https://' + host + '/api/show')
    expect(() => https.get(`https://[::1]:${sorvegliato.porta}/api/tags`)).toThrow('https.get GET https://[::1]:' + sorvegliato.porta + '/api/tags')
    expect(sorvegliato.arrivate()).toBe(0)
    expect(guardia.tentativi().map((t) => t.via)).toEqual(['net.connect', 'net.connect', 'http.request', 'http.get', 'https.request', 'https.get'])
  })

  it('le strade sotto gli involucri (tls.connect, una connect scattata prima, un socket nudo) fermano all\'ultima rete: socket.connect', () => {
    expect(() => tls.connect({ port: sorvegliato.porta, host: '127.0.0.1' })).toThrow(ErroreServizioLocale)
    expect(() => Reflect.apply(creaConnessionePrima, net, [{ port: sorvegliato.porta, host: '127.0.0.1' }])).toThrow('socket.connect 127.0.0.1:' + sorvegliato.porta)
    const nudo = new net.Socket()
    expect(() => nudo.connect(sorvegliato.porta, '127.0.0.1')).toThrow('socket.connect 127.0.0.1:' + sorvegliato.porta)
    nudo.destroy()
    expect(sorvegliato.arrivate()).toBe(0)
    expect(guardia.tentativi().map((t) => t.via)).toEqual(['socket.connect', 'socket.connect', 'socket.connect'])
  })

  it('le altre porte passano: fetch (col corpo), http.get e net.connect arrivano al server', async () => {
    const res = await fetch(`http://127.0.0.1:${libero.porta}/api/show`, { method: 'POST', body: '{"model":"x"}' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('passato')
    const daGet = await new Promise<string>((r, j) => {
      http.get(`http://127.0.0.1:${libero.porta}/api/tags`, (x) => { let s = ''; x.on('data', (c) => { s += c }); x.on('end', () => r(s)) }).on('error', j)
    })
    expect(daGet).toBe('passato')
    const sock = net.connect(libero.porta, '127.0.0.1')
    await once(sock, 'connect')
    sock.destroy()
    // il server vede la connessione un istante dopo che il client l'ha vista lui
    for (let i = 0; i < 100 && libero.arrivate() < 3; i++) await new Promise((r) => setTimeout(r, 10))
    expect(libero.arrivate()).toBe(3)
    expect(guardia.tentativi()).toEqual([])
    expect(fuori).toEqual([])
  })

  it('un socket di dominio non è una connessione TCP: non lo guarda', async () => {
    // la richiesta parte davvero e cade da sola (quel socket non esiste): nessun involucro l'ha fermata
    const req = http.request({ socketPath: '/socket/compito.sock' })
    const errore: Error & { code?: string } = await new Promise((r) => req.on('error', r))
    expect(errore.code).toBe('ENOENT')
    expect(guardia.tentativi()).toEqual([])
    expect(sorvegliato.arrivate()).toBe(0)
  })

  it('fuori da un test l\'errore va a chi lo deve riferire (non c\'è un test da far fallire)', () => {
    const g = installaGuardiaServiziLocali({ porte: new Set([sorvegliato.porta]), fuoriDalTest: (e) => fuori.push(e) })
    try {
      expect(() => http.get(`http://127.0.0.1:${sorvegliato.porta}/x`)).toThrow(ErroreServizioLocale)
      expect(fuori).toHaveLength(1)
      expect(fuori[0]!.tentativi[0]).toMatchObject({ test: null, url: `http://127.0.0.1:${sorvegliato.porta}/x` })
      expect(fuori[0]!.message).toContain('fuori da un test ha provato')
    } finally { g.disinstalla() }
  })

  it('disinstalla rimette fetch, net.connect, socket.connect e http/https come erano', async () => {
    guardia.disinstalla()
    expect(globalThis.fetch).toBe(fetchPrima)
    expect(net.connect).toBe(connettiPrima)
    expect(net.createConnection).toBe(connettiPrima)
    expect(net.Socket.prototype.connect).toBe(socketConnettiPrima)
    expect(http.request).toBe(requestPrima)
    expect(http.get).toBe(getPrima)
    expect(https.request).toBe(httpsRequestPrima)
    expect(https.get).toBe(httpsGetPrima)
    // e verso la porta sorvegliata ora si arriva: non c'è più nessuno che guarda
    const res = await fetch(`http://127.0.0.1:${sorvegliato.porta}/api/tags`)
    expect(await res.text()).toBe('ok')
    expect(sorvegliato.arrivate()).toBe(1)
  })
})
