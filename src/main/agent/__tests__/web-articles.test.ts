// Fase chat-limiti (CL1): l'estrattore tiene TUTTI gli <article> di un elenco,
// non solo il primo. Le fixture in ./fixtures/ sono SCRITTE A MANO (nessun
// download): un elenco stile annunci con 5 <article> (titolo, prezzo, città,
// link e immagine ciascuno), un articolo di giornale con UN solo <article> e
// la barra laterale, una pagina senza <article> né <main>.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from '../web-tools'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

/** La base dell'elenco (l'URL finale della pagina, come fa webFetch). */
const BASE = 'https://annunci.example.it/moto-usate/moto-guzzi-v7'

const TITOLI = [
  'Moto Guzzi V7 Special 2024',
  'Moto Guzzi V7 Stone 2023',
  'Moto Guzzi V7 III Racer 2019',
  'Moto Guzzi V7 Classic 2011',
  'Moto Guzzi V7 Special 2022'
]
const PREZZI = ['€ 8.900', '€ 7.400', '€ 8.100', '€ 5.900', '€ 8.450']
const CITTÀ = ['Milano (MI)', 'Torino (TO)', 'Bologna (BO)', 'Roma (RM)', 'Verona (VR)']
const LINK = [
  'https://annunci.example.it/moto-usate/v7-special-2024-milano.htm',
  'https://annunci.example.it/moto-usate/v7-stone-2023-torino.htm',
  'https://annunci.example.it/moto-usate/v7-iii-racer-2019-bologna.htm',
  'https://annunci.example.it/moto-usate/v7-classic-2011-roma.htm',
  'https://annunci.example.it/moto-usate/v7-special-2022-verona.htm'
]

describe('CL1: un elenco di <article> si tiene TUTTO (fixture scritte a mano)', () => {
  it('l\'elenco a 5 annunci → 5 titoli, 5 prezzi, 5 città e 5 link ASSOLUTI nel testo (oggi ne restava uno)', () => {
    const md = htmlToMarkdown(fixture('annunci-lista.html'), BASE)
    for (const t of TITOLI) expect(md).toContain(t)
    for (const p of PREZZI) expect(md).toContain(p)
    for (const c of CITTÀ) expect(md).toContain(c)
    // CL1.3: ogni elemento dell'elenco tiene il SUO link (il primo href
    // http(s) assoluto dentro l'elemento, risolto contro l'URL finale)
    for (const l of LINK) expect(md).toContain(`(${l})`)
    // gli annunci restano separati: 4 divisori tra 5 elementi
    expect(md.split('\n').filter((l) => l === '---')).toHaveLength(4)
    // il rumore della pagina (header, nav, sponsor, piè) non passa
    expect(md).not.toContain('Assicurazione moto')
    expect(md).not.toContain('© Annunci di prova')
    expect(md).not.toContain('window.__traccia')
  })

  it('GUARDIA: l\'articolo di giornale con UN solo <article> resta come oggi (titolo, corpo, niente barra laterale)', () => {
    const md = htmlToMarkdown(fixture('articolo-giornale.html'), 'https://gazzetta.example.it/moto-guzzi-v7-55-anni')
    expect(md).toContain('# La Moto Guzzi V7 compie 55 anni')
    expect(md).toContain('## Il motore che ha cambiato tutto')
    expect(md).toContain('1.043 cc')
    expect(md).toContain('una decina di moto al giorno')
    expect(md).not.toContain('Più letti')
    expect(md).not.toContain('Newsletter')
    expect(md).not.toContain('Ducati Scrambler')
  })

  it('GUARDIA: la pagina senza <article> né <main> si legge dal body come oggi', () => {
    const md = htmlToMarkdown(fixture('pagina-essenza-tag.html'))
    expect(md).toContain('# Museo della Moto di Mandello')
    expect(md).toContain('dalle 10 alle 17')
    expect(md).toContain('- Via Parodi 5, Mandello del Lario')
    expect(md).toContain('Pagina senza articoli né main')
  })
})
