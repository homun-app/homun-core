// W2 (fase avvio-finestra): dopo un aggiornamento il daemon vecchio si ferma
// (fino a 10 s per chiudere i turni) e ne parte uno nuovo — nel frattempo la
// finestra restava sul caricamento SENZA una parola. Qui lo stato che il main
// offre al renderer (boot:status / boot:retry): la riga «aggiornamento» quando
// il riavvio è per VERSIONE, e «Riprova» che rifà la connessione (se il daemon
// non c'è, ensureDaemonRunning lo riavvia col percorso di oggi).
import { describe, expect, it, vi } from 'vitest'
import { BootStatusTracker } from '../boot-status'

function makeClient(connected = false) {
  const start = vi.fn(async () => undefined)
  return { get connected() { return connected }, start, setConnected(v: boolean) { connected = v } }
}

describe('W2: lo stato del caricamento mentre il daemon si avvia', () => {
  it('avvio normale: connesso appena il client risponde, nessun riavvio per aggiornamento', () => {
    const t = new BootStatusTracker(makeClient(false))
    expect(t.status()).toEqual({ connected: false, restartingForUpdate: false })
  })

  it('il client vede il riavvio per VERSIONE → restartingForUpdate (lo splash passa a «aggiornamento»)', () => {
    const client = makeClient(false)
    const t = new BootStatusTracker(client)
    t.handleRestart('update')
    expect(t.status(), 'il riavvio per versione è un aggiornamento').toEqual({ connected: false, restartingForUpdate: true })
  })

  it('anche il daemon VECCHIO stile (fase ≤16c) è un aggiornamento; il solo PERCORSO diverso no', () => {
    const t = new BootStatusTracker(makeClient(false))
    t.handleRestart('legacy')
    expect(t.status().restartingForUpdate).toBe(true)
    const t2 = new BootStatusTracker(makeClient(false))
    t2.handleRestart('path')
    expect(t2.status().restartingForUpdate, 'copia diversa dello stesso bundle: non è «la versione nuova»').toBe(false)
  })

  it('connesso → il flag si spegne (il caricamento è finito, niente riga di aggiornamento)', () => {
    const client = makeClient(false)
    const t = new BootStatusTracker(client)
    t.handleRestart('update')
    client.setConnected(true)
    expect(t.status()).toEqual({ connected: true, restartingForUpdate: false })
    client.setConnected(false)
    expect(t.status(), 'e non torna nemmeno se la connessione riparte').toEqual({ connected: false, restartingForUpdate: false })
  })

  it('«Riprova» con il daemon non connesso rifà la connessione (client.start → riavvia se non c\'è)', async () => {
    const client = makeClient(false)
    const t = new BootStatusTracker(client)
    const r = await t.retry()
    expect(r).toEqual({ ok: true, restarted: true })
    expect(client.start).toHaveBeenCalledTimes(1)
  })

  it('«Riprova» già connesso non chiama start', async () => {
    const client = makeClient(true)
    const t = new BootStatusTracker(client)
    const r = await t.retry()
    expect(r).toEqual({ ok: true, restarted: false })
    expect(client.start).not.toHaveBeenCalled()
  })
})
