// Fase 17b (A1): la lingua dell'utente si rileva dal testo che scrive, in modo
// deterministico e senza dipendenze. La usa il daemon (noteHumanText) per
// decidere la sezione Language del prompt e l'eval per il controllo di lingua.
// Solo it/en: nessuna lingua nuova in questa fase.

/** Le lingue che l'agente distingue. */
export type Lang = 'it' | 'en'

/**
 * Parole funzionali italiane. Nessuna parola in comune con la lista inglese:
 * i termini ambigui fra le due lingue (a, in, e, i, o, no, …) non ci sono.
 * Fase 17b correzioni (B1): entrate preposizioni e parole comandi italiane,
 * perché l'articolo «i» e l'inglese «me»/«do» («per me», «ti do») facevano
 * scambiare l'italiano per inglese.
 * Esportate solo per il test di intersezione vuota.
 */
export const IT_WORDS = new Set([
  'il', 'lo', 'la', 'gli', 'le', 'un', 'una', 'uno', 'di', 'del', 'della', 'dei', 'delle',
  'da', 'con', 'su', 'per', 'tra', 'che', 'non', 'è', 'ma', 'come', 'cosa', 'sono', 'sei',
  'ho', 'hai', 'ha', 'questo', 'questa', 'mi', 'ti', 'ci', 'anche', 'più', 'perché', 'dove',
  'quando', 'grazie', 'ciao', 'puoi', 'voglio', 'fammi', 'vorrei',
  'nel', 'nella', 'al', 'alla', 'dal', 'sul', 'se', 'sì', 'fai', 'dammi', 'dimmi', 'oggi',
  'domani', 'ieri', 'poi', 'già', 'tutto', 'tutti', 'ancora', 'ora'
])

/**
 * Parole funzionali inglesi, anch'esse senza ambiguità con l'italiano.
 * Fase 17b correzioni (B1): via `i`, `me`, `do` (articolo e «per me»/«ti do»
 * italiani), dentro i termini che li sostituiscono. Esportate come sopra.
 */
export const EN_WORDS = new Set([
  'the', 'an', 'of', 'to', 'on', 'for', 'with', 'and', 'but', 'is', 'are', 'was', 'be', 'it',
  'this', 'that', 'what', 'how', 'why', 'where', 'when', 'you', 'your', 'my', 'we',
  'can', 'could', 'would', 'should', 'does', 'please', 'thanks', 'hello', 'hi', 'want',
  'need',
  'have', 'has', 'will', 'not', 'from', 'about', 'all', 'if', 'now', 'today', 'tomorrow',
  'yesterday', 'just', 'there', 'they', 'them'
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
  return detectLanguageDetail(text)?.lang ?? null
}

/**
 * Come detectLanguage, ma riporta anche i colpi della lingua vincente. Serve
 * all'isteresi di noteHumanText (fase 17b correzioni, B1): un testo è «forte»
 * quando la lingua vincente ha almeno 3 colpi.
 */
export function detectLanguageDetail(text: string): { lang: Lang; hits: number } | null {
  const toks = tokens(text)
  let itHits = 0
  let enHits = 0
  for (const t of toks) {
    if (IT_WORDS.has(t)) itHits++
    else if (EN_WORDS.has(t)) enHits++
  }
  if (itHits >= 2 && (enHits === 0 || itHits >= 2 * enHits)) return { lang: 'it', hits: itHits }
  if (enHits >= 2 && (itHits === 0 || enHits >= 2 * itHits)) return { lang: 'en', hits: enHits }
  if (itHits === 1 && enHits === 0 && /[àèéìòù]/.test(text)) return { lang: 'it', hits: 1 }
  return null
}

/** Il nome della lingua, come appare nella sezione Language del prompt. */
export function languageName(lang: Lang): 'Italian' | 'English' {
  return lang === 'it' ? 'Italian' : 'English'
}
