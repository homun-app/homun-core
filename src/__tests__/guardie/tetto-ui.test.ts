// C4 (fase linguaggio): IL TETTO. Fuori da components/ui/ non si disegna: le
// pagine si compongono con gli oggetti del catalogo. Convertire tutto in una
// fase non è realistico, così le violazioni si CONTANO e il numero può solo
// scendere: questo test confronta i numeri di oggi con il budget scritto in
// tetto-ui.json (per file e totale) e fallisce se un file SUPERA il suo
// numero o se compare un file NUOVO con violazioni. Ogni fase di
// conversione abbassa il tetto e aggiorna il json NELLO STESSO COMMIT (il
// test suggerisce i numeri nuovi).
//
// Cosa conta (nei .tsx fuori da components/ui/, galleria esclusa — la pagina
// dei componenti è demo di sviluppo e disegna apposta):
//   · i TAG scritti a mano: <button, <input, <select, <textarea;
//   · le classi VISIVE nei className/cn(...): colore, sfondo, bordo, raggio,
//     ombra, taglia del testo, margine interno, valori arbitrari […].
// Le classi di DISPOSIZIONE non contano: flex, grid, items-*, justify-*,
// gap-* dei token, posizione, overflow, w-full/min-w-0/flex-1, le misure
// (h-*, min-h-*, w-*) e le larghezze dei token.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { leggiSorgenti, RADICE } from './sorgenti'

/** I file contati: il renderer, senza il catalogo, senza i test, senza la pagina demo dei componenti. */
export const fileDelTetto = () =>
  leggiSorgenti('src/renderer/src', ['.tsx'], { escludi: ['components/ui/', '__tests__/', 'galleria/'] })

/** Le classi di SOLA disposizione (e misura), che non contano: chi le scrive sta disponendo, non disegnando. */
const DISPOSIZIONE = new Set([
  'flex', 'grid', 'contents', 'block', 'inline', 'inline-flex', 'hidden',
  'min-w-0', 'w-full', 'flex-1', 'shrink-0', 'grow', 'truncate', 'capitalize',
  'absolute', 'relative', 'fixed', 'sticky', 'inset-0', 'z-20', 'z-30', 'z-40', 'z-50',
  'overflow-hidden', 'overflow-auto', 'overflow-visible', 'overflow-x-auto', 'overflow-y-auto', 'overflow-x-hidden', 'overflow-y-hidden', 'overflow-scroll',
  'items-center', 'items-start', 'items-end', 'items-baseline', 'items-stretch',
  'justify-center', 'justify-between', 'justify-end', 'justify-start',
  'flex-col', 'flex-row', 'flex-wrap', 'flex-nowrap', 'flex-none',
  'place-items-center', 'self-start', 'self-end', 'table-fixed', 'text-left', 'text-right', 'tabular-nums'
])

/** Una classe è di disposiziione (o misura)? */
const èDisposizione = (cls: string): boolean => {
  if (DISPOSIZIONE.has(cls)) return true
  // le misure: altezze, larghezze minime di contenuto, le posizioni di stack
  if (/^(?:min-)?h-(?:control|control-sm|col-head|row|row-text|full|screen|auto)$/.test(cls)) return true
  if (/^(?:min-|max-)?w-(?:full|auto|fit|screen|min|max)$/.test(cls)) return true
  // gap dei token e della scala di Tailwind: DISTANZE, non disegno
  if (/^gap-(?:0(?:\.5)?|1|1\.5|2|3|4|5|6|8|10|12|16|block|section|section-head|row-gap)$/.test(cls)) return true
  // le posizioni scritte con la scala (top-, left-, inset-, z-…)
  if (/^(?:top|left|right|bottom|inset)-/.test(cls)) return true
  if (/^z-\d+$/.test(cls)) return true
  // lo scorrimento interno delle tabelle e i cursori
  if (/^scroll-thin$/.test(cls)) return true
  // i filetti strutturali di larghezza (border-t/border-b/border-x da soli: lo SPESSORE, non il colore)
  if (/^border(?:-(?:t|b|l|r|x|y))?$/.test(cls)) return true
  if (/^divide-(?:x|y)$/.test(cls)) return true
  return false
}

