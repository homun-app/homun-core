// Il FLUSSO di fill_credential (fase 14, punto 7d + correzioni P3) — i
// controlli in CODICE e in quest'ordine, con TUTTE le dipendenze iniettabili
// (i test lo girano col Playwright MCP finto, senza browser vero):
// 1. ORIGINE: la pagina è https e la sua origine è ESATTAMENTE una delle
//    origins del login (niente sottodomini, porte diverse, http);
// 2. REF: validi, non di iframe, presenti nell'ultimo snapshot; il tipo del
//    campo verificato col probe interno (password→password, username→testo
//    non password, totp→testo non password); P3: il probe porta anche
//    l'ORIGINE del frame del campo e il fatto che stia nel documento TOP —
//    l'origine confrontata è quella del CAMPO, non l'ultima URL nota della
//    sessione (per browser_open è l'URL richiesta, non quella dopo i redirect);
// 3. APPROVAZIONE: concessione "Sempre per questo sito" o grant del turno →
//    si compila; altrimenti la card (mai auto-review);
// 4. COMPILAZIONE: P3 — il TOTP si verifica PRIMA di scrivere qualunque
//    campo (niente segreto → niente fill, nemmeno utente e password); poi,
//    subito prima di OGNI browser_type, un NUOVO probe del campo: origine
//    uguale a quella approvata, documento TOP e tipo ancora valido, altrimenti
//    ci si ferma (la pagina può cambiare durante l'attesa della card, che
//    dura anche minuti). Il daemon chiama browser_type col valore; il result
//    grezzo (che contiene il codice Playwright col valore) SI BUTTA; il TOTP
//    si calcola al momento (RFC 6238).
// Il result per il modello non contiene MAI i valori.
import {
  checkFillOrigin, checkFillRef, checkFieldKind, checkFieldFrame, checkFieldForWrite,
  totpCode, fillResultText, filledFieldsLabel
} from './credentials'
import type { RefInfo, FieldProbeInfo } from './browser-guard'
import type { VaultLogin } from '../vault'

/** L'esito dell'attesa della card di approvazione. */
export type FillApproval = 'allow-turn' | 'allow-always' | 'deny' | 'timeout'

/** Le dipendenze del flusso (browser, vault, approvazione): tutte iniettabili. */
export interface FillDeps {
  getLogin(id: string): Promise<VaultLogin>
  lastUrl(): string | null
  refInfo(ref: string): RefInfo | null
  probe(ref: string): Promise<{ ok: true; info: FieldProbeInfo } | { ok: false }>
  typeInto(ref: string, value: string): Promise<{ ok: true } | { ok: false; error: string }>
  hasStandingGrant(loginId: string, origin: string): boolean
  hasTurnAllow(loginId: string, origin: string): boolean
  /** La card: "Compilo il login «label» su origin?" (l'attesa la fa il loop) */
  requestApproval(login: { id: string; label: string }, origin: string, fields: string[]): Promise<FillApproval>
}

export interface FillOutcome {
  output: string
  /** rifiutato DAI CONTROLLI (nessuna card): l'origine o i ref non vanno bene */
  denied?: boolean
  /** errore di esecuzione (MCP) */
  error?: boolean
  /** la compilazione è partita (per i test: esito dopo l'approvazione) */
  filled?: { username?: boolean; password?: boolean; totp?: boolean }
}

/**
 * Il flusso completo di fill_credential (punto 7d). Il valore NON entra mai
 * nell'output: solo label, origine e quali campi sono stati compilati.
 */
