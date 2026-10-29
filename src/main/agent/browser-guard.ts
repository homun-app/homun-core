// Difese e decisioni del BROWSER del bot (fase 11b, punto 2) — funzioni PURE:
// il parser dei ref dello snapshot (ruolo e nome di un elemento), la
// classificazione del rischio delle azioni con effetti sui siti, il
// riconoscimento delle pagine costruite in JavaScript, la sfida anti-bot nello
// snapshot e il troncamento. Niente Docker, niente rete, niente Electron:
// lo stato (ultimo snapshot per bot) vive nel manager (browser.ts).
import { WEB_FETCH_MAX_CHARS } from '../../shared/web-limits'
import { CHALLENGE_SIGNATURES, challengeBlocked } from './web-tools'

/**
 * Parole e frasi (IT ed EN) che indicano INVIO o IMPEGNO sul NOME o sul TESTO
 * dell'elemento cliccato (ask), di QUALUNQUE ruolo: "Conferma prenotazione",
 * "Submit order", "Paga ora", "place order", "Iscriviti"…
 */
export const COMMIT_WORDS = [
  // IT
  'invia', 'invio', 'inviare', 'conferma', 'confermo', 'confermare', 'prenota', 'prenoto',
  'prenotare', 'acquista', 'acquisto', 'acquistare', 'paga', 'pago', 'pagare', 'ordina',
  'ordino', 'compra', 'compro', 'iscriviti', 'registrati', 'elimina', 'cancella', 'pubblica',
  'procedi al pagamento', 'paga ora', 'conferma ordine',
  // EN
  'submit', 'send', 'confirm', 'book', 'buy', 'pay', 'order', 'place order', 'checkout',
  'sign up', 'subscribe', 'delete', 'publish'
] as const

/**
 * Parole e frasi dei campi in cui il bot NON scrive MAI credenziali o dati di
 * pagamento (deny), di QUALUNQUE ruolo in cui si scrive: password, carta,
 * CVV, IBAN, "codice fiscale", "numero carta"… (IT ed EN).
 */
export const CREDENTIAL_FIELD_WORDS = [
  'password', 'passphrase', 'carta', 'card', 'cvv', 'cvc', 'iban', 'pin',
  'codice fiscale', 'fiscal code', 'card number', 'numero carta', 'security code',
  'codice di sicurezza'
] as const

/** I tool del browser che agiscono su un elemento tramite ref. */
export const REF_TOOLS = new Set(['browser_click', 'browser_type', 'browser_select'])

/**
 * Un ref valido (I5): ESATTAMENTE `[A-Za-z0-9]+` (i formati reali di Playwright
 * MCP sono `e12`, `f5e44`). Qualunque altro valore — selettori CSS, `text=…`,
 * spazi, parentesi — non è un ref e NON si ripulisce né si passa a MCP: una
 * pagina ostile può mettere un attributo `e5` sul pulsante "Paga" e un ref
 * `[e5]` verrebbe usato come selettore di attributo.
 */
export const VALID_REF_RE = /^[A-Za-z0-9]+$/

/** Il deny quando il ref non è un ref dello snapshot (I5). */
export const INVALID_REF_DENY_TEXT =
  'Questo non è un ref dello snapshot: selettori, path e composizioni non si passano al browser. Usa solo i ref dello snapshot (es. e12).'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Confronto per PAROLA INTERA, case-insensitive e Unicode (`\P{L}`): una voce
 * della lista conta solo come parola o frase intera, mai come pezzo di un'altra
 * parola ("Facebook" non contiene "book", "Shipping address" non contiene
 * "pin", "La tua opinione" non contiene "pin").
 */
const matchesWholeWord = (text: string, words: readonly string[]): boolean => {
  const low = text.toLowerCase()
  return words.some((w) => {
    const body = w.toLowerCase().split(/\s+/).map(escapeRe).join('\\s+')
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u').test(low)
  })
}

