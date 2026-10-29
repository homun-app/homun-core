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
    if (idx < 0) throw new Error(`carattere base32 non valido: "${ch}"`)
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
  if (!raw) return { ok: false, error: 'il segreto TOTP è vuoto' }
  let candidate = raw
  if (/^otpauth:\/\//i.test(raw)) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      return { ok: false, error: 'URI otpauth non valido: copia il segreto base32 mostrato sotto il QR' }
    }
    if (u.protocol !== 'otpauth:') return { ok: false, error: 'serve un URI otpauth:// (TOTP)' }
    const type = u.host.toLowerCase()
    if (type !== 'totp') return { ok: false, error: `URI otpauth di tipo "${u.host}" non supportato: serve totp` }
    const secret = u.searchParams.get('secret') ?? ''
    if (!secret.trim()) return { ok: false, error: 'l\'URI otpauth non contiene il parametro secret' }
    const algorithm = (u.searchParams.get('algorithm') ?? 'SHA1').toUpperCase()
    const digits = u.searchParams.get('digits') ?? '6'
    const period = u.searchParams.get('period') ?? '30'
    if (algorithm !== 'SHA1' || digits !== '6' || period !== '30') {
      return { ok: false, error: `TOTP non supportato (algorithm ${algorithm}, digits ${digits}, period ${period}): solo SHA1, 6 cifre, 30 secondi` }
    }
    candidate = secret
  }
  // normalizzazione: maiuscole, senza spazi né padding
  const normalized = candidate.toUpperCase().replace(/[\s=]/g, '')
  if (!normalized) return { ok: false, error: 'il segreto TOTP è vuoto' }
  try {
    base32Decode(normalized)
  } catch {
    return { ok: false, error: 'il segreto TOTP non è base32 valido: copialo di nuovo dal sito (o l\'URI otpauth sotto il QR)' }
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
    const shown = pageUrl ? pageUrl.slice(0, 120) : '(nessuna pagina aperta)'
    return {
      ok: false,
      error: `l'origine della pagina non è valida per il login: la pagina è ${shown} e «${login.label}» è per ${login.origins.join(', ')}. Apri tu la pagina del sito e riprova.`
    }
  }
  if (!login.origins.includes(page)) {
    return {
      ok: false,
      error: `l'origine della pagina non è quella del login: la pagina è ${page} e «${login.label}» è per ${login.origins.join(', ')} (nessun sottodominio o porta diversa). Se il sito è giusto, salvalo come login nuovo.`
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
  if (!r) return { ok: false, error: `manca ${kind}_ref: servono i ref dei campi presi dallo snapshot` }
  if (!/^[A-Za-z0-9]+$/.test(r)) {
    return { ok: false, error: `"${r.slice(0, 40)}" non è un ref dello snapshot (i ${kind}_ref sono i ref dello snapshot, es. e12 o f1e12)` }
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
    return { ok: false, error: `non riesco a verificare il tipo del campo ${kind}_ref dentro la pagina: rifiutato (se il campo è giusto, riprova dopo un browser_snapshot)` }
  }
  if (kind === 'password' && info.type !== 'password') {
    return { ok: false, error: `password_ref punta a un campo type="${info.type || '(sconosciuto)'}" e non type="password": usa i ref giusti dallo snapshot` }
  }
  if (kind === 'username' && info.type === 'password') {
    return { ok: false, error: 'username_ref punta a un campo password: il nome utente non va nel campo della password' }
  }
  if (kind === 'username' && !USERNAME_FIELD_TYPES.has(info.type)) {
    return { ok: false, error: `username_ref punta a un campo type="${info.type || '(sconosciuto)'}": servono campi di testo (text/email/tel)` }
  }
  if (kind === 'totp' && info.type === 'password') {
    return { ok: false, error: 'totp_ref punta a un campo password: il codice va in un campo di testo' }
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
    return { ok: false, error: 'non riesco a leggere l\'origine del campo dentro la pagina (verifica del frame): rifiutato' }
  }
  if (info.top !== true) {
    return { ok: false, error: 'il campo sta in un iframe: una cornice può avere un\'altra origine. Usa un campo della pagina principale.' }
  }
  if (!expectedOrigins.includes(info.origin)) {
    return {
      ok: false,
      error: `l'origine del campo (${info.origin || '(sconosciuta)'}) non è quella del login (${expectedOrigins.join(', ')}): la pagina è cambiata o non è quella giusta`
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

/** Le parole italiane dei campi compilati, per l'esito (puro). */
export function filledFieldsLabel(refs: { username?: boolean; password?: boolean; totp?: boolean }): string {
  const parts: string[] = []
  if (refs.username) parts.push('utente')
  if (refs.password) parts.push('password')
  if (refs.totp) parts.push('codice')
  return parts.join(' e ') || 'i campi'
}

/**
 * L'esito di fill_credential per il modello (punto 7d): dice label e origine,
 * MAI i valori.
 */
export function fillResultText(label: string, origin: string, refs: { username?: boolean; password?: boolean; totp?: boolean }): string {
  return `Compilati ${filledFieldsLabel(refs)} di «${label}» su ${origin}.`
}
