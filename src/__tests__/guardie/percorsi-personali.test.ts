// F3 (fase fondamenta): GUARDIA — nessun percorso personale nel sorgente.
// In src/ e scripts/ nessun `/Users/` seguito da un nome diverso da `test`:
// i percorsi nelle fixture e nei test sono NEUTRI (l'appRoot di OBV1 è
// /Users/test/…), e un percorso della macchina vera NON può stare nel repo
// (esce la home di chi scrive; i percorsi costruiti usano os.homedir()).
// Vista ROSSA sulla base: a HEAD 20 file portavano /Users/fabio, /Users/prova
// e /Users/x — corretti in /Users/test (i test) o costruiti da os.homedir()
// (scripts/copia-fixture-container-1.7.1.mjs). REPORT.md NON si tocca: la
// guardia non lo legge.
import { describe, it, expect } from 'vitest'
import { leggiSorgenti } from './sorgenti'

/** Il nome dopo /Users/ che la guardia ammette: solo l'appRoot neutro. */
const AMMESSO = 'test'
// /Users/…/ nei COMMENTI come segnaposto (il nome non è mai un nome reale)
const SEGNAPOSTO = '…'

const file = [
  ...leggiSorgenti('src', ['.ts', '.tsx', '.mjs'], { escludi: ['__tests__/fixtures'] }),
  ...leggiSorgenti('scripts', ['.mjs', '.ts'], { escludi: ['vetrina'] })
]

/** Le eccezioni, ognuna col motivo. */
const ECCEZIONI: ReadonlyArray<{ file: string; perché: string }> = [
  {
    file: 'scripts/copia-fixture-container-1.7.1.mjs',
    perché: 'lo script RIPULISCE le fixture (i file portano la radice del vecchio Mac — non sono sorgente): la radice da sostituire è scritta letterale perché è il FORMATO dei file che legge'
  },
  {
    file: 'src/__tests__/guardie/percorsi-personali.test.ts',
    perché: 'la guardia porta i NOMI esclusi nel suo testo (la regola e il perché)'
  }
]

describe('nessun percorso personale nel sorgente', () => {
  it('nessun /Users/<nome> diverso da test (e mai la home di chi scrive)', () => {
    const violazioni: string[] = []
    for (const { rel, testo } of file) {
      if (ECCEZIONI.some((e) => e.file === rel)) continue
      for (const m of testo.matchAll(/\/Users\/([^/'"\s\\)\]}>]+)/g)) {
        if (m[1] !== AMMESSO && m[1] !== SEGNAPOSTO) violazioni.push(`${rel}: /Users/${m[1]}`)
      }
    }
    expect(violazioni).toEqual([])
  })
})
