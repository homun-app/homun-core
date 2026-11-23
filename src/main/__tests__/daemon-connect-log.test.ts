// P1 (fase primo-avvio): le connessioni del client al daemon nel registro
// del ciclo di vita — daemon-connect-start, daemon-connected ms=… oppure
// daemon-connect-failed reason=… — così dal registro si vede se (e quando)
// la UI ha cominciato a parlare col daemon. Client e socket FINTI come in
// daemon-client.test.ts: nessuna socket reale, nessun processo. Il tempo è
// quello dei timer finti (un solo orologio: ms dal boot e durata del tentativo).
import { describe, expect, it, vi, afterEach } from 'vitest'
import { DaemonClient, type WsLike } from '../daemon-client'
import { serializeHelloOk } from '../../daemon/rpc'
import type { DaemonInfo } from '../../daemon/daemon-files'
import type { LifecycleLine } from '../lifecycle-log'

type WsOpts = { onText: (t: string) => void; onClose: () => void }

/** Connessione ws finta: connect ok, l'hello riceve subito la risposta del daemon. */
class FakeWs implements WsLike {
  isConnected = false
  constructor(
    private readonly opts: WsOpts,
    private readonly tokenOk: () => boolean
  ) {}
  async connect(): Promise<void> { this.isConnected = true }
  send(text: string): void {
    if (text.includes('"hello"')) this.opts.onText(serializeHelloOk(this.tokenOk()))
  }
  close(): void {
    this.isConnected = false
    this.opts.onClose()
  }
}

/** Una ws che si collega ma non risponde MAI all'hello (vince il timeout dell'hello). */
class SilentWs implements WsLike {
  isConnected = false
  connect(): Promise<void> { this.isConnected = true; return Promise.resolve() }
  send(): void {}
  close(): void { this.isConnected = false }
}

const INFO: DaemonInfo = { pid: 4242, port: 12345, token: 'tok', startedAt: 1 }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Il registro finto: righe «evento k=v»; i ms sono dall'avvio (orologio dei timer finti). */
function fakeLog(): { lines: string[]; log: LifecycleLine } {
  const lines: string[] = []
  const t0 = Date.now()
  return {
    lines,
    log: {
      line: (event, fields = {}) => {
        lines.push([event, ...Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ')}`)].join(' '))
      },
      sinceBoot: () => Date.now() - t0
    }
  }
}

afterEach(() => { vi.useRealTimers() })

describe('P1: DaemonClient — le connessioni al daemon nel registro', () => {
  it('connessione riuscita: daemon-connect-start, poi daemon-connected con i ms dall\'avvio e la durata del tentativo', async () => {
    vi.useFakeTimers()
    const net = fakeLog()
    const client = new DaemonClient({
      makeWs: (opts) => new FakeWs(opts, () => true),
      // il daemon impiega 300 ms a diventare pronto
      ensure: async () => { await sleep(300); return INFO },
      log: net.log
    })
    const p = client.start()
    expect(net.lines, 'la start si scrive SUBITO, prima di aspettare il daemon').toEqual(['daemon-connect-start ms=0'])
    await vi.advanceTimersByTimeAsync(299)
    expect(net.lines).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(net.lines).toEqual(['daemon-connect-start ms=0', 'daemon-connected ms=300 took=300'])
    client.stop()
  })

  it('token rifiutato: daemon-connect-failed con il motivo; il tentativo dopo (2 s) si collega', async () => {
    vi.useFakeTimers()
    const net = fakeLog()
    let ok = false
    const client = new DaemonClient({
      makeWs: (opts) => new FakeWs(opts, () => ok),
      ensure: async () => INFO,
      log: net.log
    })
    const p = client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(net.lines).toEqual([
      'daemon-connect-start ms=0',
      'daemon-connect-failed ms=0 took=0 reason=token rifiutato dal daemon'
    ])
    ok = true
    await vi.advanceTimersByTimeAsync(2000)
    await p
    expect(net.lines.slice(2)).toEqual(['daemon-connect-start ms=2000', 'daemon-connected ms=2000 took=0'])
    client.stop()
  })

  it('il daemon che non risponde all\'hello: failed col motivo dopo 15 s, poi un tentativo nuovo', async () => {
    vi.useFakeTimers()
    const net = fakeLog()
    const client = new DaemonClient({ makeWs: () => new SilentWs(), ensure: async () => INFO, log: net.log })
    void client.start().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(net.lines).toEqual([
      'daemon-connect-start ms=0',
      'daemon-connect-failed ms=15000 took=15000 reason=daemon handshake timed out'
    ])
    await vi.advanceTimersByTimeAsync(2000)
    expect(net.lines[2]).toBe('daemon-connect-start ms=17000')
    client.stop()
  })

  it('il daemon che non parte (ensure fallisce): failed col suo motivo, mai un\'eccezione fuori dal client', async () => {
    vi.useFakeTimers()
    const net = fakeLog()
    const client = new DaemonClient({
      makeWs: (opts) => new FakeWs(opts, () => true),
      ensure: async () => { await sleep(500); throw new Error('il daemon non ha scritto daemon.json entro il timeout (vedi data/daemon.log)') },
      log: net.log
    })
    void client.start().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(500)
    expect(net.lines).toEqual([
      'daemon-connect-start ms=0',
      'daemon-connect-failed ms=500 took=500 reason=il daemon non ha scritto daemon.json entro il timeout (vedi data/daemon.log)'
    ])
    client.stop()
  })

  it('alla RICONNESSIONE (la connessione cade) le righe si ripetono: una start e una connected in più', async () => {
    vi.useFakeTimers()
    const net = fakeLog()
    const sockets: FakeWs[] = []
    const client = new DaemonClient({
      makeWs: (opts) => {
        const ws = new FakeWs(opts, () => true)
        sockets.push(ws)
        return ws
      },
      ensure: async () => INFO,
      log: net.log
    })
    await client.start()
    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(2000)
    expect(net.lines).toEqual([
      'daemon-connect-start ms=0',
      'daemon-connected ms=0 took=0',
      'daemon-connect-start ms=2000',
      'daemon-connected ms=2000 took=0'
    ])
    client.stop()
  })

  it('un motivo con accapo va in UNA riga (gli spazi si appiattiscono, come nel registro vero)', async () => {
    vi.useFakeTimers()
    const net = fakeLog()
    const client = new DaemonClient({
      makeWs: (opts) => new FakeWs(opts, () => true),
      ensure: async () => { throw new Error('riga uno\nriga due') },
      log: net.log
    })
    void client.start().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(net.lines[1]).toBe('daemon-connect-failed ms=0 took=0 reason=riga uno riga due')
    client.stop()
  })

  it('senza il registro (deps senza log) il client funziona come prima', async () => {
    vi.useFakeTimers()
    const client = new DaemonClient({ makeWs: (opts) => new FakeWs(opts, () => true), ensure: async () => INFO })
    await expect(client.start()).resolves.toBeUndefined()
    client.stop()
  })
})
