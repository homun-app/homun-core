// M1 (fase beta12-correzioni): il raggio del compositore — a UNA riga la
// pillola di oggi, da due righe in su gli angoli da 24 px. La decisione non
// conta gli a capo del testo ma LA MISURA del textarea (scrollHeight contro
// l'altezza della riga unica): così il testo lungo senza a capo che va su
// più righe conta come oggi conta lo \n esplicito. Puro, testato; la misura
// la fa il componente col suo ref, le classi le decide composerFormRadius.

/** L'altezza della riga unica del composer della chat (min-h-9: py-2 + leading-5). */
export const CHAT_COMPOSER_SINGLE_ROW_PX = 36

/** L'altezza della riga unica del composer della squadra (min-h-11). */
export const TEAM_COMPOSER_SINGLE_ROW_PX = 44

/** Il raggio del form: pillola a una riga, angoli da 24 px da due in su. */
export function composerFormRadius(multiRow: boolean): string {
  return multiRow ? 'rounded-3xl' : 'rounded-full'
}

/**
 * Il testo va su più righe? La misura VERA (scrollHeight del textarea contro
 * la sua altezza a riga unica), con la tolleranza di 2 px del subpixel: conta
 * lo \n esplicito e il testo lungo che va a capo da solo, senza stime di
 * caratteri per riga.
 */
export function composerMultiFromMeasure(scrollHeight: number, singleRowHeight: number): boolean {
  return scrollHeight > singleRowHeight + 2
}

/**
 * Lo stato «più righe» con ISTERESI: da due righe in su il campo va a tutta
 * larghezza e i bottoni scendono sotto — e un campo più largo può far stare
 * di nuovo il testo su una riga. Senza margine si avrebbe un'altalena. Si
 * torna a una riga solo senza a capo e con il testo sotto il 90% della
 * lunghezza a cui era diventato «più righe» (o vuoto).
 */
export function nextComposerMulti(
  prev: { multi: boolean; enteredAt: number },
  text: string,
  measuredMulti: boolean
): { multi: boolean; enteredAt: number } {
  if (!prev.multi) {
    return measuredMulti || text.includes('\n') ? { multi: true, enteredAt: text.length } : prev
  }
  if (text.length === 0) return { multi: false, enteredAt: 0 }
  if (!text.includes('\n') && !measuredMulti && text.length < prev.enteredAt * 0.9) return { multi: false, enteredAt: 0 }
  return prev
}

/** Le classi del layout a più righe: il campo sopra a tutta larghezza, i bottoni sotto. */
export function composerLayout(multiRow: boolean): { form: string; field: string; push: string } {
  return multiRow
    ? { form: 'flex-wrap', field: 'order-first basis-full', push: 'ml-auto' }
    : { form: '', field: '', push: '' }
}
