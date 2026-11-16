// Fase chat-limiti (CL2): le immagini tengono l'INDIRIZZO. <img> diventa
// ![alt](url) con url ASSOLUTO http(s) risolto contro l'URL finale della
// pagina (come gli href, G3); si usa src, poi data-src, poi il primo URL di
// srcset; si scartano data:, i pixel di tracciamento (width/height ≤ 2) e le
// immagini senza url valido; massimo 20 per pagina, oltre una riga di conto.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from '../web-tools'

const BASE = 'https://annunci.example.it/moto-usate/moto-guzzi-v7'

describe('CL2: <img> diventa ![alt](url) ASSOLUTO (puro)', () => {
  it('src relativo → assoluto risolto contro la base (URL finale della pagina)', () => {
    const md = htmlToMarkdown(
      '<article><img src="/foto/v7-special.jpg" alt="V7 Special rossa" width="320" height="240"></article>',
      BASE
    )
    expect(md).toContain('![V7 Special rossa](https://annunci.example.it/foto/v7-special.jpg)')
  })

  it('data-src: senza src si usa il data-src (il lazy-load non perde l\'immagine)', () => {
    const md = htmlToMarkdown(
      '<article><img data-src="/foto/lazy.jpg" alt="differita" width="320" height="240"></article>',
      BASE
    )
    expect(md).toContain('![differita](https://annunci.example.it/foto/lazy.jpg)')
  })

  it('data-src: un src data: NON vale, si passa al data-src', () => {
    const md = htmlToMarkdown(
      '<article><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/foto/vera.jpg" alt="vera" width="320" height="240"></article>',
      BASE
    )
    expect(md).toContain('![vera](https://annunci.example.it/foto/vera.jpg)')
    expect(md).not.toContain('data:')
  })

  it('srcset: senza src e senza data-src si usa il PRIMO url del srcset', () => {
    const md = htmlToMarkdown(
      '<article><img srcset="/foto/piccola.jpg 320w, /foto/grande.jpg 640w" alt="insieme" width="320" height="240"></article>',
      BASE
    )
    expect(md).toContain('![insieme](https://annunci.example.it/foto/piccola.jpg)')
    expect(md).not.toContain('grande.jpg')
  })

  it('l\'ordine è src, poi data-src, poi srcset: src VINCE quando è valido', () => {
    const md = htmlToMarkdown(
      '<article><img src="/foto/a.jpg" data-src="/foto/b.jpg" srcset="/foto/c.jpg 2x" alt="tre" width="320" height="240"></article>',
      BASE
    )
    expect(md).toContain('![tre](https://annunci.example.it/foto/a.jpg)')
  })

  it('data: SCARTATO: un\'immagine senza url http(s) valido non compare affatto', () => {
    const md = htmlToMarkdown(
      '<article><p>testo</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="inline"></article>',
      BASE
    )
    expect(md).toContain('testo')
    expect(md).not.toContain('data:')
    expect(md).not.toContain('inline')
    expect(md).not.toContain('![')
  })

  it('pixel di tracciamento 1×1 SCARTATO (width o height ≤ 2)', () => {
    const md = htmlToMarkdown(
      '<article><p>testo</p><img src="https://traccia.example/pixel.gif" width="1" height="1" alt="traccia"><img src="https://traccia.example/px2.png" width="2" alt="anche due"></article>',
      BASE
    )
    expect(md).toContain('testo')
    expect(md).not.toContain('traccia.example')
    expect(md).not.toContain('![')
  })

  it('il tetto è 20 immagini per pagina: oltre, una riga di conto e niente url', () => {
    const imgs = Array.from({ length: 25 }, (_, i) => `<img src="/foto/f${i}.jpg" alt="foto ${i}" width="320" height="240">`).join('')
    const md = htmlToMarkdown(`<article><p>elenco</p>${imgs}</article>`, BASE)
    // le prime 20 nel testo, con l'indirizzo
    for (let i = 0; i < 20; i++) expect(md).toContain(`![foto ${i}](https://annunci.example.it/foto/f${i}.jpg)`)
    // la 21ª in poi NON c'è, e c'è la riga di conto
    expect(md).not.toContain('f20.jpg')
    expect(md).not.toContain('f24.jpg')
    expect(md).toContain('[5 more images]')
  })

  it('la fixture degli annunci: le 5 immagini del listing hanno l\'indirizzo assoluto', () => {
    const md = htmlToMarkdown(readFileSync(new URL('./fixtures/annunci-lista.html', import.meta.url), 'utf8'), BASE)
    expect(md).toContain('![Moto Guzzi V7 Special rossa](https://annunci.example.it/foto/v7-special-2024-milano.jpg)')
    expect(md).toContain('![Moto Guzzi V7 Stone nera](https://annunci.example.it/foto/v7-stone-2023-torino.jpg)')
    expect(md).toContain('![Moto Guzzi V7 Classic d\'epoca](https://annunci.example.it/foto/v7-classic-2011-roma.jpg)')
  })
})
