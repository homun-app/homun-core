// Fase SFOGLIA VELOCE (V3): il compositore allineato — il testo e il
// segnaposto del textarea stanno sulla stessa linea centrale dei bottoni
// (graffetta, Ragiona, Invia) quando il campo è di una riga; col testo a
// capo il campo cresce verso l'alto e i bottoni restano in basso (il form
// resta items-end). Senza DOM: si legge il sorgente; la misura VERA (≤ 2 px
// sul centro) la fa la sonda scripts/fase-skill-sfoglia-probe.mjs.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CHAT = fileURLToPath(new URL('../components/Chat.tsx', import.meta.url))
const src = readFileSync(CHAT, 'utf8')

/** Il blocco del compositore: dal <form> della pillola alla chiusura. */
function composerBlock(): string {
  const start = src.indexOf('<form')
  if (start < 0) throw new Error('form del compositore non trovato')
  const end = src.indexOf('</form>', start)
  return src.slice(start, end)
}

describe('V3: il compositore allineato', () => {
  it('il form resta items-end (col testo a capo i bottoni restano in basso)', () => {
    const form = src.slice(src.indexOf('<form'), src.indexOf('>', src.indexOf('<form')))
    expect(form).toContain('items-end')
  })

  // Fase design (DS4): le misure sono quelle di DS1 — il campo è un controllo (36 px: min-h-control) e la sua riga
  // da 20 px è l'interlinea che text-body porta con sé (prima min-h-9 e leading-5 scritti a mano)
  it('il textarea a una riga è alto quanto i bottoni: min-h-control (36), padding py-2 che centra la riga da 20 px di text-body', () => {
    const block = composerBlock()
    const at = block.indexOf('<textarea')
    const ta = block.slice(at, block.indexOf('/>', at))
    expect(ta).toContain('min-h-control')
    expect(ta).toContain('py-2')
    expect(ta).toContain('text-body')
    expect(ta).not.toContain('leading-')
    expect(ta).not.toContain('min-h-11')
    expect(ta).not.toContain('py-2.5')
  })

  // Fase design (DS4): i controlli sono quelli del sistema (Button), non più <button> scritti a mano con
  // size-9 e size-10: la graffetta è un Button solo-icona da 32; «Ragiona» (il bottone del suo menu) e
  // Invia/Ferma portano le classi di Button da 36 (md), altezza del campo a una riga
  it('i bottoni sono quelli del sistema: graffetta da 32 (Button sm, solo icona), Ragiona e Invia/Ferma da 36 (Button md)', () => {
    const block = composerBlock()
    expect(block).toContain('<Paperclip className="size-4" />')                                   // graffetta: un Button solo-icona da 32
    expect(block).toMatch(/<Button\s+type="button"\s+variant="ghost"\s+size="sm"\s+icon/)
    expect(block).toMatch(/aria-label=\{t`Livello di ragionamento`\}/)                           // Ragiona: il bottone del suo menu
    expect(block).toContain("buttonVariants({ variant: 'ghost', size: 'md' })")                  // Ragiona: le classi di Button da 36
    expect(block).toMatch(/<Button type="submit" icon aria-label=\{t`Invia`\}/)                     // Invia: Button md (36), solo icona
    expect(block).toMatch(/<Button type="button" icon aria-label=\{t`Ferma`\}/)                     // Ferma: idem
    expect(block).not.toMatch(/size-(9|10)\b/)
  })
})
