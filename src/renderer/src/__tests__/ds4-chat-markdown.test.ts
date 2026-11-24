// Fase design (DS4, Chat): UN SOLO MARKDOWN per tutti i testi di bot. Prima
// c'erano due renderer (BotMarkdown in Chat.tsx, nudo: le regole del browser
// sui titoli e sulle tabelle; e DocumentMarkdown per i documenti). Ora le
// regole di DS1 stanno in UN posto (DocumentMarkdown.tsx) e ogni testo di bot
// — le bolle della chat, i messaggi della squadra, i pannelli di task e
// sottoagente, i documenti compatti — passa da lì.
// Qui si prova la VISTA senza DOM: l'HTML reso (le classi dei token su ogni
// elemento), la scelta inline/blocco del codice (è logica: la fa un contesto),
// e che nessuna classe sia morta nel CSS compilato da styles.css.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, parseHtml, textOf, findAll, type HtmlNode } from './render-helper'
import { compileRenderer, deadClasses } from './tailwind-compile'

const { BotMarkdown, DocumentBody } = await import('../components/DocumentMarkdown')

const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter(Boolean)
const has = (node: HtmlNode, cls: string): boolean => classes(node).includes(cls)
const first = (root: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode => findAll(root, pred)[0]!
const render = (text: string): HtmlNode => parseHtml(renderHtml(createElement(BotMarkdown, { text })))

/** Un po' di tutto: titoli, paragrafo con codice e link, elenchi, citazione, blocco di codice, tabella, riga. */
const TUTTO = [
  '# Titolo uno',
  '## Titolo due',
  '### Titolo tre',
  'Paragrafo con `codice`, **grassetto** e [un link](https://example.it).',
  '',
  '- primo',
  '- secondo',
  '',
  '1. uno',
  '2. due',
  '',
  '> una citazione',
  '',
  '```js',
  'const moltoLunga = "una riga di codice più larga della bolla: scorre dentro il blocco";',
  '```',
  '',
  '| Fornitore | Consegna |',
  '| --- | --- |',
  '| Rossi SRL | 3 giorni |',
  '| Verdi SNC | 2 giorni |',
  '',
  '---',
  ''
].join('\n')

/** Le sei dimensioni di DS1: l'unica cosa che una classe text-* può essere qui, oltre a un colore. */
const SEI = ['text-caption', 'text-small', 'text-body', 'text-reading', 'text-title', 'text-page']
const isDimensione = (cls: string): boolean => SEI.includes(cls)
const isColore = (cls: string): boolean => /^text-(?:muted-foreground|foreground|primary|destructive|waiting|chart-\d)(?:\/\d+)?$/.test(cls) || /^text-\[var\(--/.test(cls)

describe('DS4: un solo markdown — chi lo usa', () => {
  const src = (f: string): string => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')
  it('le regole stanno in UN posto: Chat e TeamChat non hanno un renderer loro, usano BotMarkdown di DocumentMarkdown', () => {
    for (const f of ['../components/Chat.tsx', '../components/TeamChat.tsx']) {
      expect(src(f), `${f}: non importa react-markdown`).not.toMatch(/from 'react-markdown'/)
      expect(src(f), `${f}: non importa remark-gfm`).not.toMatch(/from 'remark-gfm'/)
      expect(src(f)).toMatch(/import \{[^}]*\bBotMarkdown\b[^}]*\} from '\.\/DocumentMarkdown'/)
    }
    // e in DocumentMarkdown c'è UN renderer solo (prima: uno qui e uno in Chat)
    expect(src('../components/DocumentMarkdown.tsx').match(/<ReactMarkdown/g)?.length).toBe(1)
  })
})

describe('DS4: il markdown reso — le regole di DS1 su ogni elemento', () => {
  const root = render(TUTTO)

  it('la radice è testo di lettura (16/26) e distribuisce i blocchi a 12 px: i paragrafi non portano una taglia loro', () => {
    for (const cls of ['flex', 'flex-col', 'gap-3', 'text-reading', 'min-w-0']) expect(has(root.children[0]!, cls), cls).toBe(true)
    const p = first(root, (n) => n.tag === 'p')
    expect(classes(p).some((c) => isDimensione(c))).toBe(false)
  })

  it('titoli: h1 e h2 text-title in semibold, h3 della misura del testo in semibold (nessuna interlinea scritta a mano)', () => {
    const cls = (tag: string): string[] => classes(first(root, (n) => n.tag === tag))
    for (const tag of ['h1', 'h2']) {
      expect(cls(tag), tag).toContain('text-title')
      expect(cls(tag), tag).toContain('font-semibold')
    }
    expect(cls('h3')).toContain('font-semibold')
    // h3 NON cambia misura: resta quella del testo (text-reading), ereditata
    expect(cls('h3').some(isDimensione)).toBe(false)
    for (const tag of ['h1', 'h2', 'h3']) expect(cls(tag).some((c) => c.startsWith('leading-')), tag).toBe(false)
    // nessun maiuscoletto
    for (const n of findAll(root, () => true)) expect(classes(n)).not.toContain('uppercase')
  })

  it('codice INLINE: text-small su fondo tenue, raggio di controllo, respiro dalla scala — e non è un contenitore che scorre', () => {
    const p = first(root, (n) => n.tag === 'p')
    const code = first(p, (n) => n.tag === 'code')
    for (const cls of ['font-mono', 'text-small', 'rounded-control', 'bg-muted', 'px-1.5', 'py-0.5']) expect(has(code, cls), cls).toBe(true)
    expect(classes(code)).not.toContain('overflow-x-auto')
    expect(textOf(code)).toBe('codice')
  })

  it('codice di BLOCCO: il <pre> è il contenitore che scorre (dentro, mai la bolla), raggio di controllo, p-3, text-small monospazio — e il <code> dentro NON si riveste di nuovo', () => {
    const pre = first(root, (n) => n.tag === 'pre')
    for (const cls of ['overflow-x-auto', 'rounded-control', 'bg-muted', 'p-3', 'font-mono', 'text-small']) expect(has(pre, cls), cls).toBe(true)
    expect(pre.children.map((c) => c.tag)).toEqual(['code'])
    const code = pre.children[0]!
    expect(has(code, 'font-mono')).toBe(true)
    expect(has(code, 'text-small')).toBe(true)
    // il fondo, il raggio e il respiro sono del blocco: dentro il codice è nudo
    for (const cls of ['bg-muted', 'rounded-control', 'px-1.5', 'py-0.5', 'overflow-x-auto']) expect(has(code, cls), cls).toBe(false)
    expect(textOf(pre)).toBe('const moltoLunga = "una riga di codice più larga della bolla: scorre dentro il blocco";')
  })

  it('un blocco senza lingua è comunque un blocco (e non codice inline): lo decide il posto, non la classe language-*', () => {
    const r = render('```\nsolo testo\n```')
    const pre = first(r, (n) => n.tag === 'pre')
    expect(has(pre, 'bg-muted')).toBe(true)
    expect(has(pre.children[0]!, 'px-1.5')).toBe(false)
  })

  it('tabelle: in un contenitore che scorre in orizzontale; intestazioni text-caption grigie in tono normale, celle text-body, filetti fra le righe', () => {
    const table = first(root, (n) => n.tag === 'table')
    const scroller = table.parent!
    expect(scroller.tag).toBe('div')
    expect(has(scroller, 'overflow-x-auto')).toBe(true)
    const th = findAll(table, (n) => n.tag === 'th')
    const td = findAll(table, (n) => n.tag === 'td')
    expect(th.map(textOf)).toEqual(['Fornitore', 'Consegna'])
    expect(td.map(textOf)).toEqual(['Rossi SRL', '3 giorni', 'Verdi SNC', '2 giorni'])
    for (const c of th) {
      for (const cls of ['text-caption', 'text-muted-foreground', 'font-normal', 'border-border/50', 'whitespace-nowrap']) expect(has(c, cls), cls).toBe(true)
      expect(has(c, 'font-semibold')).toBe(false)
      // maiuscoletto né sfondo: l'intestazione si riconosce dalla taglia e dal colore
      expect(classes(c)).not.toContain('uppercase')
      expect(classes(c).some((x) => x.startsWith('bg-'))).toBe(false)
    }
    for (const c of td) {
      for (const cls of ['text-body', 'border-border/50']) expect(has(c, cls), cls).toBe(true)
    }
  })

  it('link sottolineati, citazione col filetto a sinistra, grassetto in semibold (i pesi sono tre), riga e immagine nei raggi', () => {
    expect(has(first(root, (n) => n.tag === 'a'), 'underline')).toBe(true)
    const quote = first(root, (n) => n.tag === 'blockquote')
    expect(has(quote, 'border-l-2')).toBe(true)
    expect(has(quote, 'border-border')).toBe(true)
    expect(has(first(root, (n) => n.tag === 'strong'), 'font-semibold')).toBe(true)
    expect(has(first(root, (n) => n.tag === 'hr'), 'border-border')).toBe(true)
    const img = first(render('![alt](x.png)'), (n) => n.tag === 'img')
    expect(has(img, 'rounded-surface')).toBe(true)
    expect(has(img, 'max-w-full')).toBe(true)
  })

  it('elenchi con pallino e numero, rientrati; una voce resta una voce di elenco (il pallino si vede) anche quando dentro ha più blocchi', () => {
    const ul = first(root, (n) => n.tag === 'ul')
    expect(has(ul, 'list-disc')).toBe(true)
    expect(has(ul, 'pl-6')).toBe(true)
    const ol = first(root, (n) => n.tag === 'ol')
    expect(has(ol, 'list-decimal')).toBe(true)
    const li = ul.children[0]!
    expect(li.tag).toBe('li')
    expect(has(li, 'flex')).toBe(false)
    expect(textOf(li)).toBe('primo')
    // elenco «largo»: due paragrafi in una voce, distanziati dalle regole sui
    // figli BLOCCO della voce (R1 b20-ritocchi: l'involucro flex è uscito)
    const largo = render('- primo\n\n  secondo paragrafo')
    const voce = first(largo, (n) => n.tag === 'li')
    expect(voce.children.map((c) => c.tag)).toEqual(['p', 'p'])
    expect(findAll(voce, (n) => n.tag === 'p')).toHaveLength(2)
  })

  describe('R1 (b20-ritocchi): il grassetto dentro un elenco NON spezza la riga', () => {
    it('«- a **b** c»: i pezzi in riga sono figli DIRETTI della voce — nessun involucro che mette ognuno su una riga sua', () => {
      const r = render('- a **b** c')
      const li = first(r, (n) => n.tag === 'li')
      expect(li.children.map((c) => c.tag), 'i figli della voce sono i pezzi in riga, senza div intorno').toEqual(['strong'])
      // il testo DIRETTO della voce: ciò che sta prima e dopo il grassetto, sulla STESSA riga
      expect(li.text.replace(/\s+/g, ' ').trim()).toBe('a c')
      expect(li.children.map(textOf)).toEqual(['b'])
    })

    it('«- testo con `codice` e [link](x)»: codice e link in riga nella voce, stesso posto del testo', () => {
      const r = render('- testo con `codice` e [link](x)')
      const li = first(r, (n) => n.tag === 'li')
      expect(li.children.map((c) => c.tag)).toEqual(['code', 'a'])
      expect(li.text.replace(/\s+/g, ' ').trim()).toBe('testo con e')
      expect(li.children.map(textOf)).toEqual(['codice', 'link'])
    })

    it('la voce larga distanzia i paragrafi con le regole sui figli blocco, non con un involucro flex', () => {
      const r = render('- primo paragrafo\n\n  secondo paragrafo\n\n- altra voce')
      const li = first(r, (n) => n.tag === 'li')
      expect(li.children.map((c) => c.tag)).toEqual(['p', 'p'])
      for (const cls of ['[&>p+p]:mt-2', '[&>ul]:mt-1', '[&>ol]:mt-1']) expect(has(li, cls), cls).toBe(true)
      // niente colonna flex nella voce: è ciò che spezzava la riga
      expect(has(li, 'flex')).toBe(false)
      expect(li.children.some((c) => c.tag === 'div')).toBe(false)
    })

    it('l’elenco annidato sta nella voce che lo contiene, come un figlio blocco qualunque', () => {
      const r = render('- voce\n  - annidata\n- altra')
      const li = first(r, (n) => n.tag === 'li')
      expect(li.children.map((c) => c.tag)).toEqual(['ul'])
      expect(has(li, '[&>ul]:mt-1')).toBe(true)
      expect(textOf(first(li, (n) => n.tag === 'ul'))).toBe('annidata')
    })
  })

  it('ogni taglia che compare è una delle sei (la sonda misura ogni testo: tabelle e codice compresi)', () => {
    // una taglia: una delle sei, una libera (text-[…]) o una di Tailwind (text-xs, text-sm…). text-left è un allineamento, i colori no
    const sospetta = (cls: string): boolean => /^text-(?:\[.*\]|xs|sm|base|lg|\d?xl)$/.test(cls) && !isColore(cls)
    const viste = new Set<string>()
    for (const n of findAll(root, () => true)) {
      for (const cls of classes(n)) {
        if (!isDimensione(cls) && !sospetta(cls)) continue
        viste.add(cls)
        expect(isDimensione(cls), `classe fuori dalle sei: ${cls} su <${n.tag}>`).toBe(true)
      }
    }
    // il controllo non è vuoto: nel documento le taglie dichiarate sono queste quattro
    expect([...viste].sort()).toEqual(['text-body', 'text-caption', 'text-reading', 'text-small', 'text-title'])
  })

  it('il testo non cambia: stesso contenuto di sempre, ogni blocco col suo testo (nessuno spurio dentro i blocchi)', () => {
    expect(findAll(root, (n) => ['h1', 'h2', 'h3', 'li', 'blockquote', 'pre', 'th', 'td'].includes(n.tag)).map((n) => `${n.tag}:${textOf(n)}`)).toEqual([
      'h1:Titolo uno', 'h2:Titolo due', 'h3:Titolo tre',
      'li:primo', 'li:secondo', 'li:uno', 'li:due',
      'blockquote:una citazione',
      'pre:const moltoLunga = "una riga di codice più larga della bolla: scorre dentro il blocco";',
      'th:Fornitore', 'th:Consegna', 'td:Rossi SRL', 'td:3 giorni', 'td:Verdi SNC', 'td:2 giorni'
    ])
    // il paragrafo con i pezzi in linea: i figli nell'ordine, ciascuno col suo testo, il link col suo href
    const p = first(root, (n) => n.tag === 'p')
    expect(p.children.map((c) => c.tag)).toEqual(['code', 'strong', 'a'])
    expect(p.children.map(textOf)).toEqual(['codice', 'grassetto', 'un link'])
    // il testo diretto del paragrafo: «Paragrafo con », «, », « e », «.» (l'helper li tiene insieme, i figli a parte)
    expect(p.text).toBe('Paragrafo con ,  e .')
    expect(p.children[2]!.attrs.href).toBe('https://example.it')
  })

  it('nessuna classe morta: ogni classe del markdown ha la sua regola nel CSS compilato da styles.css', async () => {
    const tutte = new Set<string>()
    for (const n of findAll(root, () => true)) for (const cls of classes(n)) tutte.add(cls)
    for (const n of findAll(render('![alt](x.png)'), () => true)) for (const cls of classes(n)) tutte.add(cls)
    // language-* la mette react-markdown (la lingua del blocco): non è una classe nostra
    for (const cls of [...tutte]) if (cls.startsWith('language-')) tutte.delete(cls)
    expect(tutte.size).toBeGreaterThan(20)
    const css = await compileRenderer([...tutte])
    expect(deadClasses(css, tutte)).toEqual([])
    // il controllo non è vuoto: un nome sbagliato lo vede
    expect(deadClasses(css, [...tutte, 'gap-row-gapp'])).toEqual(['gap-row-gapp'])
  })
})

describe('DS4: il documento usa LE STESSE regole (il testo dei documenti è text-reading)', () => {
  it('DocumentBody compatta: radice di lettura, stessi titoli, stessa tabella, stesso blocco di codice', () => {
    const root = parseHtml(renderHtml(createElement(DocumentBody, { markdown: TUTTO })))
    const pre = first(root, (n) => n.tag === 'pre')
    for (const cls of ['overflow-x-auto', 'rounded-control', 'bg-muted', 'p-3', 'text-small']) expect(has(pre, cls), cls).toBe(true)
    const h2 = first(root, (n) => n.tag === 'h2')
    for (const cls of ['text-title', 'font-semibold']) expect(has(h2, cls), cls).toBe(true)
    const th = first(root, (n) => n.tag === 'th')
    for (const cls of ['text-caption', 'text-muted-foreground', 'font-normal']) expect(has(th, cls), cls).toBe(true)
    // il paragrafo è di lettura (lo eredita), non più testo di riga
    const p = first(root, (n) => n.tag === 'p')
    expect(has(p, 'text-body')).toBe(false)
    let a: HtmlNode | null = p
    while (a && !classes(a).some(isDimensione)) a = a.parent
    expect(classes(a!)).toContain('text-reading')
  })

  it('il documento aperto (page): lo stesso albero con la classe .page-prose, i titoli portano gli id dell’indice', () => {
    const root = parseHtml(renderHtml(createElement(DocumentBody, {
      markdown: '## Primo\n\ntesto\n\n### Secondo\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n',
      headingIds: ['h-primo', 'h-secondo'],
      typography: 'page'
    })))
    expect(classes(root.children[0]!)).toContain('page-prose')
    expect(findAll(root, (n) => n.tag === 'h2').map((n) => n.attrs.id)).toEqual(['h-primo'])
    expect(findAll(root, (n) => n.tag === 'h3').map((n) => n.attrs.id)).toEqual(['h-secondo'])
    // le regole degli elementi sono le stesse: non c'è un secondo insieme per la pagina
    expect(has(first(root, (n) => n.tag === 'table').parent!, 'overflow-x-auto')).toBe(true)
    expect(has(first(root, (n) => n.tag === 'th'), 'text-caption')).toBe(true)
    expect(has(first(root, (n) => n.tag === 'h2'), 'text-title')).toBe(true)
    let a: HtmlNode | null = first(root, (n) => n.tag === 'p')
    while (a && !classes(a).some(isDimensione)) a = a.parent
    expect(classes(a!)).toContain('text-reading')
  })
})

describe('DS4: .page-prose (il documento aperto) — solo le differenze della pagina, lette dai token', () => {
  const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8')
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`)
    expect(at, `la regola «${selector}» in styles.css`).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }
  const pagina = css.slice(css.indexOf('.page-prose {'))

  it('il testo è text-reading e i blocchi stanno a 12 px (la distanza dei token, la stessa del markdown della chat)', () => {
    expect(rule('.page-prose')).toMatch(/font-size:\s*var\(--text-reading\);/)
    expect(rule('.page-prose')).toMatch(/line-height:\s*var\(--text-reading--line-height\);/)
    expect(rule('.page-prose')).toMatch(/gap:\s*var\(--spacing-section-head\);/)
    expect(rule('.page-prose')).toMatch(/flex-direction:\s*column;/)
  })

  it('h1 text-page e h2 text-title col carattere dei titoli (font-display); h3 text-title NO: h3 è text-reading semibold, senza carattere display', () => {
    expect(rule('.page-prose h1')).toMatch(/font-size:\s*var\(--text-page\);/)
    expect(rule('.page-prose h1')).toMatch(/line-height:\s*var\(--text-page--line-height\);/)
    expect(rule('.page-prose h1')).toMatch(/font-family:\s*var\(--font-display\);/)
    expect(rule('.page-prose h2')).toMatch(/font-size:\s*var\(--text-title\);/)
    expect(rule('.page-prose h2')).toMatch(/line-height:\s*var\(--text-title--line-height\);/)
    expect(rule('.page-prose h2')).toMatch(/font-family:\s*var\(--font-display\);/)
    expect(rule('.page-prose h3')).toMatch(/font-size:\s*var\(--text-reading\);/)
    expect(rule('.page-prose h3')).toMatch(/line-height:\s*var\(--text-reading--line-height\);/)
    expect(rule('.page-prose h3')).toMatch(/font-weight:\s*600;/)
    expect(rule('.page-prose h3')).not.toMatch(/font-family/)
  })

  it('nessuna dimensione scritta a mano (px, em, rem, %) e nessun raggio: nel blocco .page-prose ogni taglia è una variabile delle sei', () => {
    const sizes = [...pagina.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1]!)
    expect(sizes.length).toBeGreaterThanOrEqual(4)
    for (const s of sizes) expect(s, `font-size: ${s}`).toMatch(/^var\(--text-(caption|small|body|reading|title|page)\)$/)
    // i raggi, il codice, le tabelle e le immagini NON si riscrivono qui: sono le regole di PROSE
    expect(pagina).not.toMatch(/border-radius:/)
    expect(pagina).not.toMatch(/font-size:\s*[\d.]+(px|em|rem|%)/)
    // i pesi sono tre
    for (const m of pagina.matchAll(/font-weight:\s*([^;]+);/g)) expect(m[1]).toMatch(/^(400|500|600|normal|medium|semibold)$/)
  })

  it('compilate: le variabili dei token escono davvero nel CSS (senza, .page-prose non avrebbe misura)', async () => {
    const out = await compileRenderer(['text-reading'])
    for (const v of ['--text-reading', '--text-reading--line-height', '--text-page', '--text-page--line-height', '--text-title', '--spacing-section-head', '--font-display']) {
      expect(out, `${v} nel CSS compilato`).toMatch(new RegExp(`${v.replace(/-/g, '\\-')}\\s*:`))
    }
  })
})
