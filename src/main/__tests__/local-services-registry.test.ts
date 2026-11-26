// I1 (fase isolamento-locale): IL REGISTRO delle connessioni verso i servizi
// LLM locali VERI del Mac. In prova (SANDBOT_TEST_USER_DATA) l'app non deve
// toccarli — i servizi locali sono finti o assenti — e questo è il controllo
// che lo prende da solo. Qui si prova che:
//   · nell'app vera non installi nulla (fetch e socket.connect restano quelli di Node);
//   · registri OGNI connessione che parte verso quelle porte di questa macchina,
//     dal fetch (con l'URL) e dal socket nudo, APPENA PARTE — anche se nessuno
//     ascolta: il rosso non dipende dal fatto che il servizio vero risponda;
//   · scriva la riga nel registro (nella cartella dati di prova), con la scena.
// Le porte sorvegliate nei test sono porte LIBERE di 127.0.0.1 (porta 0): le
// vere non si toccano nemmeno qui, i loro numeri si leggono da KNOWN_BASE_URLS.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import net from 'node:net'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_TMP_BASE } from '../../test-tmp'
import {
  NOME_REGISTRO_LOCALI, PORTE_SERVIZI_LOCALI_VERI,
  destinazioneSocket, eServizioLocaleVero, eUrlServizioLocaleVero,
  installaRegistroServiziLocali, type RegistroServiziLocali
} from '../local-services-registry'
import { KNOWN_BASE_URLS } from '../agent/live-models'

const portaDi = (url: string | undefined): number => Number(new URL(url ?? 'http://host-senza-porta').port)
const PORTA_OLLAMA = portaDi(KNOWN_BASE_URLS.ollama)
const PORTA_LMSTUDIO = portaDi(KNOWN_BASE_URLS.lmstudio)

/** Un server qualsiasi su 127.0.0.1, porta scelta dal sistema: la «porta sorvegliata» dei test con la rete. */
const serverFinto = async (): Promise<{ porta: number; chiudi: () => Promise<void> }> => {
  const srv = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const indirizzo = srv.address()
  if (indirizzo === null || typeof indirizzo === 'string') throw new Error('il server finto non ha una porta')
  return { porta: indirizzo.port, chiudi: () => new Promise<void>((r) => srv.close(() => r())) }
}

