// AH7 (fase aiutanti): la guardia della sonda. La sonda
// (scripts/fase-aiutanti-probe.mjs) mette la modalità HOST con la RPC
// box:mode-set (la scelta delle Impostazioni), MAI con una scrittura diretta
// nel DB; non chiama container né Docker (il motore vero è installato su
// questo Mac e i vincoli della fase lo vietano); i comandi del copione sono
// echo innocui nella cartella temporanea della sonda. Grep mirato sul file:
// le LETTURE (per le asserzioni) restano libere, le SCRITTURE no.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PROBE = readFileSync(fileURLToPath(new URL('../fase-aiutanti-probe.mjs', import.meta.url)), 'utf8')

describe('AH7: la sonda degli aiutanti usa le strade giuste (guardia sul sorgente)', () => {
  it('la sonda ESISTE (la guardia senza sonda non guarda niente)', () => {
    expect(PROBE.length).toBeGreaterThan(1000)
  })

  it('la modalità passa dalla RPC box:mode-set, MAI da una scrittura del DB', () => {
    expect(PROBE).toContain('boxModeSet("host")')
    expect(PROBE).not.toMatch(/INSERT[^;\n]*sandbox\.mode/)
    expect(PROBE).not.toMatch(/REPLACE[^;\n]*sandbox\.mode/)
    expect(PROBE).not.toMatch(/setSetting\(\s*['"`]sandbox\.mode/)
    expect(PROBE).not.toMatch(/settingsSet\(\s*['"`]sandbox\.mode/)
  })

  it('NESSUNA chiamata a container né a Docker (solo l\'app e il suo daemon)', () => {
    expect(PROBE).not.toMatch(/spawn\(\s*['"`]container/)
    expect(PROBE).not.toMatch(/execFile\S*\(\s*['"`]container/)
    expect(PROBE).not.toMatch(/spawn\(\s*['"`]docker/)
    expect(PROBE).not.toMatch(/['"`]container['"`]\s*,\s*\[/)
  })

  it('i comandi del copione sono echo innocui, senza rete né percorsi fuori dalla temporanea', () => {
    const echos = [...PROBE.matchAll(/const ECHO\d = '([^']+)'/g)].map((m) => m[1]!)
    expect(echos.length).toBe(2)
    for (const c of echos) {
      expect(c.startsWith('echo ')).toBe(true)
      expect(c).not.toMatch(/\b(curl|wget|rm|sudo|osascript|open)\b/)
    }
    // il copione usa SOLO quelle costanti come command
    expect(PROBE).toMatch(/command: ECHO1/)
    expect(PROBE).toMatch(/command: ECHO2/)
  })
})