/** Ruolo, nome e testo di un elemento dello snapshot (null se il ref non c'è). */
export interface RefInfo {
  role: string
  /** il nome accessibile, tra virgolette nella riga dello snapshot */
  name: string
  /** il testo in linea dopo `:` sulla stessa riga, se c'è (es. `- generic [ref=e5] [cursor=pointer]: Paga ora`) */
  text: string
}

/**
 * Il parser dei ref (PURO): cerca nell'ultimo snapshot la riga con
 * `[ref=<ref>]` e ne estrae ruolo, nome accessibile e testo in linea dopo `:`,
 * nel formato di Playwright MCP (`- button "Conferma" [ref=s3e12]`,
 * `- generic [ref=e5] [cursor=pointer]: Paga ora`). Il campo `element` che
 * scrive il modello NON vale: la verità è lo snapshot che il daemon ha ricevuto.
 */
export function refInfo(snapshot: string | null, ref: string): RefInfo | null {
  if (!snapshot || !ref) return null
  const token = ref.replace(/[^\w:-]/g, '') // il ref è opaco: niente regex injection
  if (!token) return null
  const re = new RegExp(`^\\s*-\\s+(\\w+)(?:\\s+"([^"]*)")?[^\\n]*?\\[ref=${token}(?:\\]|,|\\s)([^\\n]*)`, 'm')
  const m = re.exec(snapshot)
  if (!m) return null
  // il testo in linea: il primo `:` DOPO il ref (quelli del nome sono tra virgolette)
  const rest = m[3] ?? ''
  const colon = rest.indexOf(':')
  return { role: m[1]!.toLowerCase(), name: m[2] ?? '', text: colon >= 0 ? rest.slice(colon + 1).trim() : '' }
}

export type BrowserActionRisk =
  | { kind: 'free' }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string }

/** Il testo del deny sui campi con credenziali o dati di pagamento. */
export const CREDENTIAL_DENY_TEXT =
  'Non scrivo MAI password, dati di carta o credenziali in un sito: chiedi all\'utente di completare lui questo passaggio (puoi dirgli il campo esatto e la pagina).'

/**
 * La classificazione PURA del rischio di un'azione del browser (punto 2, I5 e
 * I6). `ref` è ruolo+nome+testo ricavato dall'ULTIMO snapshot (refInfo): ciò
 * che il modello dice dell'elemento non conta. Regole:
 * - deny: un ref che NON è esattamente `^[A-Za-z0-9]+$` (I5: selettori e
 *   composizioni non passano mai a MCP); browser_type su un campo di
 *   credenziali o pagamento (QUALUNQUE ruolo, parola intera);
 * - ask: un ref ben formato ma NON presente nell'ultimo snapshot;
 *   browser_type con submit:true; un click su un elemento il cui nome o testo
 *   indica invio/impegno (COMMIT_WORDS, qualunque ruolo); browser_press_key
 *   con Enter/NumpadEnter (Invio può inviare il modulo);
 * - free: navigazione, lettura, click su link/pulsanti non di invio,
 *   digitazione in campi normali (es. ricerca), gli altri tasti.
 */
