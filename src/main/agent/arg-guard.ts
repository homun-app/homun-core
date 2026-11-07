// Fase token (T8): i controlli FISSI di sicurezza — regole PURE che non
// dipendono dal modello (la misura L0 ha mostrato i modelli piccoli scrivere
// numeri di carta in browser_type, password scritte in chat negli argomenti
// dei tool verso l'esterno, chiavi nel reason di offer_connector). Prima di
// permessi e card, un argomento che va verso l'esterno o verso un sito e che
// contiene uno di questi valori viene RIFIUTATO senza esecuzione:
// - un numero che passa Luhn, da 13 a 19 cifre;
// - un valore che l'utente ha scritto in chat dopo parole come
//   «password / chiave / token / pin» (come request_secure_input insegna);
// - un prefisso noto di chiave (sk-, ak_, secret_, ghp_, xox).
// Il messaggio verso il modello NON contiene MAI il valore (e la entry del
// transcript la si redige nel loop, dove la chiamata viene rifiutata).
// In più (T8a): un blocco <evento> esterno nel messaggio che apre il turno
// contamina il turno, come una pagina web letta.
/** T8a: il testo del turno contiene un blocco <evento> (evidenza esterna)? */
export function hasExternalEvento(turnText: string): boolean {
  return /<evento>[\s\S]*?<\/evento>/.test(turnText)
}

// ---- T8b: i rilevatori (puri) ----

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

/** I numeri di carta (13-19 cifre, anche a gruppi separati da spazi) che passano Luhn. */
export function luhnCardNumbers(text: string): string[] {
  const out: string[] = []
  const re = /\b\d[\d ]{11,22}\d\b/g
  for (const m of text.matchAll(re)) {
    const compact = m[0].replace(/ /g, '')
    if (compact.length >= 13 && compact.length <= 19 && luhnOk(compact) && !out.includes(compact)) out.push(compact)
  }
  return out
}

/** I prefissi noti di chiave con il loro valore (una run di caratteri da chiave). */
export const KEY_PREFIXES = ['sk-', 'ak_', 'secret_', 'ghp_', 'xox'] as const

/** Le chiavi con prefisso noto che compaiono nel testo. */
export function knownKeyPrefixHits(text: string): string[] {
  const out: string[] = []
  const re = new RegExp(`(?:${KEY_PREFIXES.map((p) => p.replace(/[-_]/g, '\\$&')).join('|')})[A-Za-z0-9_-]{4,}`, 'g')
  for (const m of text.matchAll(re)) {
    if (!out.includes(m[0])) out.push(m[0])
  }
  return out
}

/** Le parole che annunciano un segreto in chat (italiano e inglese, come request_secure_input). */
const SECRET_WORDS = 'password|passphrase|passcode|chiave|segreto|secret|token|api[ -]?key|pin'
// il separatore «è» (italiano) come escape unicode: la guardia del testo
// italiano dei sorgenti vede solo ASCII in questo letterale

/**
 * I valori che l'utente ha scritto in chat dopo una parola di segreto
 * («la mia password è X», «token: Y», «chiave api Z»): almeno 6 caratteri,
 * perché un PIN di 4 cifre da solo non è un segreto utilizzabile (puro).
 */
export function chatSecretValues(userTexts: readonly string[]): string[] {
  const out: string[] = []
  const re = new RegExp(`(?:${SECRET_WORDS})[^\\n.]{0,24}?(?::|=|\\u00e8|e'|is|\\s)\\s*["']?([!-~]{6,64})["']?`, 'gi')
  for (const text of userTexts) {
    for (const m of text.matchAll(re)) {
      const v = m[1]!.trim().replace(/[,.:;)>]+$/, '')
      // la parola catturata non può essere la parola di segreto stessa
      if (v.length >= 6 && !new RegExp(`^(?:${SECRET_WORDS})$`, 'i').test(v) && !out.includes(v)) out.push(v)
    }
  }
  return out
}

/** I tool i cui argomenti vanno verso l'esterno o verso un sito (T8b): guardati. */
export const GUARDED_ARG_TOOLS: ReadonlySet<string> = new Set([
  'browser_type', 'browser_select', 'draft_external', 'send_to_agent',
  'offer_connector', 'add_mcp_server', 'web_fetch', 'run-command', 'fill_credential'
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
 * La sentinella (pura): rifiuta gli argomenti di un tool verso l'esterno che
 * contengono un numero di carta (Luhn), una chiave col prefisso noto o un
 * segreto che l'utente ha scritto in chat. web_fetch guarda SOLO l'url.
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
  for (const t of texts) {
    if (luhnCardNumbers(t).length) return { ok: false, reason: ARG_GUARD_REFUSAL }
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
 * chiamata rifiutata dalla sentinella: i valori che contengono il segreto
 * (o la carta/chiave) diventano «[redacted]» — il valore non compare MAI
 * nel transcript (puro).
 */
export function redactGuardedArgs(
  input: Record<string, unknown>,
  userChatTexts: readonly string[]
): Record<string, unknown> {
  const chatSecrets = chatSecretValues(userChatTexts)
  const redactString = (t: string): string => {
    let out = t
    // la carta può stare nel testo anche A GRUPPI SPAZIATI: si redige in
    // entrambe le forme (compatta e spaziata)
    for (const n of luhnCardNumbers(t)) {
      const spaced = n.replace(/(\d)(?=(\d{4})+$)/g, '$1 ')
      out = out.replace(spaced, '[redacted]')
      out = out.replace(n, '[redacted]')
    }
    for (const k of knownKeyPrefixHits(t)) out = out.replace(k, '[redacted]')
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
