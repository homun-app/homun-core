// Credenziali per il browser (fase 14, punto 7d) — moduli PURI: il TOTP
// (RFC 6238: SHA-1, 30 s, 6 cifre, node:crypto) e i controlli che il daemon
// fa su fill_credential, NEL CODICE e in quest'ordine:
// 1. ORIGINE: l'URL della pagina corrente è https: e la sua origine è
//    ESATTAMENTE una delle origins del login (niente wildcard, niente
//    sottodomini): è la difesa anti-phishing di ogni password manager;
// 2. REF: ogni ref ha un formato valido (`^[A-Za-z0-9]+$`) ed è presente
//    nell'ultimo snapshot; il tipo del campo si verifica col probe interno
//    del browser (browser-guard), che porta anche l'origine del FRAME e il
//    fatto che il campo stia nel documento TOP. Q2 (fase 14 correzioni 2):
//    il PREFISSO `f<n>` del ref NON è più un segnale di iframe — dalla
//    seconda navigazione nella scheda lo hanno anche i campi del documento
//    principale (Playwright MCP vero: e5 → f1e5), e un login vero passa
//    quasi sempre da una navigazione. "È in un iframe" lo dice solo il probe
//    (`top`), come fanno i password manager.
// Il valore NON entra MAI nel contesto del modello: va dal vault al campo.
import { createHmac } from 'node:crypto'
// fase 17c (C3): le validazioni TOTP si mostrano nel modulo sicuro (UI) —
// testi del catalogo UI; gli errori NON contengono mai i valori
import { uiText } from '../ui-language'
import { UI } from '../../shared/ui-messages'
// fase 19a (correzioni 3, M5): la neutralizzazione dell'etichetta nella nota
// del form di login è la STESSA con cui i testi che tornano al modello si
// troncano da sempre (previewOf, modulo puro senza import)
import { previewOf } from './turn-sends'

// ---- TOTP (RFC 6238) ----

/** La finestra temporale del TOTP (secondi). */
export const TOTP_PERIOD_SEC = 30

/** Le cifre del codice. */
export const TOTP_DIGITS = 6

/** base32 (RFC 4648, senza padding) → Buffer: il formato dei segreti TOTP. */
export function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = s.toUpperCase().replace(/[=\s]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch)
    if (idx < 0) throw new Error(uiText(UI.totpBadChar, { ch }))
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** Il contatore RFC 6238 dell'istante (puro). */
export function totpCounter(atMs: number, periodSec = TOTP_PERIOD_SEC): bigint {
  return BigInt(Math.floor(atMs / 1000 / periodSec))
}

/**
 * Il codice TOTP di ADESSO (RFC 6238: HMAC-SHA-1, 30 s, 6 cifre). Il segreto
 * è la stringa base32 salvata nel vault; calcolato al momento del fill, mai
 * prima, mai dopo, mai nel contesto del modello.
 */
