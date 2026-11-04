// Fase risposta (R4): il silenzio esplicito dei turni automatici — modulo PURO.
//
// Porta le funzioni di Rakazo che servono (adattate al nostro testo libero:
// da noi la risposta finale è una stringa, non una lista di blocchi):
// il segnale esatto NO_RESPONSE, ripetuto o con spazi; i segnali spaiati ai
// bordi di una risposta vera si tolgono; «.» e «…» da soli valgono vuoto;
// verso un altro bot il segnale diventa «Nothing new to add.».
//
// da Rakazo (Apache 2.0), packages/adapters/src/silent-reply.ts
/** Il segnale esatto che un turno automatico silenzioso deve rispondere. */
export const NO_RESPONSE = 'NO_RESPONSE'

/** Il segnale da solo, una o più volte (i segmenti di un turno si uniscono senza separatori). */
const SENTINEL_ONLY = /^(?:NO_RESPONSE\s*)+$/

/** True quando il testo trimmato è SOLO il segnale, una o più volte. Prosa extra non conta. */
export function isExactNoResponse(text: string): boolean {
  return SENTINEL_ONLY.test(text.trim())
}

// spazi e caratteri invisibili di formato (zero-width, BOM)
const INVISIBLE = /[\s\p{Cf}]/gu

/**
 * Una risposta che ne ha solo l'aspetto: niente altro che spazi e caratteri
 * invisibili, o un punto o puntini di sospensione da soli. Qualsiasi lettera,
 * cifra o segno («✓», «—») è una risposta. Il testo del tutto vuoto NON è un
 * segnaposto.
 */
export function isPlaceholderText(text: string): boolean {
  if (text.length === 0) return false
  return /^[.…]*$/u.test(text.replace(INVISIBLE, ''))
}

/**
 * True mentre il testo può ancora crescere fino al segnale: la diretta (R6)
 * aspetta prima di mostrarsi. Gli spazi tra le ripetizioni non contano.
 */
export function couldBecomeNoResponse(text: string): boolean {
  const rest = text.replace(/\s+/g, '').replace(/^(?:NO_RESPONSE)+/, '')
  return NO_RESPONSE.startsWith(rest)
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/
const WHITESPACE = /\s/

/**
 * L'intervallo di prosa vera di un testo coi segnali spaiati ai bordi
 * (incollati o con spazi). Ogni token deve finire a confine di parola: un
 * token che continua in un identificatore (`NO_RESPONSE_POLICY`) è una parola
 * e la corsa si ferma all'ultimo token pulito prima di lui.
 */
function proseRange(text: string): { start: number; end: number } {
  let cursor = text.length - text.trimStart().length
  let start = 0
  while (text.startsWith(NO_RESPONSE, cursor)) {
    cursor += NO_RESPONSE.length
    if (!IDENTIFIER_CHAR.test(text[cursor] ?? '')) {
      while (cursor < text.length && WHITESPACE.test(text[cursor]!)) cursor++
      start = cursor
    } else if (!text.startsWith(NO_RESPONSE, cursor)) {
      break
    }
  }
  // si scandisce all'indietro dalla fine: uno spazio lungo non può causare
  // backtracking sul suffisso
  cursor = text.trimEnd().length
  let end = text.length
  while (cursor - NO_RESPONSE.length >= start && text.endsWith(NO_RESPONSE, cursor)) {
    cursor -= NO_RESPONSE.length
    if (cursor <= start || !IDENTIFIER_CHAR.test(text[cursor - 1] ?? '')) {
      while (cursor > start && WHITESPACE.test(text[cursor - 1]!)) cursor--
      end = cursor
    } else if (!(cursor - NO_RESPONSE.length >= start && text.endsWith(NO_RESPONSE, cursor))) {
      break
    }
  }
  return { start, end }
}

/**
 * R4.2: una risposta con prosa vera e un segnale spaiato all'inizio o alla
 * fine: si toglie il segnale e si consegna il resto. Una risposta fatta solo
 * di segnale resta com'è (a deciderla è isExactNoResponse, non questa).
 */
export function stripStrayNoResponse(text: string): string {
  if (isExactNoResponse(text)) return text
  const { start, end } = proseRange(text)
  return text.slice(start, end)
}

/** Cosa risponde un bot chiesto da un altro bot quando ha risposto col solo segnale. */
export const PEER_NOTHING_NEW_REPLY = 'Nothing new to add.'

/**
 * R4.5: per una richiesta di un ALTRO bot il segnale da solo non può arrivare
 * letterale al mittente: diventa «Nothing new to add.». Le altre risposte si
 * ripuliscono solo dei segnali spaiati ai bordi.
 */
export function peerReplyWithoutSentinel(text: string): string {
  const visible = text.trim()
  if (!isExactNoResponse(visible)) return stripStrayNoResponse(text)
  return PEER_NOTHING_NEW_REPLY
}
