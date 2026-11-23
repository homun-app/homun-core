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

// ---- R2 (fase ritocchi-beta18): l'anteprima è TESTO, non markdown ----
// Il difetto (cattura fase-deleghe/2): l'anteprima della card «Ricettario —
// indice» mostrava `[Pastiera napoletana](libe7eeadc6)` — il link restava in
// markdown grezzo e il `_` di `lib_` spariva (la pulizia toglieva i `_` come
// se fossero corsivo). previewLineText è la funzione UNICA del testo
// dell'anteprima, usata dalle card della Libreria (pagePreview) e dalla
// vista a elenco (LibraryPanel).
import { previewLineText } from '../page-view'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

describe('R2 (ritocchi-beta18): previewLineText — il testo, non il markdown', () => {
  it('il testo dell\'indice della spec D6 → «Pastiera napoletana — il classico della domenica.», senza ](', () => {
    const md = [
      '# Ricettario — indice',
      '',
      '## Dolci',
      '- [Pastiera napoletana](lib_e7eeadc6) — il classico della domenica.',
      '- Ispirazioni esterne: [raccolta napoletana](https://ricette.example/pastiera).',
      '- La ricetta completa sta in [pastiera-napoletana.md](/workspace/ricettario/pastiera-napoletana.md).',
      ''
    ].join('\n')
    const p = pagePreview(md)
    expect(p.intro).toBeTruthy()
    expect(p.intro!.startsWith('Pastiera napoletana — il classico della domenica.')).toBe(true)
    expect(p.intro).not.toContain('](')
    expect(p.intro).not.toContain('lib_')
  })

  it('[testo](url) → testo; le immagini → niente', () => {
    expect(previewLineText('- [Pastiera napoletana](lib_e7eeadc6) — il classico della domenica.'))
      .toBe('Pastiera napoletana — il classico della domenica.')
    expect(previewLineText('[raccolta napoletana](https://ricette.example/pastiera).'))
      .toBe('raccolta napoletana.')
    expect(previewLineText('![logo](data:image/png;base64,xxx)')).toBe('')
    expect(previewLineText('prima ![img](u.png) e dopo')).toBe('prima  e dopo')
  })

  it('snake_case e lib_e7eeadc6 restano INTATTI (mai un `_` dentro una parola)', () => {
    expect(previewLineText('il nome snake_case resta')).toBe('il nome snake_case resta')
    expect(previewLineText('vede [Pastiera](lib_e7eeadc6) qui')).toBe('vede Pastiera qui')
    expect(previewLineText('lib_e7eeadc6')).toBe('lib_e7eeadc6')
  })

  it('*corsivo*, **grassetto** e _corsivo_ perdono i marcatori (solo inizio/fine parola)', () => {
    expect(previewLineText('*corsivo*')).toBe('corsivo')
    expect(previewLineText('**grassetto**')).toBe('grassetto')
    expect(previewLineText('_corsivo_')).toBe('corsivo')
    expect(previewLineText('un *corsivo* in **mezzo** alla riga')).toBe('un corsivo in mezzo alla riga')
    expect(previewLineText('**grassetto su più parole**')).toBe('grassetto su più parole')
  })

  it('i marcatori di riga (titolo, lista, citazione) spariscono, come oggi', () => {
    expect(previewLineText('## Dolci')).toBe('Dolci')
    expect(previewLineText('- una voce')).toBe('una voce')
    expect(previewLineText('> una citazione')).toBe('una citazione')
  })

  it('la vista a elenco della Libreria usa la STESSA funzione (niente più replace dei soli caratteri)', () => {
    const src = readFileSync(fileURLToPath(new URL('../../components/LibraryPanel.tsx', import.meta.url)), 'utf8')
    expect(src).toContain('previewLineText')
    expect(src).not.toContain('replace(/[#*_')
  })
})

// ---- B4 (fase b20-bug): le TABELLE nell'anteprima ----
// Il difetto (catture della fase): le schede della Libreria mostravano le
// tabelle crude — `|---|---|` e `| Ricetta | Data |`. previewLineText resta
// la funzione UNICA: le righe separatrici spariscono, una riga di tabella
// diventa celle separate da « · » (ripulite dagli spazi bordo; una cella vuota
// non lascia separatori doppi né in testa/in coda).
describe('B4 (b20-bug): previewLineText — le tabelle non restano crude', () => {
  it('le righe separatrici spariscono: |---|---|, | :--- | ---: |, |---|:---:|', () => {
    expect(previewLineText('|---|---|')).toBe('')
    expect(previewLineText('| :--- | ---: |')).toBe('')
    expect(previewLineText('|---|:---:|')).toBe('')
    // con gli spazi bordo e senza i tubi esterni resta un separatore
    expect(previewLineText('  | --- | --- | --- |  ')).toBe('')
    expect(previewLineText('--- | ---')).toBe('')
  })

  it('una riga di tabella diventa celle separate da « · »: | Ricetta | Data | → «Ricetta · Data»', () => {
    expect(previewLineText('| Ricetta | Data |')).toBe('Ricetta · Data')
    expect(previewLineText('|Pastiera|domenica|')).toBe('Pastiera · domenica')
    expect(previewLineText('| Ricetta | Data | Porzioni |')).toBe('Ricetta · Data · Porzioni')
    expect(previewLineText('| Solo |')).toBe('Solo')
  })

  it('le celle vuote non lasciano separatori doppi né ai bordi', () => {
    expect(previewLineText('| Ricetta | |')).toBe('Ricetta')
    expect(previewLineText('| | 12 |')).toBe('12')
    expect(previewLineText('| Ricetta |  | Data |')).toBe('Ricetta · Data')
    expect(previewLineText('| | |')).toBe('')
  })

  it('dentro le celle valgono le stesse regole: link, grassetti, corsivi e codice perdono i marcatori', () => {
    expect(previewLineText('| [Pastiera napoletana](lib_e7eeadc6) | **domenica** |')).toBe('Pastiera napoletana · domenica')
    expect(previewLineText('| `v1.2` | _classico_ |')).toBe('v1.2 · classico')
  })

  it('una riga che NON è una tabella resta com\'è (un tubo in mezzo al testo, una linea ---)', () => {
    expect(previewLineText('usa a | b nel terminale')).toBe('usa a | b nel terminale')
    expect(previewLineText('---')).toBe('---')
    expect(previewLineText('- voce con | tubo')).toBe('voce con | tubo')
  })

  it('la card (pagePreview) di un documento che inizia con una tabella: niente |---|---|, l\'intro è «Ricetta · Data Pastiera · domenica»', () => {
    const md = ['# Ricettario', '', '| Ricetta | Data |', '|---|---|', '| Pastiera | domenica |', ''].join('\n')
    const p = pagePreview(md)
    expect(p.title).toBe('Ricettario')
    expect(p.intro).toBe('Ricetta · Data Pastiera · domenica')
    expect(p.intro).not.toContain('|')
    expect(p.intro).not.toContain('---')
  })
})
