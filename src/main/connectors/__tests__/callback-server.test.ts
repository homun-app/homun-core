// Test del callback server di loopback (fase 5, RFC 8252): accetta UN solo
// codice, verifica lo state (una richiesta con state sbagliato non consuma
// il codice) e scade dopo il timeout.
import { describe, expect, it } from 'vitest'
import { startCallbackServer } from '../callback-server'

describe('callback server di loopback', () => {
  it('code + state giusti → risolve una volta sola; path diverso → 404', async () => {
    const cb = await startCallbackServer({ expectedState: 'st123' })
    expect(cb.url).toBe(`http://127.0.0.1:${cb.port}/callback`)
    const good = await fetch(cb.url + '?code=c1&state=st123')
    expect(good.status).toBe(200)
    await expect(cb.waitForCode()).resolves.toEqual({ code: 'c1' })
    // dopo il primo codice la pagina risponde, il codice "unico" è già stato preso
    const again = await fetch(cb.url + '?code=c2&state=st123')
    expect(again.status).toBe(200)
    const other = await fetch(`http://127.0.0.1:${cb.port}/altro`)
    expect(other.status).toBe(404)
    cb.close()
  })

  it('state sbagliato → 400 e il codice NON viene consumato', async () => {
    const cb = await startCallbackServer({ expectedState: 'giusto' })
    const bad = await fetch(cb.url + '?code=evil&state=sbagliato')
    expect(bad.status).toBe(400)
    // l'attesa è ancora aperta: il codice buono arriva dopo
    const good = await fetch(cb.url + '?code=ok&state=giusto')
    expect(good.status).toBe(200)
    await expect(cb.waitForCode()).resolves.toEqual({ code: 'ok' })
    cb.close()
  })

  it('senza codice → 400; allo scadere del timeout waitForCode rifiuta', async () => {
    const cb = await startCallbackServer({ expectedState: 's', timeoutMs: 150 })
    const noCode = await fetch(cb.url + '?state=s')
    expect(noCode.status).toBe(400)
    await expect(cb.waitForCode()).rejects.toThrow(/autorizzazione non completata/i)
    cb.close()
  })
})
