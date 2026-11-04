// Fase risposta (R3): la riga di lavoro — il testo che il modello scrive a
// metà turno, prima di una chiamata di strumento, diventa la mezza riga della
// mascotte («lavora…»), MAI un messaggio. Modulo PURO condiviso: lo usa il
// renderer e i test lo provano qui.
//
// Tetto e forma sono la narrationStatusLine di Rakazo; da noi la riga è
// l'ULTIMA riga non vuota del testo della chiamata.
// da Rakazo (Apache 2.0), packages/adapters/src/user-progress.ts
/** Una nota mostrata come riga di lavoro si taglia a questa lunghezza. */
export const NARRATION_STATUS_MAX_LENGTH = 60

/** Una riga sola per lo stato del lavoro: spazi compattati, taglio con «…». */
export function narrationStatusLine(text: string): string {
  // l'ultima riga non vuota: la riga finale di una chiamata è quella che
  // racconta dove è arrivato il lavoro
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines.length ? lines[lines.length - 1]! : ''
  const line = last.replace(/\s+/g, ' ').trim()
  return line.length <= NARRATION_STATUS_MAX_LENGTH
    ? line
    : `${line.slice(0, NARRATION_STATUS_MAX_LENGTH).trimEnd()}…`
}
