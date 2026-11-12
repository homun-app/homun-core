// BR2 (fase box-rete): il proxy del browser apre un SECONDO asCOLTO sul
// GATEWAY della rete homun-box del box Apple — il browser del box lo
// raggiunge lì (host.docker.internal non esiste con Apple: il Mac sta al
// gateway della vmnet). Le regole:
// - MAI su 0.0.0.0 (sarebbe la LAN) e MAI sul gateway della rete isolata;
// - sul secondo ascolto passano SOLO i client della sottorete di homun-box
//   (funzione PURA: dentro, fuori, IPv6, indirizzo mappato ::ffff:);
// - in USCITA il proxy rifiuta qualunque destinazione della sottorete del
//   box, gateway compreso (192.0.x.y NON è un intervallo privato classico:
//   la lista dei privati non basta);
// - l'IP del gateway esiste solo a rete vmnet attiva: su EADDRNOTAVAIL si
//   riprova con pausa crescente, poi lo si dice nel log e il browser del
//   bot fallisce in parole.
// L'host d'ascolto è INIETTABILE: nei test basta 127.0.0.1 — la logica da
// provare è QUALE indirizzo, QUALE porta e il FILTRO. Nessuna rete esterna.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'
import {
  proxyDecision,
  gatewayClientAllowed,
  ensureBrowserProxy,
  ensureBrowserProxyGateway,
  browserProxyPort,
  resetBrowserProxyForTests,
  BROWSER_PROXY_GATEWAY_FAILED_MESSAGE
} from '../browser-proxy'

const LOOPBACK_FLAG = 'SANDBOT_WEB_FETCH_ALLOW_LOOPBACK'

// ---- PURE: chi può parlare col secondo ascolto ----

describe('BR2: gatewayClientAllowed (PURO) — solo la sottorete di homun-box', () => {
  const SUBNET = '192.0.15.0/24'
  it('DENTRO la sottorete passa: il box, il secondo, il gateway stesso', () => {
    expect(gatewayClientAllowed('192.0.15.5', SUBNET)).toBe(true)
    expect(gatewayClientAllowed('192.0.15.254', SUBNET)).toBe(true)
    expect(gatewayClientAllowed('192.0.15.1', SUBNET)).toBe(true) // il gateway
  })

  it('FUORI non passa: l\'altra rete di Homun, la LAN, Internet, il loopback', () => {
    expect(gatewayClientAllowed('192.0.16.1', SUBNET)).toBe(false) // homun-box-isolated
    expect(gatewayClientAllowed('192.168.1.10', SUBNET)).toBe(false)
    expect(gatewayClientAllowed('8.8.8.8', SUBNET)).toBe(false)
    expect(gatewayClientAllowed('127.0.0.1', SUBNET)).toBe(false)
  })

  it('IPv6 e indirizzi MAPPATI: ::ffff:192.0.15.7 è DENTRO, ::1 e ::ffff:esterni no', () => {
    expect(gatewayClientAllowed('::ffff:192.0.15.7', SUBNET)).toBe(true)
    expect(gatewayClientAllowed('::ffff:8.8.8.8', SUBNET)).toBe(false)
    expect(gatewayClientAllowed('::1', SUBNET)).toBe(false)
  })

  it('fail closed: IP non valido, subnet non valida o senza indirizzo → MAI', () => {
    expect(gatewayClientAllowed('non-un-ip', SUBNET)).toBe(false)
    expect(gatewayClientAllowed(undefined, SUBNET)).toBe(false)
    expect(gatewayClientAllowed('', SUBNET)).toBe(false)
    expect(gatewayClientAllowed('192.0.15.5', 'non-un-cidr')).toBe(false)
    expect(gatewayClientAllowed('192.0.15.5', '192.0.15.0')).toBe(false) // manca /24
  })
})

// ---- PURE: le destinazioni della sottorete del box restano VIETATE in uscita ----

describe('BR2: proxyDecision — la sottorete del box è vietata come destinazione', () => {
  const BOX = ['192.0.15.0/24'] as const
  it('192.0.x.y NON è un privato classico: SENZA la regola del box passerebbe — CON la regola no', () => {
    // il difetto: la lista dei privati non conosce 192.0.x.y, la regola del box sì
    expect(proxyDecision('bersaglio', 443, ['192.0.15.5']).allow).toBe(true)
    const r = proxyDecision('bersaglio', 443, ['192.0.15.5'], BOX)
    expect(r.allow).toBe(false)
    if (!r.allow) expect(r.reason).toContain('internal address')
  })

  it('il GATEWAY compreso, e ogni indirizzo della sottorete; fuori dalla sottorete resta il confine di sempre', () => {
    expect(proxyDecision('gateway', 443, ['192.0.15.1'], BOX).allow).toBe(false)
    expect(proxyDecision('box-lontano', 80, ['192.0.15.200'], BOX).allow).toBe(false)
    expect(proxyDecision('pubblico', 443, ['93.184.216.34'], BOX).allow).toBe(true)
    expect(proxyDecision('altra-rete', 443, ['192.0.16.1'], BOX).allow).toBe(true) // non è la sottorete DEL box
  })

  it('un CIDR rotto nella regola non apre buchi: si nega (fail closed)', () => {
    expect(proxyDecision('chiunque', 443, ['93.184.216.34'], ['rotto/xx']).allow).toBe(false)
  })
})

