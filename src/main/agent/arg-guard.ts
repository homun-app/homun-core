// Fase token (T8) + fase token ritocchi (R1–R3): i controlli FISSI di
// sicurezza — regole PURE che non dipendono dal modello (la misura L0 ha
// mostrato i modelli piccoli scrivere numeri di carta in browser_type,
// password scritte in chat negli argomenti dei tool verso l'esterno, chiavi
// nel reason di offer_connector). Prima di permessi e card, un argomento che
// va verso l'esterno o verso un sito e che contiene uno di questi valori
// viene RIFIUTATO senza esecuzione:
// - un numero di CARTA (R2): SOLO nei campi dove si digita o si scrive un
//   messaggio (browser_type.text, i values di browser_select, i campi di
//   testo di draft_external, send_to_agent.text, il testo digitato da
//   computer_act) — MAI su URL (web_fetch, browser_open), comandi (run-command)
//   o id — e solo con l'aspetto di una carta: 13–19 cifre, prefisso IIN
//   plausibile, Luhn valido, cifre attaccate o a gruppi di 4 (spazi o trattini);
// - una CHIAVE col prefisso noto (R1): sk-, ak_, secret_, ghp_, xox[abpr]- —
//   solo come token intero (nessuna lettera/cifra/_/- prima del prefisso:
//   «task-runner», «disk-utility», «peak_hours» non contano), con la lunghezza
//   di KEY_SHAPES dopo il prefisso e almeno una cifra nel valore;
// - un SEGRETO che l'utente ha scritto in chat (R3): parola di segreto INTERA
//   (password, passphrase, passcode, pin, token, api key/apikey, chiave api,
//   chiave segreta, secret, segreto — «chiave» da sola non conta), assegnazione
//   ESPLICITA (: = «è» «e'» is vale sarebbe, al massimo 3 parole di raccordo:
//   il solo spazio non basta) e valore che sembra un segreto (≥ 6 caratteri
//   senza spazi, con almeno una cifra, un simbolo, o maiuscole e minuscole
//   mescolate dopo la prima lettera).
// Il messaggio verso il modello NON contiene MAI il valore (e la entry del
// transcript la si redige nel loop, dove la chiamata viene rifiutata).
// In più (T8a): un blocco <evento> esterno nel messaggio che apre il turno
// contamina il turno, come una pagina web letta.
/** T8a: il testo del turno contiene un blocco <evento> (evidenza esterna)? */
export function hasExternalEvento(turnText: string): boolean {
  return /<evento>[\s\S]*?<\/evento>/.test(turnText)
}

// ---- i rilevatori (puri) ----

