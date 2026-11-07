// Fase pagine (G1/G2): le funzioni PURE dell'anteprima e dell'indice —
// pagePreview (titolo da #, intro saltando righe vuote e immagini, SOLO i
// titoli ##/###) e pageHeadings (id stabili dai titoli, suffisso sui doppi,
// niente titoli dentro i blocchi di codice).
// Fase pagine · ritocchi (P2): pageBody — il corpo da rendere nella pagina
// aperta, dove il primo `# ` uguale al titolo NON si riduplica (il titolo lo
// mostra già la pagina); l'indice e gli id dei titoli non cambiano.
import { describe, expect, it } from 'vitest'
import { pagePreview, pageHeadings, pageBody } from '../page-view'

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

describe('fase pagine · ritocchi (P2): pageBody — il titolo non compare due volte', () => {
  it('il primo `# ` uguale al titolo NON si rende nel corpo (il titolo è già nella pagina)', () => {
    const md = ['# Brief della settimana', '', 'Intro del documento.', '', '## Sezione 1', '', 'testo'].join('\n')
    expect(pageBody(md, 'Brief della settimana')).toBe(['', 'Intro del documento.', '', '## Sezione 1', '', 'testo'].join('\n'))
  })

  it('maiuscole, spazi e punteggiatura in coda NON contano nel confronto', () => {
    const md = ['# brief della settimana :', '', 'testo'].join('\n')
    expect(pageBody(md, 'Brief della settimana')).toBe(['', 'testo'].join('\n'))
  })

  it('un `# ` DIVERSO dal titolo resta nel corpo', () => {
    const md = ['# Un altro titolo', '', 'testo'].join('\n')
    expect(pageBody(md, 'Brief della settimana')).toBe(md)
  })

  it('documento senza `# `: invariato', () => {
    const md = 'Solo un paragrafo.\n\n## Sezione\n\ntesto'
    expect(pageBody(md, 'Brief della settimana')).toBe(md)
  })

  it('un `# ` più in basso, dopo del testo, RESTA (si guarda solo la prima riga non vuota)', () => {
    const md = ['Prima il testo.', '', '# Titolo nel mezzo', '', 'altro testo'].join('\n')
    expect(pageBody(md, 'Titolo nel mezzo')).toBe(md)
  })

  it('le righe vuote in testa si saltano: il `# ` dopo resta il primo non vuoto', () => {
    const md = ['', '', '# Brief della settimana', '', 'testo'].join('\n')
    expect(pageBody(md, 'Brief della settimana')).toBe(['', '', '', 'testo'].join('\n'))
  })

  it('un `# ` DENTRO un blocco di codice non è un titolo: resta', () => {
    const md = ['```md', '# Brief della settimana', '```', '', 'testo'].join('\n')
    expect(pageBody(md, 'Brief della settimana')).toBe(md)
  })

  it('l\'indice e gli id dei titoli NON cambiano (il corpo è solo del rendering)', () => {
    const md = ['# Brief della settimana', '', '## Contesto', 'testo', '### Numeri', 'testo'].join('\n')
    const body = pageBody(md, 'Brief della settimana')
    expect(pageHeadings(body)).toEqual(pageHeadings(md))
    expect(pageHeadings(body).map((h) => h.id)).toEqual(pageHeadings(md).map((h) => h.id))
  })
})
