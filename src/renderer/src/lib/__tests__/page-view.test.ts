// Fase pagine (G1/G2): le funzioni PURE dell'anteprima e dell'indice —
// pagePreview (titolo da #, intro saltando righe vuote e immagini, SOLO i
// titoli ##/###) e pageHeadings (id stabili dai titoli, suffisso sui doppi,
// niente titoli dentro i blocchi di codice).
import { describe, expect, it } from 'vitest'
import { pagePreview, pageHeadings } from '../page-view'

describe('fase pagine (G1): pagePreview', () => {
  it('titolo dal primo #, intro = primo paragrafo, titoli ## e ### in ordine', () => {
    const md = [
      '# Brief operativo',
      '',
      'Questo brief raccoglie il lavoro della settimana.',
      'Seconda riga dello stesso paragrafo.',
      '',
      '## Contesto',
      'testo',
      '### Numeri',
      'testo',
      '## Prossimi passi'
    ].join('\n')
    expect(pagePreview(md)).toEqual({
      title: 'Brief operativo',
      intro: 'Questo brief raccoglie il lavoro della settimana. Seconda riga dello stesso paragrafo.',
      headings: ['Contesto', 'Numeri', 'Prossimi passi']
    })
  })

  it('l\'intro salta le righe vuote e le immagini', () => {
    const md = [
      '# Titolo',
      '',
      '![logo](data:image/png;base64,xxx)',
      '',
      'Prima frase utile.',
      '',
      'Altro paragrafo.'
    ].join('\n')
    expect(pagePreview(md).intro).toBe('Prima frase utile.')
  })

  it('solo i titoli ## e ###: # non è nell\'indice e #### nemmeno', () => {
    const md = ['# T', '', '## A', '### B', '#### C', '## D'].join('\n')
    expect(pagePreview(md).headings).toEqual(['A', 'B', 'D'])
  })

  it('documento senza titoli: title null, intro la prima riga utile, headings vuoto', () => {
    const md = ['Solo un paragrafo.', '', 'Altro paragrafo.'].join('\n')
    expect(pagePreview(md)).toEqual({ title: null, intro: 'Solo un paragrafo.', headings: [] })
  })

  it('documento vuoto: tutto vuoto', () => {
    expect(pagePreview('')).toEqual({ title: null, intro: null, headings: [] })
    expect(pagePreview('\n\n  \n')).toEqual({ title: null, intro: null, headings: [] })
  })
})

describe('fase pagine (G2): pageHeadings', () => {
  it('id stabili dal testo: minuscolo, trattini, accenti tolti', () => {
    const hs = pageHeadings('## Contesto di lavoro\n### Perché ora\n## Àncora')
    expect(hs.map((h) => h.id)).toEqual(['contesto-di-lavoro', 'perche-ora', 'ancora'])
    expect(hs.map((h) => h.level)).toEqual([2, 3, 2])
    expect(hs.map((h) => h.text)).toEqual(['Contesto di lavoro', 'Perché ora', 'Àncora'])
  })

  it('titoli doppi: suffisso -2, -3 (id UNICI)', () => {
    const hs = pageHeadings('## Numeri\n## Numeri\n## Numeri')
    expect(hs.map((h) => h.id)).toEqual(['numeri', 'numeri-2', 'numeri-3'])
  })

  it('i titoli dentro un blocco di codice NON contano (nemmeno ```vega-lite)', () => {
    const md = ['## Vero', '', '```vega-lite', '{ "title": {  "text": "x" } }', '```', '', '```', '## Finto', '```'].join('\n')
    expect(hs0(md)).toEqual(['Vero'])
    function hs0(m: string): string[] { return pageHeadings(m).map((h) => h.text) }
  })

  it('documento senza titoli: array vuoto', () => {
    expect(pageHeadings('testo e basta')).toEqual([])
  })
})
