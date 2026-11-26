// fase linguaggio-ritocchi (R1): il RACCOGLITORE delle traduzioni mancanti.
// Solo nelle corse di prova (il flag lo espone il preload con
// SANDBOT_TEST_USER_DATA) il renderer ascolta l'evento «missing» di Lingui e
// accumula gli id su window; la galleria li svuota a ogni scena e segna la
// scena ROSSA con l'id. Il raccoglitore NASCE UNA VOLTA SOLA: la pagina dei
// componenti della galleria è un bundle suo, con una COPIA di questo modulo e
// una sua istanza di i18n — la prima versione la lasciava ricoprire da un
// raccoglitore nuovo che non vedeva gli eventi del bundle principale, e in
// galleria non si raccoglieva più niente (le scene della Libreria restavano
// verdi con «g0mreA» sullo schermo). Il terzo test è rosso con quella versione.
import { afterEach, describe, expect, it, vi } from 'vitest'

type Mancante = { id: string; locale: string }
type Raccoglitore = { visti: Mancante[]; drain(): Mancante[] }
/** Il raccoglitore sta su WINDOW (l'oggetto che il modulo riceve), non su globalThis. */
const raccoglitore = (): Raccoglitore | undefined => (globalThis as unknown as { window?: { __sandbotTraduzioniMancanti?: Raccoglitore } }).window?.__sandbotTraduzioniMancanti
const finestraDiProva = (): void => { vi.stubGlobal('window', { sandbotTest: { traduzioni: true } }) }

describe('R1: il raccoglitore delle traduzioni mancanti (solo nelle corse di prova)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('@lingui/core')
    vi.resetModules()
  })

  it('nell\'app vera (nessun SANDBOT_TEST_*) non c\'è: nessun raccoglitore su window', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { sandbotTest: { galleria: false } })
    await import('../lib/i18n')
    expect(raccoglitore()).toBeUndefined()
  })

  it('raccoglie gli id che Lingui dichiara mancanti, e drain li consegna UNA volta (la galleria legge per scena)', async () => {
    vi.resetModules()
    finestraDiProva()
    const { i18n } = await import('../lib/i18n')
    const r = raccoglitore()
    expect(r).toBeDefined()
    i18n.emit('missing', { id: 'g0mreA', locale: 'it' })
    i18n.emit('missing', { id: 'V_pNa0', locale: 'it' })
    expect(r!.drain()).toEqual([{ id: 'g0mreA', locale: 'it' }, { id: 'V_pNa0', locale: 'it' }])
    expect(r!.drain(), 'svuotato: la scena dopo non eredita gli id della scena prima').toEqual([])
  })

  it('nasce UNA volta sola: una seconda copia del modulo, con la SUA i18n (il bundle della pagina dei componenti), riusa lo stesso elenco', async () => {
    vi.resetModules()
    finestraDiProva()
    const prima = await import('../lib/i18n')
    const r = raccoglitore()
    expect(r).toBeDefined()
    // la seconda copia: altri moduli e UN'ALTRA istanza di i18n, come in un bundle separato
    vi.resetModules()
    vi.doMock('@lingui/core', async (orig) => { const m = await orig() as typeof import('@lingui/core'); return { ...m, i18n: new m.I18n({}) } })
    const seconda = await import('../lib/i18n')
    expect(seconda.i18n, 'è davvero un\'altra istanza').not.toBe(prima.i18n)
    expect(raccoglitore(), 'la seconda copia non lo ricopre').toBe(r)
    seconda.i18n.emit('missing', { id: 'dalla-seconda-copia', locale: 'it' })
    prima.i18n.emit('missing', { id: 'dalla-prima-copia', locale: 'it' })
    expect(r!.drain().map((m) => m.id).sort()).toEqual(['dalla-prima-copia', 'dalla-seconda-copia'])
  })
})
