// RW (fase revisore sulla richiesta, punto 5): le note dell'aggiornamento
// come TESTO SEMPLICE. Con il provider GitHub `releaseNotes` arriva come
// stringa HTML e il dialogo «È disponibile Homun …» mostrava i tag grezzi
// (<p>, <br>, <li>, <strong>). Qui l'HTML diventa testo:
// - <li> → «• », a capo su </p>, </li>, <br> e i titoli;
// - via tutti gli altri tag;
// - entità decodificate (DOPO lo strip: &lt;p&gt; resta testo, non diventa tag);
// - righe vuote multiple ridotte a una;
// - oltre ~1500 caratteri si taglia alla fine dell'ultima voce intera, con
//   «…» e l'invito ad «Apri le note» (il bottone del dialogo li apre).
// Tutto PURO.
export const RELEASE_NOTES_MAX_CHARS = 1_500

/** L'HTML delle note in testo semplice (niente taglio). */
export function htmlToPlainText(html: string): string {
  const text = html
    // B1 (fase beta.4): GitHub spezza le righe del CHANGELOG a ~75 colonne e
    // nel corpo della release ogni a capo diventa `<br>` SEGUIto da `\n`.
    // Quello è un ACAPO MORBIDO: si UNISCE con uno spazio, non si va a capo
    // (il risultato era ogni frase mozzata con una riga vuota in mezzo)
    .replace(/<br\s*\/?>(?:[ \t]*\n)+/gi, ' ')
    // B1: anche un `\n` rimasto dentro <p> o <li> è un a capo morbido dello
    // sorgente HTML: uno spazio. Si va a capo SOLO sui marcatori di blocco
    // (sotto): chiusura di paragrafo/voce, i titoli e un <br> non seguito da \n
    .replace(/\n/g, ' ')
    // i marcatori che diventano RIGHE: <li> apre una voce col puntino,
    // </p>/</li>/<br> e i titoli vanno a capo
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(p|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h[1-6][^>]*>/gi, '\n')
    // via tutti gli altri tag
    .replace(/<[^>]+>/g, '')
    // le entità si decodificano DOPO: il testo escape resta testo
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
  // righe vuote multiple ridotte a una, niente spazi di servizio ai bordi
  return text
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Le note pronte per il dialogo: testo semplice e, se superano ~1500
 * caratteri, taglio alla fine dell'ultima VOCE intera (riga completa) con
 * «…» e l'invito ad aprire le note. L'invito arriva dal chiamante, nella
 * lingua dell'interfaccia (updater.notesMore del dizionario).
 */
export function releaseNotesText(html: string, notesMore: string): string {
  const text = htmlToPlainText(html)
  if (text.length <= RELEASE_NOTES_MAX_CHARS) return text
  const cut = text.slice(0, RELEASE_NOTES_MAX_CHARS)
  const lastBreak = cut.lastIndexOf('\n')
  const head = (lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd()
  return `${head}\n…\n${notesMore}`
}
