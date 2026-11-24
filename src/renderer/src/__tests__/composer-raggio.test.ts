// M1 (fase beta12-correzioni): il box di scrittura NON si deforma con un
// testo lungo. Allora: a UNA riga la pillola (rounded-full), da due righe in
// su il form passava a rounded-3xl (angoli da 24 px) con una transizione del
// raggio; il textarea si misura (scrollHeight contro l'altezza della riga
// unica) e la barra di scorrimento sta dentro un margine interno.
// Vale per il composer di Chat.tsx E quello di TeamChat.tsx.
//
// Fase design (DS4): IL RAGGIO DINAMICO NON C'È PIÙ. I raggi sono tre (DS1) e
// il campo di scrittura è una superficie (rounded-surface) a una riga come a
// dieci: composerFormRadius è uscito da lib/composer.ts, e quel che M1
// voleva — che la barra del textarea non toccasse un angolo troppo tondo —
// lo garantisce il raggio piccolo (14) a ogni altezza. RESTANO la MISURA
// vera (la fa il componente col suo ref: qui se ne prova la logica pura e
// le guardie verificano che la usi) e il LAYOUT a più righe (in fondo).
// Senza DOM (niente jsdom); la cattura a 40 righe incollate la fa la sonda
// via CDP.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { composerMultiFromMeasure } from '../lib/composer'

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

/** Il tag di apertura del form: fino al primo «>» dopo le classi. */
function formTagOf(block: string): string {
  // le classi sono in un template literal: il tag finisce al «>» che chiude il form
  return block.slice(0, block.indexOf('onSubmit'))
}

describe('M1: la misura (pura)', () => {
  it('scrollHeight oltre la riga unica = più righe (a capo E testo lungo senza a capo)', () => {
    // una riga sola (36 px visibili, niente oltre)
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

/** Le guardie di DS4 sul form di un compositore: una superficie, sempre, e la misura vera. */
function guardieSuperficie(dove: string, path: string): void {
  const block = composerBlock(path)
  const src = readFileSync(path, 'utf8')
  const formTag = formTagOf(block)

  it(`${dove}: il form è una superficie (rounded-surface) a una riga come a dieci — niente raggio dinamico`, () => {
    expect(formTag).toContain('rounded-surface')
    expect(formTag).not.toMatch(/rounded-(full|3xl|2xl|xl|control)/)
    expect(src).not.toContain('composerFormRadius(')
  })

  it(`${dove}: niente transizione del raggio (il raggio non cambia più)`, () => {
    expect(formTag).not.toMatch(/transition-\[border-radius\]/)
  })

  it(`${dove}: la barra di scorrimento sta dentro un margine interno (pr-5 sul textarea)`, () => {
    const at = block.indexOf('<textarea')
    const ta = block.slice(at, block.indexOf('/>', at))
    expect(ta).toContain('pr-5')
  })

  it(`${dove}: il campo è alto quanto i controlli a una riga (min-h-control, 36) e mai sotto i 120 px (min-w-30)`, () => {
    const at = block.indexOf('<textarea')
    const ta = block.slice(at, block.indexOf('/>', at))
    expect(ta).toContain('min-h-control')
    expect(ta).toContain('min-w-30')
    expect(ta).not.toMatch(/min-h-11/)
  })

  it(`${dove}: la misura vera — il textarea si misura (scrollHeight contro la riga unica) a ogni cambio del testo`, () => {
    expect(src).toContain('composerMultiFromMeasure(')
    expect(src).toMatch(/scrollHeight/)
    expect(src).toMatch(/_COMPOSER_SINGLE_ROW_PX/)
  })

  it(`${dove}: i bottoni restano allineati in basso (il form è items-end) e sono quelli del sistema (Button)`, () => {
    expect(formTag).toContain('items-end')
    expect(block).toContain('<Button')
  })
}

describe('DS4: il compositore di Chat.tsx', () => { guardieSuperficie('Chat', CHAT) })
describe('DS4: il compositore di TeamChat.tsx, lo stesso', () => { guardieSuperficie('TeamChat', TEAM) })

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