/** l'escape dei caratteri speciali di una espressione regolare (puro) */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Luhn su una stringa di cifre (puro). */
function luhnOk(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

/**
 * R2: il prefisso IIN plausibile di una carta — Visa (4), Mastercard (51–55 e
 * 2221–2720), Amex (34/37), Discover (6011, 65, 644–649), JCB (35), Diners
 * (30/36/38). Un id di tweet o un timestamp non parte MAI da questi (puro).
 */
function plausibleCardIin(digits: string): boolean {
  const n3 = Number(digits.slice(0, 3))
  const n4 = Number(digits.slice(0, 4))
  if (digits[0] === '4') return true // Visa
  const n2 = Number(digits.slice(0, 2))
  if (n2 >= 51 && n2 <= 55) return true // Mastercard
  if (n4 >= 2221 && n4 <= 2720) return true // Mastercard, serie 2
  if (digits.startsWith('34') || digits.startsWith('37')) return true // Amex
  if (digits.startsWith('6011')) return true // Discover
  if (digits.startsWith('65')) return true // Discover
  if (n3 >= 644 && n3 <= 649) return true // Discover
  if (digits.startsWith('35')) return true // JCB
  if (digits.startsWith('30') || digits.startsWith('36') || digits.startsWith('38')) return true // Diners
  return false
}

/**
 * R2: i numeri di carta nel testo — 13–19 cifre con IIN plausibile E Luhn
 * valido, tutte attaccate o a gruppi di 4 separati da spazi o trattini.
 * Esce il numero COMPATTO (unici): un id di 19 cifre che passa Luhn ma non
 * ha un IIN di carta non conta più.
 */
export function luhnCardNumbers(text: string): string[] {
  const out: string[] = []
  // attaccate (13–19 cifre) oppure 4-4-4-4 (spazi o trattini)
  const re = /\b(?:\d{13,19}|\d{4}(?:[ -]\d{4}){3})\b/g
  for (const m of text.matchAll(re)) {
    const compact = m[0].replace(/[ -]/g, '')
    if (compact.length >= 13 && compact.length <= 19 && plausibleCardIin(compact) && luhnOk(compact) && !out.includes(compact)) out.push(compact)
  }
  return out
}

/**
 * R1: le soglie delle chiavi — il numero MINIMO di caratteri di chiave dopo
 * il prefisso (il valore deve anche contenere almeno una cifra, perché una
 * run di sole lettere non è una chiave vera).
 */
export const KEY_SHAPES: ReadonlyArray<{ prefix: string; minAfter: number }> = [
  { prefix: 'sk-', minAfter: 20 },   // OpenAI (comprende sk-proj-…, sk-ant-…)
  { prefix: 'ak_', minAfter: 16 },
  { prefix: 'secret_', minAfter: 16 },
  { prefix: 'ghp_', minAfter: 30 },  // GitHub PAT (36 caratteri)
  { prefix: 'xoxa-', minAfter: 10 }, // Slack app-level
  { prefix: 'xoxb-', minAfter: 10 }, // Slack bot
  { prefix: 'xoxp-', minAfter: 10 }, // Slack workflow/user
  { prefix: 'xoxr-', minAfter: 10 }  // Slack refresh
]

/**
 * R1: le chiavi col prefisso noto — SOLO come token intero (lookbehind: prima
 * del prefisso niente lettera, cifra, `_` o `-`: «task-runner», «disk-utility»,
 * «peak_hours», «break_point» non contano), con la lunghezza di KEY_SHAPES
 * dopo il prefisso e almeno una cifra nel valore (puro).
 */
export function knownKeyPrefixHits(text: string): string[] {
  const out: string[] = []
  const re = new RegExp(
    KEY_SHAPES.map((s) => `(?<![A-Za-z0-9_-])${escapeRe(s.prefix)}[A-Za-z0-9_-]{${s.minAfter},}`).join('|'),
    'g'
  )
  for (const m of text.matchAll(re)) {
    if (/[0-9]/.test(m[0]) && !out.includes(m[0])) out.push(m[0])
  }
  return out
}

/**
 * R3: le parole che annunciano un segreto in chat, INTERE (italiano e inglese,
 * come request_secure_input insegna). «chiave» da sola NON c'è: «parola
 * chiave», «chiave inglese», «chiave di lettura» non sono segreti; e «pin»
 * dentro un'altra parola («spingere») non conta.
 */
const SECRET_WORDS = [
  'chiave segreta', 'chiave api', 'api key', 'api-key', 'apikey',
  'password', 'passphrase', 'passcode', 'secret', 'segreto', 'token', 'pin'
]
// il separatore «è» (italiano) come escape unicode: la guardia del testo
// italiano dei sorgenti vede solo ASCII in questo letterale

/** R3: il valore sembra un segreto? (≥ 6 caratteri senza spazi; una cifra, un simbolo, o maiuscole+minuscole dopo la prima lettera) */
function secretShaped(v: string): boolean {
  if (v.length < 6 || /\s/.test(v)) return false
  if (/[0-9]/.test(v)) return true
  if (/[^A-Za-z0-9]/.test(v)) return true
  const tail = v.slice(1)
  return /[A-Z]/.test(tail) && /[a-z]/.test(tail)
}

/**
 * R3: i valori che l'utente ha scritto in chat dopo una parola di segreto
 * («la mia password è X», «token: Y», «my password is Z») — SOLO con
 * assegnazione esplicita (`:` `=`, «è», «e'», «is», «vale», «sarebbe», con al
 * massimo 3 parole di raccordo in mezzo: il solo spazio NON basta, così
 * «la password di Netflix non funziona più» non ha segreti) e SOLO se il
 * valore sembra un segreto (secretShaped: «sbagliata», «Netflix»,
 * «marketing» non lo sono). Un PIN di 4 cifre resta fuori: troppo corto per
 * essere utile da solo (lo coprono le regole della carta e delle chiavi).
 */
export function chatSecretValues(userTexts: readonly string[]): string[] {
  const out: string[] = []
  const kw = SECRET_WORDS.map(escapeRe).join('|')
  const re = new RegExp(
    `\\b(?:${kw})\\b` +                                                // la parola di segreto, intera
    `(?:\\s+[^\\s:=\\u00e8]{1,24}){0,3}?` +                            // fino a 3 parole di raccordo
    `\\s*(?::|=|\\u00e8|\\be'|\\bis\\b|\\bvale\\b|\\bsarebbe\\b)` +    // l'assegnazione esplicita
    `\\s*["']?([!-~]{6,64})["']?`,                                     // il valore
    'gi'
  )
  for (const text of userTexts) {
    for (const m of text.matchAll(re)) {
      const v = m[1]!.trim().replace(/[,.:;)>]+$/, '')
      // la parola catturata non può essere la parola di segreto stessa
      if (v.length >= 6 && !new RegExp(`^(?:${kw})$`, 'i').test(v) && secretShaped(v) && !out.includes(v)) out.push(v)
    }
  }
  return out
}

/** I tool i cui argomenti vanno verso l'esterno o verso un sito (T8b): guardati. */
export const GUARDED_ARG_TOOLS: ReadonlySet<string> = new Set([
  'browser_type', 'browser_select', 'draft_external', 'send_to_agent',
  'offer_connector', 'add_mcp_server', 'web_fetch', 'run-command', 'fill_credential',
  'computer_act'
])

/** Il messaggio breve verso il modello (MAI il valore). */
export const ARG_GUARD_REFUSAL =
  'This argument contains a card number, a key, or a value the user typed as a secret in chat: it is never written into tool arguments. Ask for request_secure_input (or fill_credential for a saved login) instead.'