export function browserActionRisk(
  tool: string,
  args: Record<string, unknown>,
  ref: RefInfo | null
): BrowserActionRisk {
  const askedRef = String(args.ref ?? '')
  // I5: il ref degli strumenti che agiscono su un elemento (e il ref opzionale
  // di browser_snapshot) deve essere ESATTAMENTE un ref dello snapshot
  if (REF_TOOLS.has(tool) || (tool === 'browser_snapshot' && askedRef !== '')) {
    if (!VALID_REF_RE.test(askedRef)) {
      return { kind: 'deny', reason: INVALID_REF_DENY_TEXT }
    }
    if (!ref) {
      return {
        kind: 'ask',
        reason: `ref "${askedRef}" non presente nell'ultimo snapshot ricevuto: ricarica la pagina con browser_snapshot prima di agire`
      }
    }
  }
  // le parole si cercano nel nome accessibile E nel testo in linea (I6)
  const words = `${ref?.name ?? ''} ${ref?.text ?? ''}`.trim()
  if (tool === 'browser_type') {
    if (ref && matchesWholeWord(words, CREDENTIAL_FIELD_WORDS)) {
      return { kind: 'deny', reason: CREDENTIAL_DENY_TEXT }
    }
    if (args.submit === true) {
      return { kind: 'ask', reason: `browser_type con submit: true invia il modulo (campo "${ref?.name || ref?.text || '?'}")` }
    }
    return { kind: 'free' }
  }
  if (tool === 'browser_press_key') {
    const key = String(args.key ?? '')
    if (key === 'Enter' || key === 'NumpadEnter') {
      return { kind: 'ask', reason: 'Invio può inviare il modulo (come browser_type con submit: true): se c\'è un modulo compilato, questo lo spedisce' }
    }
    return { kind: 'free' }
  }
  if (tool === 'browser_click' && ref && matchesWholeWord(words, COMMIT_WORDS)) {
    return { kind: 'ask', reason: `click su "${ref.name || ref.text}" (${ref.role}): un'azione che invia, compra o impegna` }
  }
  return { kind: 'free' }
}

// ---- fase 12 (0a): il tipo di campo letto DENTRO la pagina (browser_evaluate interno) ----

/**
 * Le informazioni del campo raccolte dal daemon con la chiamata MCP
 * `browser_evaluate` INTERNA (mai esposta al modello): un `<input
 * type="password">` senza etichetta compare nello snapshot come
 * `textbox [ref=f1e18]`, senza nome — il deny sul nome accessibile non scatta.
 */
export interface FieldProbeInfo {
  type: string
  autocomplete: string
  name: string
  id: string
  placeholder: string
  label: string
  aria: string
}

/**
 * Il prefisso dell'autocomplete che indica credenziali o dati di pagamento:
 * `current-password`, `new-password`, `one-time-code` o i campi carta (`cc-…`).
 */
const AUTOCOMPLETE_CREDENTIAL_RE = /(^|\s)(current-password|new-password|one-time-code|cc-)/

/**
 * fieldIsCredential (pura, 0a): il campo è di credenziali o pagamento per il
 * TIPO, per l'autocomplete o per una parola intera in name/id/placeholder/
 * label/aria → il deny di browser_type scatta anche senza nome accessibile.
 */
export function fieldIsCredential(info: FieldProbeInfo): boolean {
  if (info.type === 'password') return true
  if (AUTOCOMPLETE_CREDENTIAL_RE.test(info.autocomplete)) return true
  return matchesWholeWord(
    `${info.name} ${info.id} ${info.placeholder} ${info.label} ${info.aria}`,
    CREDENTIAL_FIELD_WORDS
  )
}

/**
 * Correzione J3: il result REALE di browser_evaluate (Playwright MCP 0.0.83)
 * NON è JSON nudo — è markdown: riga `### Result` col JSON del ritorno della
 * funzione, poi `### Ran Playwright code` col codice e `### Page` con le
 * righe della pagina. Il parser prende il testo dopo `### Result` fino alla
 * prima riga successiva che inizia con `### ` e fa JSON.parse. null se la
 * sezione non c'è o il corpo non è un oggetto (valutazione non leggibile: il
 * chiamante in quel caso chiede all'utente, mai free).
 */
export function parseEvaluateResult(mcpResultText: string): FieldProbeInfo | null {
  const lines = mcpResultText.split('\n')
  const start = lines.findIndex((l) => l.trim() === '### Result')
  if (start < 0) return null
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*###/.test(lines[i]!)) break
    body.push(lines[i]!)
  }
  try {
    const info = JSON.parse(body.join('\n')) as Partial<FieldProbeInfo>
    // solo un oggetto è un campo: un array o un primitivo non sono leggibili
    if (typeof info !== 'object' || info === null || Array.isArray(info)) return null
    return {
      type: String(info.type ?? ''), autocomplete: String(info.autocomplete ?? ''),
      name: String(info.name ?? ''), id: String(info.id ?? ''),
      placeholder: String(info.placeholder ?? ''), label: String(info.label ?? ''),
      aria: String(info.aria ?? '')
    }
  } catch {
    return null
  }
}

