// PP2 (fase plugin-pulita): il segreto di un server si cambia DOVE VIVE il
// server — nella scheda del plugin. Qui il modello PURO di quell'editor:
// di che account è il server (dalla config e dai NOMI dei segreti cifrati:
// i valori non lasciano mai il daemon), lo stato dell'editor come reducer
// (il valore scritto NON resta dopo il salvataggio), il payload per
// mcp:replace-secret e l'esito che la riga mostra. L'editor che sapeva
// sostituire un segreto stava solo nel form «Server MCP personalizzato» e
// rimandava TUTTA la config; qui si manda solo ciò che è stato scritto.
import type { McpServerSecret, SandbotApi } from '../../../shared/types'
// X2 (fase sicurezza-beta16): l'errore del test si mostra tagliato a 300
import { clipErrorText } from '../../../main/mcp/error-category'

export type SecretKind = 'bearer' | 'headers' | 'env'

/** I NOMI dei segreti di un server, dallo store cifrato (mai i valori): la risposta di mcp:secret-names. */
export interface ServerSecretNames {
  id: string
  /** c'è un token (bearer) salvato */
  bearer: boolean
  /** i nomi delle intestazioni salvate */
  headers: string[]
  /** i nomi delle variabili segrete salvate */
  env: string[]
}

/** L'account di un server, per la riga «Account»: la riga dice questo, e ha la sua azione. */
export type AccountKind = 'oauth' | 'bearer' | 'headers' | 'none'

/**
 * PURA. Di che account è il server. Lo dice la config (auth.kind) e, accanto,
 * lo store cifrato: un server salvato col form PRIMA che auth.kind arrivasse
 * in config ha il token cifrato ma non il tipo — i nomi lo riconoscono lo
 * stesso, e «Cambia token» lo ripara (mcp:replace-secret scrive auth.kind).
 */
export function accountKindOf(server: { auth?: { kind?: string } | null }, names?: ServerSecretNames | null): AccountKind {
  if (server.auth?.kind === 'oauth') return 'oauth'
  if (server.auth?.kind === 'bearer' || names?.bearer === true) return 'bearer'
  if (server.auth?.kind === 'headers' || (names?.headers?.length ?? 0) > 0) return 'headers'
  return 'none'
}

/** L'esito di un salvataggio: il test è passato, non è passato (col motivo), non è partito, oppure l'RPC è fallito. */
export type SecretEditOutcome =
  | { outcome: 'ok' }
  | { outcome: 'fail'; reason: string }
  | { outcome: 'saved' }
  | { outcome: 'error'; reason: string }

/** L'esito che la riga mostra dopo «Salva», e di QUALE riga è (l'editor si chiude: la riga giusta lo mostra). */
export type SecretEditResult = SecretEditOutcome & { kind: SecretKind }

export interface SecretEditState {
  /** che cosa si sta cambiando (null: il campo è chiuso) */
  kind: SecretKind | null
  /** i valori scritti dall'utente, per nome (il token: chiave «token»). Si SVUOTANO al salvataggio */
  values: Record<string, string>
  saving: boolean
  /** l'esito dell'ultimo salvataggio (resta finché non si riapre il campo) */
  result: SecretEditResult | null
}

export const SECRET_EDIT_INITIAL: SecretEditState = { kind: null, values: {}, saving: false, result: null }

export type SecretEditAction =
  | { type: 'open'; kind: SecretKind }
  | { type: 'type'; name: string; value: string }
  | { type: 'cancel' }
  | { type: 'saving' }
  | { type: 'saved'; result: SecretEditResult }

/**
 * PURA. Lo stato dell'editor. «saved» chiude il campo e SVUOTA i valori: il
 * segreto scritto non resta nello stato di React dopo il salvataggio (è
 * partito con l'RPC e vive solo cifrato nel daemon). «cancel» idem, senza esito.
 */
export function secretEditReducer(state: SecretEditState, action: SecretEditAction): SecretEditState {
  switch (action.type) {
    case 'open': return { kind: action.kind, values: {}, saving: false, result: null }
    case 'type': return state.kind === null ? state : { ...state, values: { ...state.values, [action.name]: action.value } }
    case 'cancel': return SECRET_EDIT_INITIAL
    case 'saving': return { ...state, saving: true }
    case 'saved': return { kind: null, values: {}, saving: false, result: action.result }
  }
}

/**
 * PURA. Il payload per mcp:replace-secret dal campo: solo i valori scritti
 * (spazi tolti), e solo quelli — le altre chiavi restano com'erano nel daemon.
 * bearer: il token; headers ed env: il record delle chiavi scritte.
 */
export function secretPayloadOf(kind: SecretKind, values: Record<string, string>): McpServerSecret {
  const filled: Record<string, string> = {}
  for (const [k, v] of Object.entries(values)) if (v.trim()) filled[k] = v.trim()
  if (kind === 'bearer') {
    const token = Object.values(filled)[0]
    return token ? { bearerToken: token } : {}
  }
  return Object.keys(filled).length ? (kind === 'headers' ? { headers: filled } : { env: filled }) : {}
}

/** PURA. L'esito dal test di connessione: «collegato», il motivo (tagliato a 300), o «salvato» se il test non è partito. */
/** L'esito del test di connessione come lo restituisce mcp:replace-secret. */
export type SecretTestOutcome = { ok: boolean; tools?: string[]; error?: string } | null

export function secretResultOf(test: SecretTestOutcome): SecretEditOutcome {
  if (test === null) return { outcome: 'saved' }
  return test.ok ? { outcome: 'ok' } : { outcome: 'fail', reason: clipErrorText(test.error ?? '') }
}

/**
 * «Salva»: il payload parte con mcp:replace-secret, poi l'esito torna alla
 * riga. Dipendenze iniettate (api, dispatch): pura rispetto a loro, così si
 * prova senza DOM. Un RPC che fallisce diventa l'errore della riga — e i
 * valori si svuotano lo stesso.
 */
export async function submitSecret(deps: {
  id: string
  kind: SecretKind | null
  values: Record<string, string>
  api: Pick<SandbotApi, 'mcpReplaceSecret'>
  dispatch(action: SecretEditAction): void
  onChanged(): void
}): Promise<void> {
  if (deps.kind === null) return
  const payload = secretPayloadOf(deps.kind, deps.values)
  if (Object.keys(payload).length === 0) return
  deps.dispatch({ type: 'saving' })
  try {
    const r = await deps.api.mcpReplaceSecret(deps.id, payload)
    deps.dispatch({ type: 'saved', result: { ...secretResultOf(r.test), kind: deps.kind } })
    deps.onChanged()
  } catch (e) {
    deps.dispatch({ type: 'saved', result: { outcome: 'error', kind: deps.kind, reason: e instanceof Error ? e.message : String(e) } })
  }
}
