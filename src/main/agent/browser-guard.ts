// Difese e decisioni del BROWSER del bot (fase 11b, punto 2) — funzioni PURE:
// il parser dei ref dello snapshot (ruolo e nome di un elemento), la
// classificazione del rischio delle azioni con effetti sui siti, il
// riconoscimento delle pagine costruite in JavaScript, la sfida anti-bot nello
// snapshot e il troncamento. Niente Docker, niente rete, niente Electron:
// lo stato (ultimo snapshot per bot) vive nel manager (browser.ts).
import { WEB_FETCH_MAX_CHARS } from '../../shared/web-limits'
import { CHALLENGE_SIGNATURES, challengeBlocked } from './web-tools'

/**
 * Nomi di pulsanti/link che indicano INVIO o IMPEGNO (ask): lista in una
 * costante, test case-insensitive, IT ed EN (punto 2).
 */
export const COMMIT_BUTTON_NAMES = [
  'invia', 'conferma', 'prenota', 'acquista', 'paga', 'ordina', 'compra', 'iscriviti',
  'registrati', 'elimina', 'cancella', 'pubblica',
  'submit', 'send', 'confirm', 'book', 'buy', 'pay', 'order', 'checkout', 'sign up', 'delete', 'publish'
] as const

/**
 * Nomi dei campi in cui il bot NON scrive MAI credenziali o dati di pagamento
 * (deny): ruolo textbox con un nome che contiene una di queste (IT ed EN).
 */
export const CREDENTIAL_FIELD_NAMES = [
  'password', 'passphrase', 'carta', 'card', 'cvv', 'cvc', 'iban',
  'codice fiscale', 'fiscal code', 'pagamento', 'payment', 'pin'
] as const

/** I tool del browser che agiscono su un elemento tramite ref. */
export const REF_TOOLS = new Set(['browser_click', 'browser_type', 'browser_select'])

const matchesAny = (name: string, words: readonly string[]): boolean => {
  const low = name.toLowerCase()
  return words.some((w) => low.includes(w))
}

/** Ruolo e nome di un elemento dello snapshot (null se il ref non c'è). */
export interface RefInfo {
  role: string
  name: string
}

/**
 * Il parser dei ref (PURO): cerca nell'ultimo snapshot la riga con
 * `[ref=<ref>]` e ne estrae ruolo e nome accessibile, nel formato di
 * Playwright MCP (`- button "Conferma" [ref=s3e12]`). Il campo `element` che
 * scrive il modello NON vale: la verità è lo snapshot che il daemon ha ricevuto.
 */
export function refInfo(snapshot: string | null, ref: string): RefInfo | null {
  if (!snapshot || !ref) return null
  const token = ref.replace(/[^\w:-]/g, '') // il ref è opaco: niente regex injection
  if (!token) return null
  const re = new RegExp(`^\\s*-\\s+(\\w+)(?:\\s+"([^"]*)")?[^\\n]*\\[ref=${token}(?:\\]|,|\\s)`, 'm')
  const m = re.exec(snapshot)
  if (!m) return null
  return { role: m[1]!.toLowerCase(), name: m[2] ?? '' }
}

export type BrowserActionRisk =
  | { kind: 'free' }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string }

/** Il testo del deny sui campi con credenziali o dati di pagamento. */
export const CREDENTIAL_DENY_TEXT =
  'Non scrivo MAI password, dati di carta o credenziali in un sito: chiedi all\'utente di completare lui questo passaggio (puoi dirgli il campo esatto e la pagina).'

/**
 * La classificazione PURA del rischio di un'azione del browser (punto 2).
 * `ref` è il ruolo+nome ricavato dall'ULTIMO snapshot (refInfo): ciò che il
 * modello dice dell'elemento non conta. Regole:
 * - ask: un ref NON presente nell'ultimo snapshot; browser_type con
 *   submit:true; un click su un pulsante/link il cui nome indica invio o
 *   impegno (COMMIT_BUTTON_NAMES, IT ed EN);
 * - deny: browser_type su un campo password o carta (ruolo textbox + nome
 *   CREDENTIAL_FIELD_NAMES) — il bot non scrive mai credenziali o pagamenti;
 * - free: navigazione, lettura, click su link/pulsanti non di invio,
 *   digitazione in campi normali (es. ricerca).
 */
export function browserActionRisk(
  tool: string,
  args: Record<string, unknown>,
  ref: RefInfo | null
): BrowserActionRisk {
  if (REF_TOOLS.has(tool)) {
    const askedRef = String(args.ref ?? '')
    if (!ref) {
      return {
        kind: 'ask',
        reason: `ref "${askedRef}" non presente nell'ultimo snapshot ricevuto: ricarica la pagina con browser_snapshot prima di agire`
      }
    }
  }
  if (tool === 'browser_type') {
    if (ref && ref.role === 'textbox' && matchesAny(ref.name, CREDENTIAL_FIELD_NAMES)) {
      return { kind: 'deny', reason: CREDENTIAL_DENY_TEXT }
    }
    if (args.submit === true) {
      return { kind: 'ask', reason: `browser_type con submit: true invia il modulo (campo "${ref?.name ?? '?'}")` }
    }
    return { kind: 'free' }
  }
  if (tool === 'browser_click' && ref && (ref.role === 'button' || ref.role === 'link')) {
    if (matchesAny(ref.name, COMMIT_BUTTON_NAMES)) {
      return { kind: 'ask', reason: `click su "${ref.name}" (${ref.role}): un'azione che invia, compra o impegna` }
    }
  }
  return { kind: 'free' }
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
