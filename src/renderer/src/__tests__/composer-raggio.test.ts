// M1 (fase beta12-correzioni): il box di scrittura NON si deforma con un
// testo lungo — a UNA riga resta la pillola di oggi (rounded-full), da due
// righe in su il form passa a rounded-3xl (angoli da 24 px) e la barra di
// scorrimento del textarea sta dentro un margine interno, senza toccare il
// bordo arrotondato. I bottoni restano in basso (items-end, già vero) e il
// passaggio non salta: transizione del raggio ≤ 150 ms, oppure nessuna.
// Vale per il composer di Chat.tsx E quello di TeamChat.tsx.
// Senza DOM (niente jsdom): la logica pura si testa qui (la misura VERA di
// scrollHeight la fa il componente con il suo ref; le guardie verificano che
// la usi) e la cattura a 40 righe incollate la fa la sonda via CDP.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { composerFormRadius, composerMultiFromMeasure } from '../lib/composer'

const CHAT = fileURLToPath(new URL('../components/Chat.tsx', import.meta.url))
const TEAM = fileURLToPath(new URL('../components/TeamChat.tsx', import.meta.url))

/** Il blocco del compositore di un file: dal <form alla chiusura </form>. */
function composerBlock(path: string): string {
  const src = readFileSync(path, 'utf8')
  const start = src.indexOf('<form')
  if (start < 0) throw new Error(`form del compositore non trovato in ${path}`)
  const end = src.indexOf('</form>', start)
  return src.slice(start, end)
}

describe('M1: il raggio del compositore (pura)', () => {
  it('una riga → pillola; due o più righe → angoli da 24 px', () => {
    expect(composerFormRadius(false)).toBe('rounded-full')
    expect(composerFormRadius(true)).toBe('rounded-3xl')
  })

  it('la misura: scrollHeight oltre la riga unica = più righe (a capo E testo lungo senza a capo)', () => {
    // una riga sola (36 px visibili, niente oltre): pillola
    expect(composerMultiFromMeasure(36, 36)).toBe(false)
    // due righe esplicite (\n): il contenuto supera la riga unica
    expect(composerMultiFromMeasure(56, 36)).toBe(true)
    // testo lungo senza a capo che va a capo da solo: stessa misura
    expect(composerMultiFromMeasure(58, 36)).toBe(true)
    // la soglia tollera l'arrotondamento del subpixel (≤ 2 px), niente di più
    expect(composerMultiFromMeasure(37, 36)).toBe(false)
    expect(composerMultiFromMeasure(39, 36)).toBe(true)
  })
})

describe('M1: Chat.tsx usa il raggio dinamico', () => {
  const block = composerBlock(CHAT)

  it('il form NON ha un rounded-* fisso: il raggio arriva da composerFormRadius', () => {
    const formTag = block.slice(0, block.indexOf('>'))
    expect(formTag).not.toMatch(/rounded-(full|3xl)/)
    expect(formTag).toContain('composerFormRadius(')
  })

  it('la misura vera: il textarea si misura (scrollHeight contro la riga unica) a ogni cambio del testo', () => {
    const src = readFileSync(CHAT, 'utf8')
    expect(src).toContain('composerMultiFromMeasure(')
    expect(src).toMatch(/scrollHeight/)
    expect(src).toContain('CHAT_COMPOSER_SINGLE_ROW_PX')
  })

  it('la barra di scorrimento sta dentro un margine interno (pr-5 sul textarea quando cresce)', () => {
    const at = block.indexOf('<textarea')
    const ta = block.slice(at, block.indexOf('/>', at))
    expect(ta).toContain('pr-5')
  })

  it('il passaggio non salta: transizione SOLO del raggio, ≤ 150 ms', () => {
    const formTag = block.slice(0, block.indexOf('>'))
    expect(formTag).toMatch(/transition-\[border-radius\]/)
    const m = /duration-(\d+)/.exec(formTag)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThanOrEqual(150)
  })

  it('i bottoni restano allineati in basso: il form è items-end', () => {
    const formTag = block.slice(0, block.indexOf('>'))
    expect(formTag).toContain('items-end')
  })
})

describe('M1: TeamChat.tsx allineato allo stesso comportamento', () => {
  const block = composerBlock(TEAM)

  it('il form NON ha un rounded-* fisso: il raggio arriva da composerFormRadius', () => {
    const formTag = block.slice(0, block.indexOf('>'))
    expect(formTag).not.toMatch(/rounded-(full|3xl)/)
    expect(formTag).toContain('composerFormRadius(')
  })

  it('la misura vera e il margine interno della barra di scorrimento', () => {
    const src = readFileSync(TEAM, 'utf8')
    expect(src).toContain('composerMultiFromMeasure(')
    expect(src).toContain('TEAM_COMPOSER_SINGLE_ROW_PX')
    const at = block.indexOf('<textarea')
    const ta = block.slice(at, block.indexOf('/>', at))
    expect(ta).toContain('pr-5')
  })

  it('il passaggio non salta: transizione SOLO del raggio, ≤ 150 ms', () => {
    const formTag = block.slice(0, block.indexOf('>'))
    expect(formTag).toMatch(/transition-\[border-radius\]/)
    const m = /duration-(\d+)/.exec(formTag)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThanOrEqual(150)
  })
})

// Passata di design (beta.13): da due righe il campo va a tutta larghezza e i
// bottoni scendono sotto; l'isteresi evita l'altalena al limite della riga.
import { nextComposerMulti, composerLayout } from '../lib/composer'

describe('composer a più righe: layout e isteresi', () => {
  it('a una riga nessuna classe; a più righe campo sopra a tutta larghezza e bottoni sotto', () => {
    expect(composerLayout(false)).toEqual({ form: '', field: '', push: '' })
    expect(composerLayout(true)).toEqual({ form: 'flex-wrap', field: 'order-first basis-full', push: 'ml-auto' })
  })
  it('entra in «più righe» con la misura o con un a capo, e ricorda la lunghezza', () => {
    const zero = { multi: false, enteredAt: 0 }
    expect(nextComposerMulti(zero, 'ciao', false)).toEqual(zero)
    expect(nextComposerMulti(zero, 'a'.repeat(80), true)).toEqual({ multi: true, enteredAt: 80 })
    expect(nextComposerMulti(zero, 'riga 1\nriga 2', false).multi).toBe(true)
  })
  it('non torna indietro appena il campo largo fa stare il testo su una riga (niente altalena)', () => {
    const multi = { multi: true, enteredAt: 80 }
    expect(nextComposerMulti(multi, 'a'.repeat(80), false)).toEqual(multi)
    expect(nextComposerMulti(multi, 'a'.repeat(75), false)).toEqual(multi)
  })
  it('torna a una riga quando il testo si accorcia davvero, o si svuota', () => {
    const multi = { multi: true, enteredAt: 80 }
    expect(nextComposerMulti(multi, 'a'.repeat(60), false)).toEqual({ multi: false, enteredAt: 0 })
    expect(nextComposerMulti(multi, '', false)).toEqual({ multi: false, enteredAt: 0 })
    expect(nextComposerMulti(multi, 'riga\nriga', false)).toEqual(multi)
  })
})
