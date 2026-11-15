// MB5 (fase modalita-box): la guardia contro la SEMINA. La sonda della
// modalità (scripts/fase-modalita-box-probe.mjs) parte da una cartella dati
// VUOTA e NON scrive MAI sandbox.mode — né una riga del DB, né setSetting,
// né env: se lo facesse, la sonda mostrerebbe verde anche senza che sia
// L'APP a registrare la scelta, e il difetto della beta.5 (nessun codice di
// produzione scriveva sandbox.mode) resterebbe nascosto — come è restato
// nascosto dalle sonde di prima, che tutte partivano con la modalità già
// seminata per conto loro. Grep mirato sul file della sonda: le LETTURE (per
// le asserzioni) restano libere, le SCRITTURE no.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PROBE = readFileSync(fileURLToPath(new URL('../fase-modalita-box-probe.mjs', import.meta.url)), 'utf8')

describe('MB5: la sonda della modalità NON semina sandbox.mode (guardia sul sorgente)', () => {
  it('la sonda ESISTE (la guardia senza sonda non guarda niente)', () => {
    expect(PROBE.length).toBeGreaterThan(1000)
  })

  it('NESSUNA scrittura nel DB: né INSERT/REPLACE con sandbox.mode, né un .run che la semina', () => {
    expect(PROBE).not.toMatch(/INSERT[^;\n]*sandbox\.mode/)
    expect(PROBE).not.toMatch(/REPLACE[^;\n]*sandbox\.mode/)
    expect(PROBE).not.toMatch(/sandbox\.mode['"]?\s*,\s*['"`](box|host|docker)/)
  })

  it('NESSUN setSetting / settingsSet di sandbox.mode (né dal daemon né via window.sandbot)', () => {
    expect(PROBE).not.toMatch(/setSetting\(\s*['"`]sandbox\.mode/)
    expect(PROBE).not.toMatch(/settingsSet\(\s*['"`]sandbox\.mode/)
  })
})
