// F3 (fase fondamenta): GUARDIA — nessuna MISURA CRUDA nelle classi del
// renderer: altezze, posizioni e larghezze con px arbitrario nelle classi
// (h-[52px], min-h-[44px], top-[13px]…) fuori dalle eccezioni. Il DESIGN.md
// (F4) e i token di styles.css decidono le misure; una misura scritta a mano
// nelle classi sfugge a design-guard, che vieta le spaziature e le larghezze
// w-[..px] ma non le ALTEZZE e le posizioni: qui si chiude quel buco.
// Vista ROSSA prima: GuideModelStep (la guida) ha min-h-[44px]/min-h-[124px]
// nati con la fase guida — in allowlist col loro motivo (toccarli ora cambierebbe
// il build della fase: i valori sono voluti e visivamente stabili).
import { describe, it, expect } from 'vitest'
import { leggiSorgenti } from './sorgenti'

const file = leggiSorgenti('src/renderer/src', ['.tsx'], { escludi: ['__tests__'] })

/** Le misure crude: un valore px dentro una classe di dimensione/posizione. */
const CRUDO = /\b(?:h|min-h|max-h|w|max-w|min-w|size|top|bottom|left|right|inset|basis)-\[\d+(?:\.\d+)?px\]/g

/** Le eccezioni, ognuna col motivo: file che oggi portano misure volute. */
const ECCEZIONI: ReadonlyArray<{ file: string; perché: string }> = [
  {
    file: 'src/renderer/src/components/GuideModelStep.tsx',
    perché: 'le misure della guida (min-h-[44px] le pillole dei modelli, min-h-[124px] la card, min-h-[36px] il «Altro») sono volute della fase guida: nessun token le copre, ritoccarle ora tocca il build della fase senza cambiare ciò che l\'utente vede — lista della prossima fase'
  },
  {
    file: 'src/renderer/src/components/GuideComputerStep.tsx',
    perché: 'le stesse min-h-[44px] della guida (i passi del computer): stessa ragione'
  },
  {
    file: 'src/renderer/src/components/guide-model-pills.tsx',
    perché: 'le pillole dei modelli della guida (min-h-[44px]): C0 della fase linguaggio le ha estratte da GuideModelStep in un file loro — la misura è la stessa, voluta della fase guida'
  },
  {
    file: 'src/renderer/src/components/GuideView.tsx',
    perché: 'le misure della guida (top-[62px] la fascia del passo, size-[34px]/size-[30px] gli anelli dei passi, min-h-[44px] le pillole): volute della fase guida — stessa ragione'
  }
]

describe('nessuna misura cruda (px arbitrario) nelle classi del renderer', () => {
  it('nessun h-[..px], min-h-[..px], top-[..px]… fuori dalle eccezioni', () => {
    const violazioni: string[] = []
    for (const { rel, testo } of file) {
      if (ECCEZIONI.some((e) => e.file === rel)) continue
      for (const m of testo.matchAll(CRUDO)) violazioni.push(`${rel}: ${m[0]}`)
    }
    expect(violazioni).toEqual([])
  })
})
