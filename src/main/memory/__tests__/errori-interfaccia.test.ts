// Fase memoria-engramma v0.6.19 (E3): gli errori del motore, detti bene.
// Dalla v0.6.19 i messaggi di Engramma sono in inglese («no such note in this
// cell», «the cell's schema is newer than this binary…», «pull: embedding
// endpoint error: https://… io: Connection refused»): l'utente non li vede
// mai così. Ogni punto in cui un errore del motore arriva all'interfaccia
// passa dal suo e.code a una frase del catalogo UI (src/shared/ui-messages.ts:
// italiano fonte, inglese nel catalogo en), nella lingua dell'interfaccia —
// come fa memory-store.ts per CONFLICT, NOT_FOUND e INVALID_NOTE verso il
// modello, che invece riceve l'inglese e non cambia.
//
// I punti sono due, tutti in memory-rpc.ts (l'interfaccia della memoria):
//   - le RPC memory:* del demone (memorySave, memoryConfirm, memoryRestore,
//     …): l'errore che esce è la frase, non e.message;
//   - il download del modello (startModelPull → memory-rpc → api.ts →
//     MemoryPanel): l'evento porta la frase.
// Il download qui NON va in rete: ENGRAMMA_PULL_BASE punta a una porta
// chiusa di 127.0.0.1 (letto dal motore alla chiamata) e i proxy anche.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

// prima che il motore si carichi (lo caricano i test, con import dinamico)
process.env.ENGRAMMA_PULL_BASE = 'http://127.0.0.1:9/'
for (const k of ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) process.env[k] = 'http://127.0.0.1:9'
process.env.NO_PROXY = ''
/**
 * Quel env è quello VERO del processo solo se il test gira in un processo
 * figlio (pool «forks» di vitest: canale IPC, quindi process.send). In un
 * worker thread l'env di process.env è una copia che il motore non legge, e
 * il download andrebbe verso l'endpoint vero: lì il download non si prova.
 */
const envVisibileAlMotore = typeof process.send === 'function'

const ROOT = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-mem-errori-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
beforeAll(async () => {
  const { setDataDir } = await import('../../store/db')
  setDataDir(join(ROOT, 'db'))
})

/** Il motore aperto su una cartella nuova, con la lingua dell'interfaccia scelta. */
async function fresh(lingua: 'it' | 'en'): Promise<void> {
  const { setSetting } = await import('../../store/db')
  const e = await import('../engine')
  await e.closeMemoryEngine()
  setSetting('ui.activeLanguage', lingua)
  expect((await e.openMemoryEngine({ dataDir: join(ROOT, 'd' + Math.random().toString(36).slice(2, 8)) })).available).toBe(true)
}

