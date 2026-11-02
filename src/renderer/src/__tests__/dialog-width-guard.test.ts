// Fase rilascio (P0.3): la guardia contro la ricaduta sulle finestre di
// dialogo. La BASE di DialogContent (src/renderer/src/components/ui/dialog.tsx)
// deve il suo default di larghezza a `max-w-[min(32rem,calc(100%-2rem))]`
// SENZA variante `sm:` — con `sm:max-w-lg` nella base qualunque max-w passato
// dai chiamanti perdeva la gara sopra i 640 px di finestra (le Impostazioni
// restavano larghe 512 px) e tailwind-merge non li considera in conflitto.
// La colonna della griglia dev'essere `grid-cols-[minmax(0,1fr)]`: senza il
// minimo 0 la colonna prenderebbe la larghezza minima del contenuto e il
// dialogo «Nuovo bot» sforerebbe in orizzontale. Senza DOM (niente jsdom):
// si legge il sorgente, come le altre guardie del renderer.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIALOG = fileURLToPath(new URL('../components/ui/dialog.tsx', import.meta.url))

function baseClasses(): string {
  const src = readFileSync(DIALOG, 'utf8')
  // la lista di classi della base è la stringa passata a cn(...) che contiene
  // le classi fisse del DialogContent (l'unica con 'fixed top-[50%]')
  const m = /'([^']*fixed top-\[50\%\][^']*)'/.exec(src)
  if (!m) throw new Error('base del DialogContent non trovata in dialog.tsx')
  return m[1]!
}

describe('guardia larghezza della base del dialog (fase rilascio P0)', () => {
  it('la base non contiene alcun max-w con variante sm: (vince sui chiamanti)', () => {
    expect(baseClasses()).not.toMatch(/(^|\s)sm:max-w-/)
  })

  it('la base restringe la colonna della griglia con minmax(0,1fr)', () => {
    expect(baseClasses()).toContain('grid-cols-[minmax(0,1fr)]')
  })

  it('la base ha un default di larghezza che non sfora la finestra', () => {
    expect(baseClasses()).toContain('max-w-[min(32rem,calc(100%-2rem))]')
  })
})