export function totpCode(secretBase32: string, atMs: number = Date.now()): string {
  const key = base32Decode(secretBase32)
  const counter = totpCounter(atMs)
  // contatore big-endian a 8 byte
  const msg = Buffer.from(counter.toString(16).padStart(16, '0'), 'hex')
  const digest = createHmac('sha1', key).update(msg).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

// ---- il segreto TOTP al salvataggio (P4, fase 14 correzioni) ----

/** Il risultato della lettura del segreto TOTP (puro). */
export type TotpSecretCheck =
  | { ok: true; secret: string }
  | { ok: false; error: string }

/**
 * Il segreto TOTP accettato da saveLogin (puro, P4): base32 (spazi, minuscole
 * e padding ammessi e normalizzati via) oppure un URI `otpauth://totp/…?
 * secret=…` come quelli che i siti mostrano sotto il QR. Dall'URI si estrae
 * `secret`; algorithm/digits/period diversi da SHA1/6/30 sono NON SUPPORTATI
 * e si rifiutano con errore chiaro — mai un codice sbagliato in silenzio. Il
 * segreto si VERIFICA con base32Decode prima di tornarlo: gli errori non
 * contengono MAI il valore (vanno all'utente nel modulo, non al modello).
 */
export function parseTotpSecret(input: string): TotpSecretCheck {
  const raw = input.trim()
  if (!raw) return { ok: false, error: uiText(UI.totpEmpty) }
  let candidate = raw
  if (/^otpauth:\/\//i.test(raw)) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      return { ok: false, error: uiText(UI.totpBadUri) }
    }
    if (u.protocol !== 'otpauth:') return { ok: false, error: uiText(UI.totpNotTotpUri) }
    const type = u.host.toLowerCase()
    if (type !== 'totp') return { ok: false, error: uiText(UI.totpWrongType, { type: u.host }) }
    const secret = u.searchParams.get('secret') ?? ''
    if (!secret.trim()) return { ok: false, error: uiText(UI.totpNoSecret) }
    const algorithm = (u.searchParams.get('algorithm') ?? 'SHA1').toUpperCase()
    const digits = u.searchParams.get('digits') ?? '6'
    const period = u.searchParams.get('period') ?? '30'
    if (algorithm !== 'SHA1' || digits !== '6' || period !== '30') {
      return {
        ok: false,
        error: uiText(UI.totpUnsupported, { algorithm, digits, period })
      }
    }
    candidate = secret
  }
  // normalizzazione: maiuscole, senza spazi né padding
  const normalized = candidate.toUpperCase().replace(/[\s=]/g, '')
  if (!normalized) return { ok: false, error: uiText(UI.totpEmpty) }
  try {
    base32Decode(normalized)
  } catch {
    return { ok: false, error: uiText(UI.totpNotBase32) }
  }
  return { ok: true, secret: normalized }
}

// ---- l'origine della pagina (punto 7d, controllo 1) ----

/**
 * L'origine ESATTA di un URL (`https://host[:porta]`), null se non è https.
 * (puro)
 */
export function httpsOriginOf(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  return `https://${u.host}`
}

export type FillOriginCheck =
  | { ok: true; origin: string }
  | { ok: false; error: string }

/**
 * Il controllo dell'ORIGINE (puro, punto 7d-1): la pagina è https e la sua
 * origine è ESATTAMENTE una delle origins del login. L'errore dice l'origine
 * della pagina e quelle del login, MAI i valori (username/password/TOTP).
 */
export function checkFillOrigin(login: { label: string; origins: string[] }, pageUrl: string | null): FillOriginCheck {
  const page = pageUrl ? httpsOriginOf(pageUrl) : null
  if (!pageUrl || !page) {
    const shown = pageUrl ? pageUrl.slice(0, 120) : '(no page open)'
    return {
      ok: false,
      error: `the page origin is not valid for the login: the page is ${shown} and "${login.label}" is for ${login.origins.join(', ')}. Open the site page yourself and try again.`
    }
  }
  if (!login.origins.includes(page)) {
    return {
      ok: false,
      error: `the page origin is not the login's one: the page is ${page} and "${login.label}" is for ${login.origins.join(', ')} (no subdomain or different port). If the site is right, save it as a new login.`
    }
  }
  return { ok: true, origin: page }
}

// ---- i ref dei campi (punto 7d, controllo 2) ----

export type FillRefCheck =
  | { ok: true; ref: string }
  | { ok: false; error: string }

/**
 * Il controllo dei REF (puro, punto 7d-2): il ref ha un formato valido
 * (`^[A-Za-z0-9]+$`, come REF_TOOLS); la presenza nello snapshot la verifica
 * il chiamante con refInfo (la verità è lo snapshot ricevuto, mai ciò che
 * dice il modello). Q2 (fase 14 correzioni 2): QUI non si rifiuta più il
 * prefisso `f<n>` — nel Playwright MCP vero, dalla seconda navigazione nella
 * scheda lo hanno anche i ref del documento PRINCIPALE (e5 → f1e5: è solo
 * "documento diverso dal primo", non "iframe"), quindi quel rifiuto
 * bloccava il caso d'uso normale del login (apro il sito, clicco "Accedi",
 * arriva la pagina del login). Il campo è davvero in un iframe lo scopre
 * SOLO il probe: checkFieldFrame (`top`), prima della card e prima di ogni
 * scrittura.
 */