export async function runFillCredential(
  input: Record<string, unknown>,
  deps: FillDeps
): Promise<FillOutcome> {
  let login: VaultLogin
  try {
    login = await deps.getLogin(String(input.id ?? ''))
  } catch (e) {
    return { output: `Login non trovato: ${e instanceof Error ? e.message : String(e)} (cerca gli id con list-credentials)`, error: true }
  }
  // 1. ORIGINE
  const originCheck = checkFillOrigin(login, deps.lastUrl())
  if (!originCheck.ok) return { output: originCheck.error, denied: true }
  const origin = originCheck.origin
  // 2. REF
  const wanted = ([
    { kind: 'username' as const, ref: input.username_ref },
    { kind: 'password' as const, ref: input.password_ref },
    { kind: 'totp' as const, ref: input.totp_ref }
  ] as Array<{ kind: 'username' | 'password' | 'totp'; ref: unknown }>).filter(
    (w) => w.ref !== undefined && w.ref !== null && String(w.ref).trim() !== ''
  )
  if (!wanted.length) {
    return { output: 'servono almeno un ref fra username_ref, password_ref e totp_ref (i ref dello snapshot della pagina aperta)', denied: true }
  }
  for (const w of wanted) {
    const rc = checkFillRef(w.ref, w.kind)
    if (!rc.ok) return { output: rc.error, denied: true }
    if (!deps.refInfo(rc.ref)) {
      return { output: `ref "${rc.ref}" non presente nell'ultimo snapshot ricevuto: ricarica la pagina con browser_snapshot prima di compilare`, denied: true }
    }
  }
  for (const w of wanted) {
    const probe = await deps.probe(String(w.ref))
    const info = probe.ok ? probe.info : null
    const check = checkFieldKind(w.kind, info)
    if (!check.ok) return { output: check.error, denied: true }
    // P3: l'origine del FRAME del campo (non l'ultima URL nota della sessione)
    // è una delle origini del login, e il campo sta nel documento TOP
    const frame = checkFieldFrame(info, login.origins)
    if (!frame.ok) return { output: frame.error, denied: true }
  }
  // 3. APPROVAZIONE
  if (!deps.hasStandingGrant(login.id, origin) && !deps.hasTurnAllow(login.id, origin)) {
    const fields = wanted.map((w) => (w.kind === 'username' ? 'utente' : w.kind === 'password' ? 'password' : 'codice TOTP'))
    const decision = await deps.requestApproval(login, origin, fields)
    if (decision === 'deny') {
      return { output: 'Compilazione del login annullata dall\'utente: non riprovarla senza il suo ok.', denied: true }
    }
    if (decision === 'timeout') {
      return { output: 'Approvazione scaduta o interrotta: login non compilato.', denied: true }
    }
    // allow-turn / allow-always: si prosegue (la concessione la registra il loop)
  }
  // 4. COMPILAZIONE (P3): prima OGNI controllo che può fallire, POI le
  // scritture — il TOTP si verifica PRIMA di scrivere qualunque campo (niente
  // segreto → niente fill, nemmeno utente e password) e il codice si calcola
  // ADESSO (un segreto non valido lancerebbe QUI, prima di ogni scrittura)
  if (wanted.some((w) => w.kind === 'totp') && !login.totp) {
    return { output: 'il login non ha un segreto TOTP salvato: totp_ref non si può compilare', error: true }
  }
  const totpValue = login.totp && wanted.some((w) => w.kind === 'totp') ? totpCode(login.totp) : null
  const done: { username?: boolean; password?: boolean; totp?: boolean } = {}
  for (const w of wanted) {
    // P3: nuovo probe subito prima di OGNI browser_type — l'attesa della card
    // può durare minuti e la pagina può essere cambiata (navigazione, redirect,
    // DOM sostituito): origine uguale a quella APPROVATA, documento TOP e tipo
    // ancora valido, altrimenti ci si ferma senza compilare gli altri campi
    const probe = await deps.probe(String(w.ref))
    const recheck = checkFieldForWrite(w.kind, probe.ok ? probe.info : null, origin)
    if (!recheck.ok) {
      const part = Object.keys(done).length
        ? `login compilato solo in parte: ${filledFieldsLabel(done)}`
        : 'login non compilato'
      return { output: `la pagina è cambiata durante l'approvazione: ${part}`, error: true }
    }
    const value = w.kind === 'username' ? login.username : w.kind === 'password' ? login.password : totpValue!
    const r = await deps.typeInto(String(w.ref), value)
    if (!r.ok) return { output: `Compilazione non riuscita: ${r.error}`, error: true }
    done[w.kind] = true
  }
  return { output: fillResultText(login.label, origin, done), filled: done }
}
