// M1 (fase beta12-correzioni): il compositore NON si deforma con un testo
// lungo. La decisione non conta gli a capo del testo ma LA MISURA del
// textarea (scrollHeight contro l'altezza della riga unica): così il testo
// lungo senza a capo che va su più righe conta come oggi conta lo \n
// esplicito. Puro, testato; la misura la fa il componente col suo ref.
//
// Fase design (DS4): qui restano la MISURA e il LAYOUT a più righe. Il raggio
// dinamico di M1 (composerFormRadius: pillola a una riga, angoli da 24 px da
// due in su) non c'è più, e non è una perdita: i raggi di DS1 sono tre, e il
// campo di scrittura è una superficie (rounded-surface) a una riga come a
// dieci — lo scrivono i due form, e basta. Quel che M1 voleva — che la barra
// del textarea non toccasse un angolo troppo tondo — lo garantisce il raggio
// piccolo (14) meglio dei 24, a ogni altezza.

/** L'altezza della riga unica del composer della chat: min-h-control (36). */
export const CHAT_COMPOSER_SINGLE_ROW_PX = 36

/**
 * L'altezza della riga unica del composer della squadra. Era 44 (min-h-11):
 * con i token di DS1 il campo è un campo come gli altri, 36 px (min-h-control
 * attorno a una riga di text-body), come quello della chat.
 */
export const TEAM_COMPOSER_SINGLE_ROW_PX = 36

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
