// Fase 17c correzioni (D4): la rilevazione del testo italiano di un letterale,
// isolata in un helper ACCANTO alla guardia così si testa da sola. Tre regole:
//   1. contiene una lettera accentata italiana;
//   2. contiene almeno 2 parole funzionali italiane (IT_WORDS di language.ts);
//   3. contiene almeno 1 parola di IT_STRONG e NESSUNA parola di EN_WORDS.
// La terza è la novità della 17c-correzioni: le stringhe corte («Nuova email»,
// «errore del modello: », «utente») prima passavano senza allarme.
//
// IT_STRONG contiene solo parole che in inglese non esistono. NIENTE parole
// ambigue come per, non (in «non-empty»), a, e, i, o, come, data: chiuderebbero
// fuori testi inglesi interi. Se un negativo del test scatta, la parola colpevole
// esce da IT_STRONG (non si aggiunge allowlist).
import { IT_WORDS, EN_WORDS } from '../../shared/language'

/** Parole che in inglese non esistono: una sola basta (con zero parole EN). */
export const IT_STRONG = new Set([
  'il', 'lo', 'gli', 'del', 'della', 'delle', 'dei', 'nel', 'nella', 'col',
  'che', 'utente', 'errore', 'nuova', 'nuovo', 'ricevuto', 'arrivo', 'scaduto',
  'codice', 'modello', 'impostazioni', 'evento', 'messaggio', 'agente',
  'annullato', 'bozza', 'valori', 'richiede'
])

/** Accented italiane (minuscole e maiuscole). */
const ACCENTED = /[àèéìòùÀÈÉÌÒÙ]/

/** Token [a-zà-ÿ']+ (l'apostrofo divide: «l'utente» → l, utente), come la guardia. */
const tokens = (text: string): string[] => text.toLowerCase().match(/[a-zà-ÿ']+/g) ?? []

/** Un letterale è italiano? (le tre regole della guardia, D4) */
export function isItalianLiteral(text: string): boolean {
  const t = tokens(text)
  if (ACCENTED.test(text)) return true
  if (t.filter((w) => IT_WORDS.has(w)).length >= 2) return true
  return t.some((w) => IT_STRONG.has(w)) && !t.some((w) => EN_WORDS.has(w))
}
