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