export function checkFillRef(ref: unknown, kind: 'username' | 'password' | 'totp'): FillRefCheck {
  const r = String(ref ?? '').trim()
  if (!r) return { ok: false, error: `missing ${kind}_ref: the field refs taken from the snapshot are required` }
  if (!/^[A-Za-z0-9]+$/.test(r)) {
    return { ok: false, error: `"${r.slice(0, 40)}" is not a snapshot ref (${kind}_ref are snapshot refs, e.g. e12 or f1e12)` }
  }
  return { ok: true, ref: r }
}

/** I tipi di campo accettabili per username (testo, non password). */
export const USERNAME_FIELD_TYPES = new Set(['text', 'email', 'tel'])

export type FieldKindCheck =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Il controllo del TIPO di campo letto col probe interno (puro, punto 7d-2):
 * password_ref vuole type=password; username_ref vuole text/email/tel e NON
 * password; totp_ref un campo di testo NON password. `info` nullo = verifica
 * impossibile → rifiuto (mai fidarsi di un campo che non si è potuto leggere).
 */
export function checkFieldKind(
  kind: 'username' | 'password' | 'totp',
  info: { type: string } | null
): FieldKindCheck {
  if (!info) {
    return { ok: false, error: `cannot verify the type of the ${kind}_ref field inside the page: refused (if the field is right, try again after a browser_snapshot)` }
  }
  if (kind === 'password' && info.type !== 'password') {
    return { ok: false, error: `password_ref points to a field type="${info.type || '(unknown)'}" and not type="password": use the right refs from the snapshot` }
  }
  if (kind === 'username' && info.type === 'password') {
    return { ok: false, error: 'username_ref points to a password field: the username does not go in the password field' }
  }
  if (kind === 'username' && !USERNAME_FIELD_TYPES.has(info.type)) {
    return { ok: false, error: `username_ref points to a field type="${info.type || '(unknown)'}": text fields are required (text/email/tel)` }
  }
  if (kind === 'totp' && info.type === 'password') {
    return { ok: false, error: 'totp_ref points to a password field: the code goes in a text field' }
  }
  return { ok: true }
}

/**
 * Il controllo del FRAME del campo (puro, P3 fase 14 correzioni): il campo sta
 * nel documento TOP e la sua ORIGINE è quella attesa — l'origine del login
 * (una delle sue) PRIMA della card, quella APPROVATA subito prima di ogni
 * scrittura. È il confronto che fanno i password manager (1Password,
 * Bitwarden): l'origine del FRAME del campo al momento del fill, non l'ultima
 * URL nota della sessione (che per browser_open è l'URL richiesta, non quella
 * finale dopo i redirect). `info` nullo = verifica impossibile → rifiuto.
 */
export function checkFieldFrame(
  info: { origin: string; top: boolean } | null,
  expectedOrigins: string[]
): FieldKindCheck {
  if (!info) {
    return { ok: false, error: 'cannot read the field origin inside the page (frame check): refused' }
  }
  if (info.top !== true) {
    return { ok: false, error: 'the field is in an iframe: a frame can have a different origin. Use a field of the main page.' }
  }
  if (!expectedOrigins.includes(info.origin)) {
    return {
      ok: false,
      error: `the field origin (${info.origin || '(unknown)'}) is not the login's one (${expectedOrigins.join(', ')}): the page changed or is not the right one`
    }
  }
  return { ok: true }
}

