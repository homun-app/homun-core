// RW (fase revisore sulla richiesta, punto 5): le note dell'aggiornamento
// arrivano come HTML (provider GitHub) e il dialogo mostrava i tag grezzi
// (<p>, <br>, <li>, <strong>). notesOf le converte in TESTO SEMPLICE:
// <li> → «• », a capo su </p>/</li>/<br>/titoli, via gli altri tag, entità
// decodificate, righe vuote multiple ridotte a una; oltre ~1500 caratteri si
// taglia alla fine dell'ultima voce intera con «…» e l'invito ad aprire le
// note. Tutto PURO.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { htmlToPlainText, releaseNotesText, RELEASE_NOTES_MAX_CHARS } from '../release-notes-text'

/** l'invito in coda al taglio (quello del dizionario, qui in italiano) */
const NOTES_MORE = 'Apri le note per il resto.'

import { extractReleaseNotes } from '../../../scripts/extract-release-notes.mjs'

/** la sezione beta.2 del CHANGELOG (la prova vera: la vede l'utente) */
const BETA2_MD = extractReleaseNotes(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8'),
  '0.3.1001-beta.2'
)!

/**
 * L'HTML che GitHub ne rende (forma tipica: p, h3, ul/li, strong, br, entità).
 * Le righe di continuazione di una voce restano DENTRO la loro <li> (come su
 * GitHub, che le appende alla voce), con un <br>.
 */
const beta2Html = (md: string): string => {
  const out: string[] = []
  let para: string[] = []
  let items: string[] = []
  const flushPara = (): void => {
    if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = [] }
  }
  const flushItems = (): void => {
    if (items.length) { out.push(`<ul>${items.join('')}</ul>`); items = [] }
  }
  for (const line of md.split('\n')) {
    if (/^###\s/.test(line)) {
      flushPara(); flushItems()
      out.push(`<h3>${line.replace(/^###\s*/, '')}</h3>`)
    } else if (/^[-*]\s/.test(line)) {
      flushPara()
      items.push(`<li>${line.replace(/^[-*]\s*/, '')}</li>`)
    } else if (line.trim() === '') {
      flushPara(); flushItems()
    } else if (items.length) {
      items[items.length - 1] = items[items.length - 1]!.replace(/<\/li>$/, `<br>${line}</li>`)
    } else {
      para.push(line)
    }
  }
  flushPara(); flushItems()
  return out.join('\n')
}

const BETA2_HTML = beta2Html(BETA2_MD).replace(/Correzioni e ritocchi/g, 'Correzioni &amp; ritocchi')

describe('RW5: htmlToPlainText — l\'HTML delle note diventa testo leggibile', () => {
  it('niente tag: <li> → «• », a capo su </p>/</li>/<br> e titoli, via tutto il resto', () => {
    const t = htmlToPlainText('<h3>Aggiornamenti</h3><p>Riga uno<br>Riga due</p><ul><li>voce prima</li><li>voce seconda</li></ul><p><strong>Importante:</strong> &amp; compagnie</p>')
    expect(t).not.toMatch(/<[a-z]/i)
    expect(t).toContain('• voce prima')
    expect(t).toContain('• voce seconda')
    expect(t).toContain('\nRiga due')
    expect(t).toContain('Importante: & compagnie')
    // il titolo va a capo
    expect(t.indexOf('Aggiornamenti')).toBeLessThan(t.indexOf('Riga uno'))
    expect(t).toContain('\n')
  })

  it('le entità si decodificano (&amp; &lt; &gt; &quot; &#39; &nbsp;), MAI prima dei tag', () => {
    const t = htmlToPlainText('<p>a &amp; b</p><p>&lt;script&gt; resta testo &quot;vero&quot; &#39;così&#39; x&nbsp;y</p>')
    expect(t).toContain('a & b')
    expect(t).toContain('<script> resta testo "vero" \'così\' x y')
    // &lt;p&gt; decodificato DOPO lo strip dei tag resta TESTO, non diventa un tag
    expect(t).not.toMatch(/<\/?p>/)
  })

  it('le righe vuote multiple si riducono a una', () => {
    expect(htmlToPlainText('<p>a</p><br><br><br><br><p>b</p>')).toBe('a\n\nb')
  })

  it('l\'HTML VERO della beta.2 (dal CHANGELOG, convertitore della CI): pulito e con i puntini', () => {
    const t = htmlToPlainText(BETA2_HTML)
    expect(t).not.toMatch(/<\/?(p|li|ul|h3|br|strong)\b/i)
    expect(t).toContain('• ')
    expect(t).toContain('Correzioni & ritocchi')
    expect(t).toContain('Una sola ✕')
  })
})

