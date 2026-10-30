// Server di redirect di loopback per l'OAuth dei connettori (fase 5, RFC 8252:
// le app native usano http://127.0.0.1:<porta>/callback come redirect). Sta su
// al massimo 10 minuti, accetta UN solo codice di autorizzazione e verifica
// lo `state` generato dal provider: una richiesta con state sbagliato viene
// rifiutata SENZA consumare il codice (attesa di quella giusta).
import { createServer, type Server } from 'node:http'

export interface CallbackServer {
  port: number
  /** URL da registrare come redirect_uri (http://127.0.0.1:<porta>/callback). */
  url: string
  /**
   * Risolve col codice valido; rifiuta allo scadere dei 10 minuti. Fase 13
   * (punto 6): porta anche l'eventuale parametro iss della redirect (RFC
   * 9207) — chi riscatta il codice lo confronta con l'issuer scoperto.
   */
  waitForCode(): Promise<{ code: string; iss?: string }>
  close(): void
}

const PAGE_OK = '<html><body style="font-family:system-ui;background:#0b0d10;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh"><p>✓ Connettore autorizzato — puoi tornare su Homun.</p></body></html>'
const PAGE_ERR = '<html><body style="font-family:system-ui;background:#0b0d10;color:#f87171;display:flex;align-items:center;justify-content:center;height:100vh"><p>Richiesta non valida (state errato): riprova la connessione da Homun.</p></body></html>'

export async function startCallbackServer(opts: {
  expectedState: string
  timeoutMs?: number
  host?: string
}): Promise<CallbackServer> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  let settled = false
  let resolveCode: ((v: { code: string; iss?: string }) => void) | null = null
  let rejectCode: ((e: Error) => void) | null = null
  const waiter = new Promise<{ code: string; iss?: string }>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const err = url.searchParams.get('error')
    if (!code || state !== opts.expectedState) {
      // state sbagliato o manca il codice: rifiutata, il codice "unico" non si consuma
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE_ERR)
      if (err && !settled) {
        settled = true
        rejectCode?.(new Error(`autorizzazione negata: ${err}`))
      }
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE_OK)
    if (!settled) {
      settled = true
      // fase 13 (punto 6): iss della redirect (RFC 9207), se il server lo manda
      resolveCode?.({ code, ...(url.searchParams.get('iss') ? { iss: url.searchParams.get('iss')! } : {}) })
    }
  })

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true
      rejectCode?.(new Error(`autorizzazione non completata entro ${Math.round(timeoutMs / 60_000)} minuti`))
    }
  }, timeoutMs)
  timer.unref()

  server.listen(0, opts.host ?? '127.0.0.1')
  // si attende il listener: prima di quel momento address() è null
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const close = (): void => {
    clearTimeout(timer)
    server.closeAllConnections?.()
    server.close()
  }

  return {
    port,
    url: `http://${opts.host ?? '127.0.0.1'}:${port}/callback`,
    waitForCode: () => waiter,
    close
  }
}