// ---- il secondo ascolto, con host INIETTABILE (nei test 127.0.0.1) ----

let web: http.Server
let webPort = 0

beforeAll(async () => {
  // il server locale che il proxy deve raggiungere (solo col flag di test)
  web = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('risposta-del-server-locale')
  })
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r))
  webPort = (web.address() as net.AddressInfo).port
  await ensureBrowserProxy()
})

afterAll(async () => {
  await resetBrowserProxyForTests()
  web.close()
})

/** Richiesta http attraverso l'ascolto del gateway (come farebbe il browser del box). */
function gatewayGet(port: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: url, headers: { host: u.host } },
      (res) => {
        let body = ''
        res.on('data', (d: Buffer) => { body += d.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    req.setTimeout(2_000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

describe('BR2: ensureBrowserProxyGateway — il secondo ascolto sul gateway', () => {
  it('stessa porta SE POSSIBILE, altrimenti un\'ALTRA porta: il loopback la tiene, il gateway ne prende una sua', async () => {
    const loopbackPort = browserProxyPort()
    expect(loopbackPort).toBeGreaterThan(0)
    // host iniettabile: nei test il «gateway» è 127.0.0.1, dove la porta del
    // loopback è GIÀ occupata dal primo ascolto → il secondo ne prende UNA SUA
    const info = await ensureBrowserProxyGateway('127.0.0.1', '127.0.0.0/8')
    expect(info.host).toBe('127.0.0.1')
    expect(info.port).toBeGreaterThan(0)
    expect(info.port).not.toBe(loopbackPort)
  })

  it('il browser del box ATTRAVERSA il secondo ascolto (client nella sottorete giusta)', async () => {
    const prev = process.env[LOOPBACK_FLAG]
    process.env[LOOPBACK_FLAG] = '1'
    try {
      // la sottorete dichiarata contiene il client del test (127.0.0.1)
      const info = await ensureBrowserProxyGateway('127.0.0.1', '127.0.0.0/8')
      const r = await gatewayGet(info.port, `http://127.0.0.1:${webPort}/pagina`)
      expect(r.status).toBe(200)
      expect(r.body).toContain('risposta-del-server-locale')
    } finally {
      if (prev === undefined) delete process.env[LOOPBACK_FLAG]
      else process.env[LOOPBACK_FLAG] = prev
    }
  })

  it('un client FUORI dalla sottorete del box: la connessione si chiude SUBITO, senza risposta', async () => {
    // il secondo ascolto dichiara la sottorete del box (192.0.15.0/24): il
    // client del test (127.0.0.1) è FUORI → distrutto. La richiesta, se il
    // filtro fosse rotto, riceverebbe un 403 dal proxy stesso (destinazione
    // loopback SENZA flag di test): nessuna rete esterna in ogni caso
    const info = await ensureBrowserProxyGateway('127.0.0.1', '192.0.15.0/24')
    const closed = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port: info.port, host: '127.0.0.1' })
      socket.on('connect', () => { socket.write(`GET http://127.0.0.1:${webPort}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`) })
      socket.on('data', () => resolve(false)) // arrivata una risposta: NON è stato chiuso
      socket.on('error', () => resolve(true)) // ECONNRESET: chiuso dal server
      socket.on('close', () => resolve(true))
      setTimeout(() => resolve(false), 2_000).unref?.()
    })
    expect(closed, 'la connessione fuori sottorete va chiusa senza rispondere').toBe(true)
  })

  it('il gateway CAMBIA (rete ricreata): il vecchio ascolto si chiude, se ne apre uno nuovo', async () => {
    const primo = await ensureBrowserProxyGateway('127.0.0.1', '127.0.0.0/8')
    // l'altro «gateway» del test: ::1 — ascolto nuovo al posto del vecchio
    const secondo = await ensureBrowserProxyGateway('::1', '127.0.0.0/8')
    expect(secondo.host).toBe('::1')
    expect(secondo.port).toBeGreaterThan(0)
    // il VECCHIO indirizzo non serve più: nessuna risposta da lì (se fosse
    // ancora aperto risponderebbe 403 alla richiesta loopback senza flag)
    const vecchioChiuso = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port: primo.port, host: '127.0.0.1' })
      socket.on('connect', () => { socket.write(`GET http://127.0.0.1:${webPort}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`) })
      socket.on('data', () => resolve(false)) // risponde ancora: NON è chiuso
      socket.on('error', () => resolve(true)) // ECONNREFUSED: il vecchio ascolto è ANDATO
      socket.on('close', () => resolve(true))
      setTimeout(() => resolve(false), 2_000).unref?.()
    })
    expect(vecchioChiuso).toBe(true)
  })

  it('EADDRNOTAVAIL (il gateway non c\'è ancora): poche prove con pausa crescente, poi il log e l\'errore in parole', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // 192.0.51.1 non è di questa macchina: l'ascolto cade in EADDRNOTAVAIL
      await expect(
        ensureBrowserProxyGateway('192.0.51.1', '192.0.51.0/24', { attempts: 2, baseDelayMs: 1 })
      ).rejects.toThrow(BROWSER_PROXY_GATEWAY_FAILED_MESSAGE)
      expect(err).toHaveBeenCalledWith(expect.stringContaining('192.0.51.1'))
    } finally {
      err.mockRestore()
    }
  })
})