/**
 * Il controllo completo del campo subito prima di OGNI scrittura (puro, P3):
 * nuovo probe → origine APPROVATA (quella mostrata nella card), campo nel
 * documento TOP e tipo ancora valido. Se la pagina è cambiata durante
 * l'approvazione (navigazione, redirect, DOM sostituito) il fill si ferma.
 */
export function checkFieldForWrite(
  kind: 'username' | 'password' | 'totp',
  info: FieldProbeLike | null,
  approvedOrigin: string
): FieldKindCheck {
  const frame = checkFieldFrame(info, [approvedOrigin])
  if (!frame.ok) return frame
  return checkFieldKind(kind, info)
}

/** Il minimo che serve dei due controlli di campo (tipo del probe). */
export interface FieldProbeLike {
  type: string
  origin: string
  top: boolean
}

// ---- l'esito per il modello (mai i valori) ----

/** Le parole dei campi compilati, per l'esito (puro). */
export function filledFieldsLabel(refs: { username?: boolean; password?: boolean; totp?: boolean }): string {
  const parts: string[] = []
  if (refs.username) parts.push('username')
  if (refs.password) parts.push('password')
  if (refs.totp) parts.push('code')
  return parts.join(' and ') || 'the fields'
}

/**
 * L'esito di fill_credential per il modello (punto 7d): dice label e origine,
 * MAI i valori.
 */
export function fillResultText(label: string, origin: string, refs: { username?: boolean; password?: boolean; totp?: boolean }): string {
  return `Filled ${filledFieldsLabel(refs)} of "${label}" on ${origin}.`
}

// ---- la nota sul form di login nel result del browser (fase 19a, correzioni 3) ----

/**
 * L'etichetta di un login come torna al modello nella nota del form (puro, M5):
 * una riga sola (niente a capo) e troncata — la stessa neutralizzazione con cui
 * list-credentials mostra le etichette dei testi che raggiungono il modello
 * (previewOf: trim, taglio a 120 con ellissi).
 */
export function loginLabelShown(label: string): string {
  return previewOf(label.replace(/\s+/g, ' ').trim())
}

/**
 * Il login salvato per l'origine ESATTA della pagina (puro, M5): il PRIMO se ce
 * ne sono più di uno, null se non c'è. È lo stesso confronto di checkFillOrigin
 * (origine esatta, niente sottodomini, niente porte diverse).
 */
export function findLoginForOrigin(
  pageUrl: string,
  logins: Array<{ id: string; label: string; origins: string[] }>
): { id: string; label: string; origins: string[] } | null {
  const page = httpsOriginOf(pageUrl)
  if (!page) return null
  return logins.find((l) => l.origins.includes(page)) ?? null
}

/**
 * La nota da aggiungere in fondo al result del browser quando la pagina ha un
 * form di login (puro, M5.1): la regola arriva COL DATO, al momento giusto, non
 * solo nel prompt di sistema — un'istruzione contestuale nel risultato vale
 * più di una riga del prompt (la stessa tecnica di SNAPSHOT_BLOCKED_NOTE per la
 * sfida anti-bot, che infatti funziona: caso 40 a 6/6 mentre il 41, con la
 * regola solo nel prompt, restava 1/6). Pagina non https o URL non valido →
 * null, niente nota. La nota non contiene MAI valori del vault: solo origine,
 * etichetta e id, che list-credentials già mostra.
 */
export function loginFormNote(
  pageUrl: string,
  logins: Array<{ id: string; label: string; origins: string[] }>
): string | null {
  const origin = httpsOriginOf(pageUrl)
  if (!origin) return null
  const login = findLoginForOrigin(pageUrl, logins)
  if (login) {
    return `This page has a sign-in form and a login is saved for ${origin}: "${loginLabelShown(login.label)}" (${login.id}). To sign in, use fill_credential with that id.`
  }
  return `This page has a sign-in form and no login is saved for ${origin}. If you need to sign in, call request_takeover: the user signs in on your screen. Never ask for the password in chat.`
}
