// F3 (fase fondamenta): l'aiutante COMUNE delle guardie sul sorgente — una
// sola funzione per scorrere i file di una cartella del repo (preso dal
// modello di src/renderer/src/__tests__/design-scan.ts: readdir ricorsivo
// con filtro sui suffissi). Ogni guardia in questa cartella lo usa: il
// sorgente si legge UNA volta e le regole restano nel file della guardia.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RADICE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export interface FileSorgente {
  /** il percorso relativo alla radice del repo */
  rel: string
  testo: string
}

/** I file di `dir` (relativa alla radice del repo) con i suffissi scelti, ricorsivi, con il loro testo. */
export const leggiSorgenti = (dir: string, suffissi: readonly string[], { escludi = [] as readonly string[] } = {}): FileSorgente[] => {
  const out: FileSorgente[] = []
  const pieno = join(RADICE, dir)
  const scasi = (d: string): void => {
    let voci: string[] = []
    try { voci = readdirSync(d) } catch { return }
    for (const nome of voci.sort()) {
      const p = join(d, nome)
      const rel = p.slice(RADICE.length + 1)
      if (escludi.some((e) => rel.includes(e) || nome === e)) continue
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { scasi(p); continue }
      if (!suffissi.some((s) => nome.endsWith(s))) continue
      try { out.push({ rel, testo: readFileSync(p, 'utf8') }) } catch { /* illeggibile: salta */ }
    }
  }
  scasi(pieno)
  return out
}
