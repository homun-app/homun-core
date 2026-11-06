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

  it('il textarea a una riga è alto quanto i bottoni: min-h-9, padding py-2 che centra una riga da 20 px (leading-5)', () => {
    const block = composerBlock()
    const at = block.indexOf('<textarea')
    const ta = block.slice(at, block.indexOf('/>', at))
    expect(ta).toContain('min-h-9')
    expect(ta).toContain('py-2')
    expect(ta).toContain('leading-5')
    expect(ta).not.toContain('min-h-11')
    expect(ta).not.toContain('py-2.5')
  })

  it('i bottoni non cambiano: graffetta e Ragiona size-9/h-9, Invia size-10', () => {
    const block = composerBlock()
    expect(block).toMatch(/grid size-9 shrink-0 place-items-center rounded-full bg-muted\/60/)   // graffetta
    expect(block).toMatch(/grid h-9 shrink-0 place-items-center rounded-full px-3/)              // Ragiona
    expect((block.match(/size-10 shrink-0/g) ?? []).length).toBeGreaterThanOrEqual(1)            // Invia/Ferma
  })
})