/** i valori stringa di un argomento (ricorsivo, puro) */
function stringValuesOf(v: unknown, depth = 0): string[] {
  if (depth > 4) return []
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.flatMap((x) => stringValuesOf(x, depth + 1))
  if (v && typeof v === 'object') return Object.values(v).flatMap((x) => stringValuesOf(x, depth + 1))
  return []
}

/**
 * R2: gli argomenti di TESTO dove si DIGITA in un campo o si scrive in un
 * messaggio — la carta si cerca SOLO lì (puro):
 * - browser_type.text;
 * - i values di browser_select;
 * - i campi di testo di draft_external (subject, body);
 * - send_to_agent.text;
 * - il testo digitato da computer_act (le azioni kind:'type').
 * MAI su URL, comandi o id.
 */
function cardTypedTextsOf(tool: string, input: Record<string, unknown>): string[] {
  if (tool === 'browser_type') return typeof input.text === 'string' ? [input.text] : []
  if (tool === 'browser_select') return Array.isArray(input.values)
    ? input.values.filter((v): v is string => typeof v === 'string')
    : []
  if (tool === 'draft_external') {
    return ['subject', 'body'].filter((k) => typeof input[k] === 'string').map((k) => input[k] as string)
  }
  if (tool === 'send_to_agent') return typeof input.text === 'string' ? [input.text] : []
  if (tool === 'computer_act') {
    return Array.isArray(input.actions)
      ? input.actions.flatMap((a) => {
          if (!a || typeof a !== 'object') return []
          const act = a as Record<string, unknown>
          return act.kind === 'type' && typeof act.text === 'string' ? [act.text] : []
        })
      : []
  }
  return []
}

/**
 * La sentinella (pura): rifiuta gli argomenti di un tool verso l'esterno che
 * contengono un numero di carta (R2: solo nei campi dove si digita, con
 * IIN+Luhn), una chiave col prefisso noto (R1: token intero, lunghezza da
 * chiave vera) o un segreto assegnato esplicitamente in chat (R3). web_fetch
 * guarda SOLO l'url (e la carta nell'url non si cerca).
 * Il reason non contiene MAI il valore trovato.
 */
export function argGuardVerdict(
  tool: string,
  input: Record<string, unknown>,
  userChatTexts: readonly string[]
): { ok: true } | { ok: false; reason: string } {
  if (!GUARDED_ARG_TOOLS.has(tool)) return { ok: true }
  const texts = tool === 'web_fetch'
    ? [String(input.url ?? '')]
    : stringValuesOf(input)
  const chatSecrets = chatSecretValues(userChatTexts)
  // R2: la carta SOLO dove si digita
  for (const t of cardTypedTextsOf(tool, input)) {
    if (luhnCardNumbers(t).length) return { ok: false, reason: ARG_GUARD_REFUSAL }
  }
  for (const t of texts) {
    if (knownKeyPrefixHits(t).length) return { ok: false, reason: ARG_GUARD_REFUSAL }
    for (const s of chatSecrets) {
      if (s.length >= 6 && t.includes(s)) return { ok: false, reason: ARG_GUARD_REFUSAL }
    }
  }
  return { ok: true }
}

/** (per il loop) i testi utente della conversazione, dai messaggi del turno. */
export function userChatTextsOf(messages: ReadonlyArray<{ role: string; content: string }>): string[] {
  return messages.filter((m) => m.role === 'user').map((m) => m.content)
}

/**
 * La copia REDATTA degli argomenti per la entry del transcript di una
 * chiamata rifiutata dalla sentinella (R4: o di un qualunque percorso di
 * rifiuto o errore del loop): i valori che contengono il segreto (o la
 * carta/chiave) diventano «[redacted]» — il valore non compare MAI nel
 * transcript (puro). La carta si redige in tutte le forme riconosciute:
 * compatta, spaziata e a trattini.
 */
export function redactGuardedArgs(
  input: Record<string, unknown>,
  userChatTexts: readonly string[]
): Record<string, unknown> {
  const chatSecrets = chatSecretValues(userChatTexts)
  const redactString = (t: string): string => {
    let out = t
    // la carta può stare nel testo A GRUPPI SPAZIATI o A TRATTINI: si redige
    // in tutte le forme (compatta, 4-4-4-4 con spazi, 4-4-4-4 con trattini)
    for (const n of luhnCardNumbers(t)) {
      out = out.split(n.replace(/(\d)(?=(\d{4})+$)/g, '$1 ')).join('[redacted]')
      out = out.split(n.replace(/(\d)(?=(\d{4})+$)/g, '$1-')).join('[redacted]')
      out = out.split(n).join('[redacted]')
    }
    for (const k of knownKeyPrefixHits(t)) out = out.split(k).join('[redacted]')
    for (const s of chatSecrets) out = out.split(s).join('[redacted]')
    return out
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) o[k] = walk(val)
      return o
    }
    return v
  }
  return walk(input) as Record<string, unknown>
}