describe('RW5: releaseNotesText — il taglio oltre ~1500 caratteri', () => {
  it('il testo corto passa intero', () => {
    expect(releaseNotesText('<p>corto</p>', NOTES_MORE)).toBe('corto')
  })

  it('il lungo si taglia a fine VOCE INTERA, con «…» e l\'invito ad aprire le note', () => {
    const long = Array.from({ length: 80 }, (_, i) => `<li>voce numero ${i} della lista</li>`).join('')
    const t = releaseNotesText(`<p>Aggiornamenti</p><ul>${long}</ul>`, NOTES_MORE)
    expect(t.length).toBeLessThanOrEqual(RELEASE_NOTES_MAX_CHARS + 60)
    expect(t).toContain('…')
    expect(t).toContain('Apri le note')
    // la voce tagliata a metà NON resta: finisce a fine voce
    const lines = t.split('\n')
    const lastVoice = lines[lines.indexOf('…') - 1] ?? ''
    expect(lastVoice).toMatch(/^• voce numero \d+ della lista$/)
  })

  it('le note VERE della beta.2 (lunghe) si tagliano a fine voce, con l\'invito', () => {
    const t = releaseNotesText(BETA2_HTML, NOTES_MORE)
    expect(t.length).toBeGreaterThan(RELEASE_NOTES_MAX_CHARS - 300)
    expect(t).toContain('…')
    expect(t).toContain('Apri le note')
    // il taglio finisce a fine VOCE: l'ultima riga prima dei puntini è una
    // riga INTERA del changelog (continuazioni comprese), non una frase mozzata
    const cutLine = t.split('\n').lastIndexOf('…')
    const beforeDots = t.split('\n').slice(0, cutLine).pop() ?? ''
    const mdLines = BETA2_MD.split('\n').map((l: string) => l.replace(/^[-*]\s*/, '').replace(/^###\s*/, ''))
    expect(beforeDots.length, `riga sospetta: «${beforeDots}»`).toBeGreaterThan(3)
    expect(
      mdLines.some((l: string) => l === beforeDots || l.endsWith(beforeDots)),
      `riga mozzata: ${beforeDots.slice(-60)}`
    ).toBe(true)
  })

  it('B1: l\'HTML VERO della beta.3 (fixture dal feed atom) — voci intere, ≤ 12 righe prima del taglio', () => {
    const BETA3_HTML = readFileSync(join(import.meta.dirname, 'fixtures', 'release-notes-beta3.html'), 'utf8')
    const t = releaseNotesText(BETA3_HTML, NOTES_MORE)
    // il testo della beta.3 resta lungo: si taglia, con l'invito
    expect(t).toContain('…')
    expect(t).toContain(NOTES_MORE)
    const plain = htmlToPlainText(BETA3_HTML)
    expect(plain).not.toMatch(/</)
    // NESSUNA riga vuota tra i pezzi di una stessa voce: ogni <li> è UNA riga,
    // e dopo una voce viene o vuoto, o un titolo, o un'altra voce — mai il
    // resto della frase
    const lines = plain.split('\n')
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i - 1]!.startsWith('• ')) continue
      expect(lines[i], `frase mozzata dopo «…${lines[i - 1]!.slice(-40)}»`).toMatch(/^• |^$|^#/)
    }
    // il taglio lascia al massimo 12 righe (i bottoni del dialogo vecchio
    // devono stare in finestra; ora l'area scorre, ma il testo resta compatto).
    // Il taglio è la riga «…» DA SOLA: il testo contiene già ellissi letterali
    // («È disponibile Homun…»), non valgono
    const cutLine = t.split('\n').indexOf('…')
    expect(cutLine, 'manca la riga del taglio «…»').toBeGreaterThan(0)
    expect(t.split('\n').slice(0, cutLine).length).toBeLessThanOrEqual(12)
    // e nessun pezzo di voce spezzato: le righe piene prima del taglio finiscono col punto
    for (const l of t.split('\n').slice(0, cutLine)) {
      if (l.startsWith('• ')) expect(l, `voce mozzata: «${l.slice(-50)}»`).toMatch(/[.!»)]$/)
    }
  })
})
