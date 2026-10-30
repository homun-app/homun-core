// Fase 9 (punto 0): le regole dei send_to_user DENTRO un turno — modulo PURO.
//
// Diagnosi del bug dei "tre messaggi per una sola azione" (DB di sviluppo,
// entry 158–204): le send arrivavano integre (arguments con virgolette e a
// capo corretti, verificato), ma il tool result diceva solo "inviato
// all'utente" senza nessun riscontro sul testo, e le congetture del modello
// ("The final message got cut…") restavano nel transcript come entry thinking
// che i turni successivi rileggevano come assistant content: il modello
// rileggeva le proprie lamentele, le prendeva per evidenza e rimandava il
// messaggio, spezzato in più send, con riempitivi ("Attivata.", "OK.").
// Queste funzioni chiudono il circolo: il result riporta l'inizio del testo
// consegnato (il modello può VERIFICARE), i duplicati non vengono riconsegnati
// e più messaggi di fila senza lavoro in mezzo non diventano chat.

/** Quanti caratteri del testo consegnato tornano al modello nel tool result. */
export const DELIVERED_PREVIEW_CHARS = 120

/** L'inizio del testo (primi 120 caratteri), per il result e per i messaggi di errore. */
export function previewOf(text: string, max = DELIVERED_PREVIEW_CHARS): string {
  const t = text.trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * Il result di send_to_user (punto 0b): riporta l'inizio del testo consegnato
 * così il modello può verificare che è arrivato intero, e gli dice di non
 * ripeterlo. `held` = trattenuto nell'outbox di un turno automatico (fase 6).
 */
export function deliveredResultText(text: string, opts: { held?: boolean } = {}): string {
  const base = `delivered to the user: "${previewOf(text)}"`
  if (opts.held) {
    return `${base} — delivery is deferred to the next delivery window or when the chat opens, unless urgent. Do not repeat it.`
  }
  return `${base}. Do not repeat it.`
}

/**
 * Dedup (punto 0c): il testo è UGUALE a uno già consegnato in questo turno o
 * è CONTENUTO in uno già consegnato → non va consegnato di nuovo.
 * Confronto sul testo trimmato (case-sensitive: meno falsi positivi).
 */
export function isDuplicateSend(delivered: readonly string[], text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return delivered.some((d) => {
    const dt = d.trim()
    return dt === t || (dt.length > 0 && dt.includes(t))
  })
}

/** Il result per una send duplicata (punto 0c). */
export function alreadyDeliveredResult(text: string): string {
  return `already delivered to the user in this turn: "${previewOf(text)}". Do not repeat the same content.`
}

/**
 * Un tool è "lavoro" quando fa qualcosa DIVERSO dal parlare con l'utente:
 * qualunque tool tranne send_to_user e ask_user (le deleghe, le bozze, le
 * card di offerta e i task contano come lavoro: producono effetti o carte).
 */
export function isWorkTool(name: string): boolean {
  return name !== 'send_to_user' && name !== 'ask_user'
}

/**
 * Il result per una send NON consegnata perché troppe di fila (punto 0d):
 * il testo è diventato ragionamento, il modello deve fondere o chiudere.
 */
export function messageCapResult(): string {
  return 'Not delivered: in this turn the user has already received a message not followed by work. The text ended up in reasoning, not in chat. Do not repeat: if you are done, close the turn; if you have something NEW to add, merge it into a single message.'
}

/**
 * Fase 10 (residuo 0c): al massimo 3 send_to_user CONSEGNATI per turno — il
 * lavoro di uno stesso turno per l'utente sta in tre messaggi; dal quarto il
 * testo è ragionamento (come per il cap di fila).
 */
export const MAX_DELIVERED_PER_TURN = 3

/** Il result per la send oltre il tetto del turno (residuo 0c). */
export function turnCapResult(): string {
  return `Not delivered: in this turn the user has already received ${MAX_DELIVERED_PER_TURN} messages (the turn cap). The text ended up in reasoning, not in chat: if something essential is missing, close the turn and you will pick it up at the user's next message.`
}

/**
 * Il result per una send SENZA testo (visto nel valutare i comportamenti:
 * un modello a volte chiama send_to_user con text vuoto): niente consegna,
 * la chat non deve riempirsi di messaggi vuoti.
 */
export function emptySendResult(): string {
  return 'Not delivered: the text field is empty. Write the message in the text field of send_to_user, or do not call it if you have nothing to say.'
}