/** Il testo dell'ask quando la verifica interna del campo NON riesce (J3). */
export const FIELD_PROBE_ASK_TEXT = 'non riesco a verificare il tipo del campo'

/**
 * Correzione J3: la decisione di browser_type dopo la verifica INTERNA del
 * campo. `credential` è l'esito di fieldIsCredentialRef: true/false quando la
 * valutazione è riuscita, null quando è fallita. Quando RIESCE decide il
 * campo VERO: deny se è di credenziali; se NON lo è, il deny venuto dal NOME
 * ACCESSIBILE dello snapshot NON conta più (in quotes.toscrape.com/login il
 * campo username si chiama "Username Password" ma è {type: "text", name:
 * "username", label: "Username"}): resta solo l'ask di submit. Quando FALLISCE
 * le regole dello snapshot restano e un free NON resta free (ask, mai free).
 */
export function applyFieldProbe(
  risk: BrowserActionRisk,
  args: Record<string, unknown>,
  ref: RefInfo | null,
  credential: boolean | null
): BrowserActionRisk {
  if (credential === true) return { kind: 'deny', reason: CREDENTIAL_DENY_TEXT }
  if (credential === false) {
    // il campo vero non è di credenziali: il deny del nome non conta; l'ask
    // del submit (o di altro) resta quello di browserActionRisk
    if (risk.kind !== 'deny') return risk
    return args.submit === true
      ? { kind: 'ask', reason: `browser_type con submit: true invia il modulo (campo "${ref?.name || ref?.text || '?'}")` }
      : { kind: 'free' }
  }
  if (risk.kind === 'free') return { kind: 'ask', reason: FIELD_PROBE_ASK_TEXT }
  return risk
}

// ---- il passaggio da web_fetch al browser (decisione in codice) ----
// looksJsBuiltPage e JS_PAGE_HINT vivono in web-guard (li usa anche web_fetch)
export { looksJsBuiltPage, JS_PAGE_HINT } from './web-guard'

// ---- la sfida anti-bot nello snapshot ----

/**
 * Lo snapshot contiene una sfida (puro, punto 2): riusa CHALLENGE_SIGNATURES
 * e challengeBlocked sul TESTO dello snapshot. Il browser non si usa MAI per
 * aggirare un blocco incontrato con web_fetch: qui si dichiara e si segnala.
 */
export function snapshotChallenge(snapshotText: string): boolean {
  const low = snapshotText.toLowerCase()
  return CHALLENGE_SIGNATURES.some((s) => low.includes(s)) || challengeBlocked(200, snapshotText, snapshotText)
}

/** La nota del result quando lo snapshot contiene una sfida. */
export const SNAPSHOT_BLOCKED_NOTE =
  'Pagina bloccata da una verifica anti-bot: NON aggirarla, segnalalo all\'utente (la pagina non è leggibile).'

// ---- troncamento dello snapshot al modello ----

export const SNAPSHOT_MAX_CHARS = WEB_FETCH_MAX_CHARS

/** La nota quando lo snapshot supera il tetto (il modello restringe con ref/depth). */
export const SNAPSHOT_TRUNCATED_NOTE = '[snapshot lungo: usa browser_snapshot con ref o depth]'

/**
 * Lo snapshot al modello: al massimo 20.000 caratteri per result (puro); oltre,
 * la nota che dice come restringerlo (funzione equivalente a sliceWithOffset).
 */
