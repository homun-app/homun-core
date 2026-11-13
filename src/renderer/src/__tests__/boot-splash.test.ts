// OBV6.2 (fase onboarding-b-dal-vivo): lo splash DIVENTA deterministico per
// la sonda. Dal vivo il controllo G8-1a («splash visto») cadeva 2 volte su 3
// perché lo splash dura pochissimo: una gara di tempi, non un difetto del
// prodotto. Al mount BootSplash mette un MARCATORE che RESTA
// (document.documentElement.dataset.bootSplashSeen = '1'): la sonda legge
// quello. (Il render dei test è lato server, senza DOM: qui la guardia sul
// sorgente, il marcatore lo prova la sonda con l'app vera.)
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const APP_SRC = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8')

describe('OBV6: il marcatore dello splash (deterministico per la sonda)', () => {
  it('BootSplash al mount scrive dataset.bootSplashSeen su documentElement — e resta', () => {
    expect(APP_SRC).toContain("document.documentElement.dataset.bootSplashSeen = '1'")
    // è DENTRO BootSplash, in un useEffect al mount (non altrove)
    expect(APP_SRC).toMatch(/function BootSplash\(\) \{[\s\S]*?useEffect[\s\S]*?dataset\.bootSplashSeen = '1'[\s\S]*?\n\}/)
  })
})