/** Le classi VISIVE di una stringa di classi: quelle che il catalogo deve possedere lui. */
export const classiVisive = (stringaClassi: string): string[] =>
  stringaClassi.split(/\s+/).filter(Boolean).filter((c) => !èDisposizione(c))

/** Il pezzo di classe che conta come VIOLAZIONE visiva: colore, bordo-color, raggio, ombra, taglia, respiro, arbitrario. */
const èVisiva = (cls: string): boolean => {
  // arbitrary […]: vietati sempre (le misure le decidono i token)
  if (/\[[^\]]+\]/.test(cls)) return true
  // colore e sfondo (anche con opacità /50) — compresi i colori del tema
  if (/^(?:bg|text|border|ring|outline|fill|stroke|divide|decoration|accent|caret|shadow)-[a-z]/.test(cls)) {
    // …ma lo SPESSORE del bordo (border-t e fratelli senza colore) e divide-x/y non contano
    if (!/^border(?:-(?:t|b|l|r|x|y|\d))?$/.test(cls) && !/^divide-(?:x|y)$/.test(cls)) return true
  }
  // il raggio e l'ombra
  if (/^rounded-/.test(cls)) return true
  if (/^shadow-/.test(cls)) return true
  // la taglia del testo (i sei token e le taglie di fabbrica)
  if (/^text-(?:caption|small|body|reading|title|page|xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)$/.test(cls)) return true
  // il margine interno (il respiro di un oggetto lo decide il catalogo)
  if (/^(?:p|px|py|pt|pb|pl|pr)-/.test(cls)) return true
  // i pesi e le trasformazioni del testo sono del catalogo (Text weight)
  if (/^font-(?:medium|semibold|bold|normal|light|thin|black|display|mono|sans)$/.test(cls)) return true
  return false
}

/** Le violazioni di un file: i tag scritti a mano e le classi visive nei className/cn(...). */
export const violazioniDi = (testo: string): number => {
  let n = 0
  // i TAG a mano (button, input, select, textarea)
  n += (testo.match(/<(?:button|input|select|textarea)\b/g) ?? []).length
  // le classi nei attributi className="…" e template `…` e dentro cn(…)
  for (const m of testo.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const cls = m[1] ?? m[2] ?? ''
    n += classiVisive(cls).filter(èVisiva).length
  }
  for (const m of testo.matchAll(/cn\(([^)]*)\)/g)) {
    for (const pezzo of (m[1] ?? '').matchAll(/'([^']*)'|"([^"]*)"/g)) {
      const cls = pezzo[1] ?? pezzo[2] ?? ''
      n += classiVisive(cls).filter(èVisiva).length
    }
  }
  return n
}

const tettoJson = JSON.parse(readFileSync(join(RADICE, 'src/__tests__/guardie/tetto-ui.json'), 'utf8')) as Record<string, number>

describe('C4: il tetto — fuori da components/ui/ non si disegna (e il numero può solo scendere)', () => {
  it('nessun file SUPERA il suo numero, nessun file NUOVO con violazioni, il totale non cresce', () => {
    const conti = new Map<string, number>()
    let totale = 0
    for (const f of fileDelTetto()) {
      const n = violazioniDi(f.testo)
      conti.set(f.rel, n)
      totale += n
    }
    const problemi: string[] = []
    for (const [file, n] of conti) {
      const budget = tettoJson[file]
      if (budget === undefined) {
        if (n > 0) problemi.push(`NUOVO ${file}: ${n} violazioni (non sta nel tetto: aggiungilo con il suo numero, o convertilo)`)
      } else if (n > budget) {
        problemi.push(`${file}: ${n} > ${budget} (il tetto si ABBASSA converting, non si alza)`)
      }
    }
    // i file nel json che non esistono più: il budget esce (il json si pulisce nello stesso commit)
    for (const file of Object.keys(tettoJson)) {
      if (file !== '__totale' && !conti.has(file)) problemi.push(`${file}: sta nel tetto ma il file non esiste più`)
    }
    const budgetTotale = tettoJson.__totale ?? 0
    if (totale > budgetTotale) problemi.push(`TOTALE ${totale} > ${budgetTotale}`)
    expect(problemi, `tetto-ui.json — numeri di oggi:\n${[...conti].filter(([, n]) => n > 0).map(([f, n]) => `  ${JSON.stringify(f)}: ${n}`).join('\n')}\ntotale: ${totale}\n`).toEqual([])
  })
})
