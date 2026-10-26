// Residuo fase 4 (0b): alla RICONNESSIONE del client WebSocket il daemon
// dispatcha l'evento 'reconnected' (la UI ricarica agenti ed entry); alla
// PRIMA connessione nessun evento. Client ws e spawn del daemon finti:
// nessuna socket reale, nessun processo.
import { describe, expect, it, afterEach } from 'vitest'
import { vi } from 'vitest'
import { DaemonClient, type WsLike } from '../daemon-client'
import { serializeHelloOk } from '../../daemon/rpc'
import type { DaemonInfo } from '../../daemon/daemon-files'

/** Connessione ws finta: connect ok, l'hello riceve subito la risposta del daemon. */
class FakeWs implements WsLike {
  isConnected = false
  constructor(private readonly opts: { onText: (t: string) => void; onClose: () => void }) {}
  async connect(): Promise<void> { this.isConnected = true }
  send(text: string): void {
    if (text.includes('"hello"')) this.opts.onText(serializeHelloOk(true))
  }
  close(): void {
    this.isConnected = false
    this.opts.onClose()
  }
  /** La connessione cade (daemon riavviato / rete giù). */
  drop(): void {
    this.isConnected = false
    this.opts.onClose()
  }
}

function makeFakeNet() {
  const sockets: FakeWs[] = []
  const info: DaemonInfo = { pid: 4242, port: 12345, token: 'tok', startedAt: 1 }
  const ensure = vi.fn(async () => info)
  const makeWs = (opts: { onText: (t: string) => void; onClose: () => void }): WsLike => {
    const ws = new FakeWs(opts)
    sockets.push(ws)
    return ws
  }
  return { sockets, ensure, makeWs }
}

afterEach(() => { vi.useRealTimers() })

describe('residuo 0b: riconnessione della UI', () => {
  it('prima connessione silenziosa; alla RICONNESSIONE parte l’evento reconnected', async () => {
    vi.useFakeTimers()
    const net = makeFakeNet()
    const client = new DaemonClient({ makeWs: net.makeWs, ensure: net.ensure })
    const events: string[] = []
    client.onEvent((e) => events.push(e.type))

    await client.start()
    expect(events).toEqual([]) // prima connessione: nessun evento
    expect(net.ensure).toHaveBeenCalledTimes(1)
    expect(net.sockets).toHaveLength(1)

    // la connessione cade → riconnessione automatica → evento alla UI
    net.sockets[0]!.drop()
    await vi.advanceTimersByTimeAsync(2100)
    expect(events).toEqual(['reconnected'])
    expect(net.ensure).toHaveBeenCalledTimes(2)
    expect(net.sockets).toHaveLength(2)

    // cade di nuovo → un altro evento (uno per riconnessione)
    net.sockets[1]!.drop()
    await vi.advanceTimersByTimeAsync(2100)
    expect(events).toEqual(['reconnected', 'reconnected'])
    client.stop()
  })

  it('con il client fermato (stop) non ci sono riconnessioni né eventi', async () => {
    vi.useFakeTimers()
    const net = makeFakeNet()
    const client = new DaemonClient({ makeWs: net.makeWs, ensure: net.ensure })
    const events: string[] = []
    client.onEvent((e) => events.push(e.type))
    await client.start()
    client.stop()
    net.sockets[0]!.drop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(events).toEqual([])
    expect(net.sockets).toHaveLength(1)
  })
})