describe('E3: gli errori del motore arrivano all’interfaccia come frasi del catalogo', () => {
  const A = 'agent_err3'

  it('le RPC memory:* non lasciano passare il messaggio inglese: dal code alla frase, in italiano', async () => {
    await fresh('it')
    const rpc = await import('../memory-rpc')
    const { writeMemoryNote } = await import('../memory-store')
    const viva = await writeMemoryNote(A, { content: 'Nota viva.', tier: 'log', source: 'homun:chat/x/1', userTurn: true })
    const lapide = await writeMemoryNote(A, { content: 'Da eliminare.', tier: 'log', source: 'homun:chat/x/2', userTurn: true })
    await rpc.memoryDelete(A, lapide.id)

    // NOT_FOUND
    await expect(rpc.memoryNote(A, 'ZZZZZZZZ')).rejects.toThrow('Questa memoria non c’è più: l’elenco si è aggiornato.')
    // CONFLICT: la lapide
    await expect(rpc.memorySave(A, { id: lapide.id, body: 'Cambio il testo.', tier: 'log' })).rejects.toThrow('Questa memoria è stata eliminata: ripristinala dalle eliminate prima di cambiarla.')
    // il vuoto e lo scarto di una nota che non aspetta: controlli dell’interfaccia
    await expect(rpc.memorySave(A, { id: viva.id, body: '   ', tier: 'log' })).rejects.toThrow('La memoria è vuota: non ho salvato nulla.')
    await expect(rpc.memoryDiscard(A, viva.id)).rejects.toThrow('Questa memoria non è più in attesa di conferma.')
    // l'id non valido
    await expect(rpc.memoryNote(A, '../evil')).rejects.toThrow('Questa modifica non è valida: ricarica e riprova.')
    // dimenticata per sempre: non torna
    await rpc.memoryPurge(A, lapide.id)
    await expect(rpc.memoryRestore(A, lapide.id)).rejects.toThrow('Questa memoria non c’è più: l’elenco si è aggiornato.')
    // CLOSED: il motore chiuso (spegnimento)
    await (await import('../engine')).closeMemoryEngine()
    await expect(rpc.memoryList(A)).rejects.toThrow('Il motore della memoria è chiuso: riavvia Homun.')
    await expect(rpc.memorySave(A, { body: 'Nuova.', tier: 'log' })).rejects.toThrow('Il motore della memoria è chiuso: riavvia Homun.')
    await expect(rpc.memorySearch(A, 'nota')).rejects.toThrow('Il motore della memoria è chiuso: riavvia Homun.')
  })

  it('nella lingua dell’interfaccia: le stesse frasi in inglese quando l’interfaccia è in inglese', async () => {
    await fresh('en')
    const rpc = await import('../memory-rpc')
    await expect(rpc.memoryNote(A, 'ZZZZZZZZ')).rejects.toThrow('This memory is gone: the list has been refreshed.')
    await expect(rpc.memorySave(A, { body: '  ', tier: 'log' })).rejects.toThrow('The memory is empty: nothing was saved.')
    // e mai il messaggio del motore
    await expect(rpc.memoryNote(A, 'ZZZZZZZZ')).rejects.not.toThrow(/not found/i)
  })

  it('i code del motore, uno per uno: dal code alla frase, mai il messaggio inglese', async () => {
    await fresh('it')
    const { memoryErrorText } = await import('../memory-rpc')
    const frase = (e: unknown): string => memoryErrorText(e)
    const attese: Array<[string, RegExp]> = [
      ['NOT_FOUND', /^Questa memoria non c’è più/],
      ['INVALID_NOTE', /^Questa modifica non è valida/],
      ['QUARANTINED', /^Questa memoria è già confermata/],
      ['NOTE_PURGED', /^Questa memoria è stata dimenticata per sempre/],
      ['CLOSED', /^Il motore della memoria è chiuso: riavvia Homun/],
      ['IO', /^Il motore della memoria non ha potuto leggere o scrivere le celle: riprova/],
      ['SCHEMA_TOO_NEW', /^Questa memoria è stata aggiornata da una versione più recente di Engramma: aggiorna Homun/],
      ['MODEL_MISSING', /^Manca il modello della ricerca/],
      // senza una frase loro: quella generica, comunque non il messaggio
      ['EXPERIMENTAL', /^La memoria non ha risposto: riprova/],
      ['PROTOCOL_ERROR', /^La memoria non ha risposto: riprova/],
      ['INVALID_ARGUMENT', /^La memoria non ha risposto: riprova/],
      ['STALE_TARGET', /^La memoria non ha risposto: riprova/],
      ['COMPACTED', /^La memoria non ha risposto: riprova/],
      ['PAIRING_REJECTED', /^La memoria non ha risposto: riprova/],
      ['BOGUS_CODE', /^La memoria non ha risposto: riprova/]
    ]
    for (const [code, re] of attese) {
      const t = frase({ code, message: 'english text from the engine' })
      expect(t, code).toMatch(re)
      expect(t, code).not.toMatch(/english text/)
    }
    // un errore senza code (un bug, un TypeError): la frase generica, mai il testo
    expect(frase(new TypeError('Cannot read properties of undefined'))).toBe('La memoria non ha risposto: riprova.')
    expect(frase('boh')).toBe('La memoria non ha risposto: riprova.')
    expect(frase(null)).toBe('La memoria non ha risposto: riprova.')
    // il motore non c'è: dal motivo
    const { MemoryUnavailableError } = await import('../engine')
    expect(frase(new MemoryUnavailableError('schema-too-new'))).toMatch(/^Questa memoria è stata aggiornata/)
    expect(frase(new MemoryUnavailableError('closed'))).toBe('Il motore della memoria è chiuso: riavvia Homun.')
    expect(frase(new MemoryUnavailableError('module', 'vendor/engramma: …'))).toBe('Il motore della memoria non è disponibile: leggi l’avviso in cima alla sezione.')
    expect(frase(new MemoryUnavailableError('open', 'the Engramma engine did not open'))).toBe('Il motore della memoria non è disponibile: leggi l’avviso in cima alla sezione.')
    expect(frase(new MemoryUnavailableError('space'))).toBe('Il motore della memoria non è disponibile: leggi l’avviso in cima alla sezione.')
  })

  it('il download del modello che non riesce (IO del motore: endpoint su una porta chiusa di 127.0.0.1) porta una frase, non l’indirizzo né l’errore del sistema', async () => {
    expect(envVisibileAlMotore).toBe(true)
    await fresh('it')
    const rpc = await import('../memory-rpc')
    const esito = await new Promise<{ ok: boolean; error?: string }>((done) => { rpc.startModelPull(() => {}, done) })
    expect(esito.ok).toBe(false)
    expect(esito.error).toBe('controlla la connessione e lo spazio su disco, poi riprova')
    expect(esito.error).not.toMatch(/http|refused|os error|pull/i)
  })

  it('il download col motore chiuso (o senza modello dietro) dice quello, sempre in una frase', async () => {
    await fresh('it')
    const rpc = await import('../memory-rpc')
    const { closeMemoryEngine } = await import('../engine')
    await closeMemoryEngine()
    const esito = await new Promise<{ ok: boolean; error?: string }>((done) => { rpc.startModelPull(() => {}, done) })
    expect(esito).toEqual({ ok: false, error: 'il motore della memoria non è disponibile (riavvia Homun)' })
    expect(rpc.modelPullErrorText({ code: 'IO', message: 'pull: …' })).toBe('controlla la connessione e lo spazio su disco, poi riprova')
    expect(rpc.modelPullErrorText({ code: 'BOGUS', message: 'x' })).toBe('riprova')
  })
})