describe('I1: il registro delle connessioni verso i servizi LLM locali veri', () => {
  let dir: string
  let registro: RegistroServiziLocali | null = null
  const righe: string[] = []
  beforeEach(() => {
    dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-i1-registro-'))
    righe.length = 0
  })
  afterEach(() => {
    registro?.disinstalla()
    registro = null
    rmSync(dir, { recursive: true, force: true })
  })
  const installa = (porte: ReadonlySet<number>, extra: Record<string, string> = {}) => {
    registro = installaRegistroServiziLocali({ env: { SANDBOT_TEST_USER_DATA: dir, ...extra }, modo: 'daemon', porte, stderr: (r) => righe.push(r) })
    return registro
  }

  it('le porte sorvegliate sono quelle dei due servizi locali noti (Ollama e LM Studio), e sono due diverse', () => {
    expect([...PORTE_SERVIZI_LOCALI_VERI].sort((a, b) => a - b)).toEqual([PORTA_OLLAMA, PORTA_LMSTUDIO].sort((a, b) => a - b))
    expect(PORTA_OLLAMA).toBeGreaterThan(0)
    expect(PORTA_LMSTUDIO).toBeGreaterThan(0)
    expect(PORTA_OLLAMA).not.toBe(PORTA_LMSTUDIO)
  })

  it('una connessione è verso un servizio locale vero solo per quelle porte E solo su questa macchina', () => {
    expect(eServizioLocaleVero('localhost', PORTA_OLLAMA)).toBe(true)
    expect(eServizioLocaleVero('127.0.0.1', PORTA_OLLAMA)).toBe(true)
    expect(eServizioLocaleVero('127.0.0.2', PORTA_LMSTUDIO)).toBe(true)
    expect(eServizioLocaleVero('::1', PORTA_OLLAMA)).toBe(true)
    expect(eServizioLocaleVero('[::1]', PORTA_OLLAMA)).toBe(true)
    // la stessa porta su un altro host non è affare della prova
    expect(eServizioLocaleVero('192.168.1.4', PORTA_OLLAMA)).toBe(false)
    expect(eServizioLocaleVero('esempio.it', PORTA_OLLAMA)).toBe(false)
    // un'altra porta su questa macchina è il servizio FINTO iniettato: non si registra
    expect(eServizioLocaleVero('127.0.0.1', PORTA_OLLAMA + 1)).toBe(false)
    expect(eServizioLocaleVero('127.0.0.1', 0)).toBe(false)
  })

  it('un URL è di un servizio locale vero per http e https su quelle porte; il resto no', () => {
    expect(eUrlServizioLocaleVero(`${KNOWN_BASE_URLS.ollama}/api/tags`)).toBe(true)
    expect(eUrlServizioLocaleVero(`http://127.0.0.1:${PORTA_LMSTUDIO}/v1/models`)).toBe(true)
    expect(eUrlServizioLocaleVero(`https://[::1]:${PORTA_OLLAMA}/api/show`)).toBe(true)
    expect(eUrlServizioLocaleVero('http://127.0.0.1:1/api/tags')).toBe(false)
    expect(eUrlServizioLocaleVero('https://api.openai.com/v1/models')).toBe(false)
    expect(eUrlServizioLocaleVero('homun://app/index.html')).toBe(false)
    expect(eUrlServizioLocaleVero('non è un url')).toBe(false)
  })

  it('destinazioneSocket legge le forme di connect di Node (porta+host, oggetto, porta come stringa) e non le connessioni di dominio', () => {
    expect(destinazioneSocket([4321, '127.0.0.1'])).toEqual({ host: '127.0.0.1', porta: 4321 })
    expect(destinazioneSocket([4321])).toEqual({ host: 'localhost', porta: 4321 })
    expect(destinazioneSocket(['4321', '::1'])).toEqual({ host: '::1', porta: 4321 })
    expect(destinazioneSocket([{ port: 4321, host: '127.0.0.1' }])).toEqual({ host: '127.0.0.1', porta: 4321 })
    expect(destinazioneSocket([{ port: '4321' }, () => undefined])).toEqual({ host: 'localhost', porta: 4321 })
    expect(destinazioneSocket([{ host: '::1' }, 4321])).toEqual({ host: '::1', porta: 4321 })
    // la forma con cui net.connect arriva a socket.connect (misurata su Node 24): l'elenco normalizzato [opzioni, ascoltatore] — la prima versione del registro non lo apriva e non registrava nulla
    expect(destinazioneSocket([[{ port: 4321, host: '127.0.0.1' }, () => undefined]])).toEqual({ host: '127.0.0.1', porta: 4321 })
    expect(destinazioneSocket([[{ port: 4321 }, () => undefined]])).toEqual({ host: 'localhost', porta: 4321 })
    expect(destinazioneSocket([[{ path: '/socket/compito.sock' }, () => undefined]])).toBeNull()
    expect(destinazioneSocket([{ path: '/socket/compito.sock' }])).toBeNull()
    expect(destinazioneSocket(['/socket/compito.sock'])).toBeNull()
    expect(destinazioneSocket([])).toBeNull()
  })

  it("nell'app vera (senza SANDBOT_TEST_USER_DATA) non installa nulla: fetch e socket.connect restano quelli di Node", () => {
    const fetchPrima = globalThis.fetch
    const connettiPrima = net.Socket.prototype.connect
    expect(installaRegistroServiziLocali({ env: {}, modo: 'ui', stderr: (r) => righe.push(r) })).toBeNull()
    // SANDBOT_DATA_DIR da sola non basta: è la variabile delle prove impacchettate, non di una corsa di prova
    expect(installaRegistroServiziLocali({ env: { SANDBOT_DATA_DIR: dir }, modo: 'daemon', stderr: (r) => righe.push(r) })).toBeNull()
    expect(globalThis.fetch).toBe(fetchPrima)
    expect(net.Socket.prototype.connect).toBe(connettiPrima)
  })

  it('in prova registra la connessione di una fetch verso la porta sorvegliata, con l\'URL, e scrive la riga nel registro della cartella dati', async () => {
    const srv = await serverFinto()
    try {
      const r = installa(new Set([srv.porta]))
      expect(r).not.toBeNull()
      const res = await fetch(`http://127.0.0.1:${srv.porta}/api/tags`)
      expect(res.status).toBe(200)
      const tentativi = r!.tentativi()
      expect(tentativi).toHaveLength(1)
      expect(tentativi[0]).toMatchObject({ modo: 'daemon', via: 'fetch', host: '127.0.0.1', porta: srv.porta, url: `http://127.0.0.1:${srv.porta}/api/tags`, scena: null })
      expect(typeof tentativi[0].t).toBe('string')
      expect(tentativi[0].pid).toBe(process.pid)
      // la riga sta nel registro, dentro la cartella dati della prova: la sonda la legge anche dopo
      const file = join(dir, NOME_REGISTRO_LOCALI)
      expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(tentativi[0]) + '\n')
      expect(righe.filter((x) => x.startsWith('[servizi-locali] '))).toHaveLength(1)
    } finally {
      await srv.chiudi()
    }
  })

  it('registra un socket nudo (net.connect) senza URL', async () => {
    const srv = await serverFinto()
    try {
      const r = installa(new Set([srv.porta]))
      const sock = net.connect({ port: srv.porta, host: '127.0.0.1' })
      await once(sock, 'connect')
      sock.destroy()
      expect(r!.tentativi()).toMatchObject([{ via: 'socket', host: '127.0.0.1', porta: srv.porta, url: null }])
    } finally {
      await srv.chiudi()
    }
  })

  it('registra la connessione APPENA PARTE: anche se nessuno ascolta (il rosso non dipende dal servizio vero)', async () => {
    const libera = await serverFinto()
    const porta = libera.porta
    await libera.chiudi()
    const r = installa(new Set([porta]))
    await expect(fetch(`http://127.0.0.1:${porta}/api/tags`)).rejects.toThrow()
    expect(r!.tentativi()).toMatchObject([{ via: 'fetch', porta, url: `http://127.0.0.1:${porta}/api/tags` }])
  })

  it('una porta che non è dei servizi locali veri non si registra (è il servizio FINTO iniettato)', async () => {
    const srv = await serverFinto()
    try {
      const r = installa(new Set([srv.porta + 1]))
      const res = await fetch(`http://127.0.0.1:${srv.porta}/models`)
      expect(res.status).toBe(200)
      expect(r!.tentativi()).toEqual([])
      expect(righe).toEqual([])
    } finally {
      await srv.chiudi()
    }
  })

  it('la scena si legge dal file al momento del tentativo (due tentativi, due scene)', async () => {
    const srv = await serverFinto()
    try {
      const fileScena = join(dir, 'scena-corrente.txt')
      writeFileSync(fileScena, 'impostazioni-modelli 1280/chiaro')
      const r = installa(new Set([srv.porta]), { SANDBOT_TEST_LOCAL_LLM_SCENE: fileScena })
      await fetch(`http://127.0.0.1:${srv.porta}/api/tags`)
      writeFileSync(fileScena, 'guida 1280/scuro')
      await fetch(`http://127.0.0.1:${srv.porta}/api/tags`)
      expect(r!.tentativi().map((t) => t.scena)).toEqual(['impostazioni-modelli 1280/chiaro', 'guida 1280/scuro'])
    } finally {
      await srv.chiudi()
    }
  })

  it('il registro va dove dice SANDBOT_TEST_LOCAL_LLM_LOG, e disinstalla rimette fetch e socket.connect come erano', async () => {
    const srv = await serverFinto()
    try {
      const fetchPrima = globalThis.fetch
      const connettiPrima = net.Socket.prototype.connect
      const altro = join(dir, 'altrove', 'registro.jsonl')
      mkdirSync(join(dir, 'altrove'))
      const r = installaRegistroServiziLocali({ env: { SANDBOT_TEST_USER_DATA: dir, SANDBOT_TEST_LOCAL_LLM_LOG: altro }, modo: 'ui', porte: new Set([srv.porta]), stderr: (x) => righe.push(x) })
      expect(r).not.toBeNull()
      expect(globalThis.fetch).not.toBe(fetchPrima)
      expect(net.Socket.prototype.connect).not.toBe(connettiPrima)
      await fetch(`http://127.0.0.1:${srv.porta}/api/tags`)
      expect(readFileSync(altro, 'utf8').split('\n').filter(Boolean)).toHaveLength(1)
      expect(r!.tentativi()[0].modo).toBe('ui')
      r!.disinstalla()
      expect(globalThis.fetch).toBe(fetchPrima)
      expect(net.Socket.prototype.connect).toBe(connettiPrima)
    } finally {
      await srv.chiudi()
    }
  })

  it('il main e il daemon lo installano all\'avvio (guardia sul sorgente): UI e daemon sono lo stesso eseguibile, la via legacy del daemon pure', () => {
    const main = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    expect(main).toMatch(/void installaRegistroServiziLocali\(\{ env: process\.env, modo: isDaemonMode\(process\.argv\) \? 'daemon' : 'ui' \}\)/)
    // PRIMA di ogni altra cosa che parte: subito dopo la guardia dello stdio, prima di app.setPath('userData'…)
    expect(main.indexOf('installaRegistroServiziLocali({ env: process.env')).toBeLessThan(main.indexOf("app.setPath('userData'"))
    const daemon = readFileSync(fileURLToPath(new URL('../../daemon/index.ts', import.meta.url)), 'utf8')
    expect(daemon).toMatch(/void installaRegistroServiziLocali\(\{ env: process\.env, modo: 'daemon' \}\)/)
  })
})