export function truncateSnapshot(text: string): { text: string; truncated: boolean } {
  if (text.length <= SNAPSHOT_MAX_CHARS) return { text, truncated: false }
  return { text: text.slice(0, SNAPSHOT_MAX_CHARS) + '\n\n' + SNAPSHOT_TRUNCATED_NOTE, truncated: true }
}

// ---- l'URL corrente della pagina, preso dal result MCP ----

/**
 * L'URL della pagina dal result MCP (puro): Playwright MCP riporta la riga
 * `Page URL: <url>` nei result con snapshot; null se il result non la porta
 * (il chiamante usa l'ultima URL nota del bot).
 */
export function browserPageUrl(mcpResultText: string): string | null {
  const m = /(?:^|\n)\s*(?:-\s+)?Page URL:\s*(\S+)/i.exec(mcpResultText)
  return m ? m[1]! : null
}

// ---- il result composto delle azioni (I3) ----

/**
 * Le righe del result dell'azione che passano al modello: lo stato della
 * pagina. MAI `### Ran Playwright code`, i link `.browser/output/…` né le
 * righe `### Events` (rumore, e path del box che il modello non deve usare).
 */
const ACTION_KEEP_LINE = /^\s*-\s+(?:Page URL|Page Title|HTTP status):/

/** Le sezioni del result dell'azione che passano: l'errore e lo stato modale. */
const ACTION_KEEP_SECTION = /^\s*###\s*(?:Error|Modal state)\s*$/

/** Una riga di pagina (`- Page URL: …`, con o senza il trattino iniziale). */
const PAGE_LINE_RE = /(?:^|\n)\s*(?:-\s+)?(?:Page URL|Page Title|HTTP status):/

/**
 * Il result che il modello vede dopo un'azione (PURO): le righe di pagina e le
 * sezioni Error/Modal state, più lo snapshot INLINE chiesto a parte dal daemon
 * — le azioni di Playwright MCP 0.0.83 scrivono lo snapshot in un FILE e solo
 * browser_snapshot lo restituisce inline, quindi senza questo montaggio il
 * modello non vedrebbe mai la pagina.
 * Fase 12 (0b): le righe di pagina si prendono dallo SNAPSHOT, che è il più
 * recente (la navigazione dell'azione può averle già cambiate): dall'azione
 * restano solo `### Error` e `### Modal state`. Se lo snapshot non ha righe
 * di pagina, si usano quelle dell'azione.
 */
export function composeBrowserResult(actionText: string, snapshotText: string): string {
  const snapshotHasPage = PAGE_LINE_RE.test(snapshotText)
  const kept: string[] = []
  let inSection = false
  for (const line of actionText.split('\n')) {
    if (ACTION_KEEP_SECTION.test(line)) {
      inSection = true
      kept.push(line)
      continue
    }
    if (/^\s*###/.test(line)) {
      inSection = false // le altre sezioni (Ran code, Snapshot-link, Events) si buttano
      continue
    }
    if (ACTION_KEEP_LINE.test(line)) {
      if (!snapshotHasPage) kept.push(line)
      continue
    }
    if (inSection) kept.push(line) // il corpo di ### Error / ### Modal state
  }
  return [kept.join('\n').trim(), snapshotText.trim()].filter(Boolean).join('\n')
}

/**
 * La sola sezione `### Error` di un result MCP (pura, 0c): è ciò che resta del
 * result di browser_screenshot oltre al path del file (niente `### Ran
 * Playwright code` né link alle uscite).
 */
export function errorSection(mcpResultText: string): string {
  const kept: string[] = []
  let inError = false
  for (const line of mcpResultText.split('\n')) {
    if (ACTION_KEEP_SECTION.test(line)) {
      inError = line.trim() === '### Error'
      if (inError) kept.push(line)
      continue
    }
    if (/^\s*###/.test(line)) {
      inError = false
      continue
    }
    if (inError) kept.push(line)
  }
  return kept.join('\n').trim()
}
