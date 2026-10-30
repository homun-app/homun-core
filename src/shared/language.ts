// Fase 17b (A1): la lingua dell'utente si rileva dal testo che scrive, in modo
// deterministico e senza dipendenze. La usa il daemon (noteHumanText) per
// decidere la sezione Language del prompt e l'eval per il controllo di lingua.
// Solo it/en: nessuna lingua nuova in questa fase.

/** Le lingue che l'agente distingue. */
export type Lang = 'it' | 'en'

/**
 * Parole funzionali italiane. Nessuna parola in comune con la lista inglese:
 * i termini ambigui fra le due lingue (a, in, e, i, o, no, …) non ci sono.
 */
const IT_WORDS = new Set([
  'il', 'lo', 'la', 'gli', 'le', 'un', 'una', 'uno', 'di', 'del', 'della', 'dei', 'delle',
  'da', 'con', 'su', 'per', 'tra', 'che', 'non', 'è', 'ma', 'come', 'cosa', 'sono', 'sei',
  'ho', 'hai', 'ha', 'questo', 'questa', 'mi', 'ti', 'ci', 'anche', 'più', 'perché', 'dove',
  'quando', 'grazie', 'ciao', 'puoi', 'voglio', 'fammi', 'vorrei'
])

/** Parole funzionali inglesi, anch'esse senza ambiguità con l'italiano. */
const EN_WORDS = new Set([
  'the', 'an', 'of', 'to', 'on', 'for', 'with', 'and', 'but', 'is', 'are', 'was', 'be', 'it',
  'this', 'that', 'what', 'how', 'why', 'where', 'when', 'you', 'your', 'my', 'me', 'we',
  'can', 'could', 'would', 'should', 'do', 'does', 'please', 'thanks', 'hello', 'hi', 'want',
  'need', 'i'
])

/** Tokenizza: minuscolo, parole `[a-zà-ÿ']+`, l'apostrofo divide («l'utente» → l, utente). */
function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-zà-ÿ']+/g) ?? []
}

/**
 * Rileva la lingua di un testo scritto da una persona, o null se non decide.
 * Regola: conta i token nelle due liste; vince chi ha almeno 2 colpi e almeno
 * il doppio dell'altra (con zero colpi per l'altra basta il minimo di 2).
 * Eccezione: 1 colpo IT più una lettera accentata italiana dà 'it'. I messaggi
 * corti («ok», «sì», un URL, un comando) restano null.
 */
export function detectLanguage(text: string): Lang | null {
  const toks = tokens(text)
  let itHits = 0
  let enHits = 0
  for (const t of toks) {
    if (IT_WORDS.has(t)) itHits++
    else if (EN_WORDS.has(t)) enHits++
  }
  if (itHits >= 2 && (enHits === 0 || itHits >= 2 * enHits)) return 'it'
  if (enHits >= 2 && (itHits === 0 || enHits >= 2 * itHits)) return 'en'
  if (itHits === 1 && enHits === 0 && /[àèéìòù]/.test(text)) return 'it'
  return null
}

/** Il nome della lingua, come appare nella sezione Language del prompt. */
export function languageName(lang: Lang): 'Italian' | 'English' {
  return lang === 'it' ? 'Italian' : 'English'
}
