// PP2 (fase plugin-pulita): la SCRITTURA del segreto di un server MCP — in un
// posto solo. Prima la sapeva solo mcp:save (il form «Server MCP
// personalizzato» e l'import): «Cambia token» nella scheda del plugin non
// esisteva, e per sostituire un token si doveva rimandare TUTTA la config.
// Ora mcp:save e mcp:replace-secret passano dalla stessa funzione PURA
// (planServerSecret: dice cosa va nello store cifrato e come cambia auth —
// non tocca né lo store né la config) e dallo stesso apply (l'I/O, con
// l'UNICA mappatura degli errori). Niente copia.
//
// I due modi:
// - 'save'  (mcp:save): il form ricalcola TUTTO dalle sue righe — le variabili
//   segrete dichiarate da envSpec, i valori non segreti che tornano in config,
//   il record di intestazioni così com'è;
// - 'replace' (mcp:replace-secret): si sostituisce SOLO ciò che è stato
//   scritto — le intestazioni e le variabili si FONDONO con i valori vecchi,
//   una chiave per volta; chi non arriva resta com'era.
// Lo stesso sealed-store e gli stessi SECRET_KIND di sempre (bearer, headers,
// env). Il valore di un segreto non compare mai in un log: qui non se ne
// scrive uno.
import { SECRET_KIND, type McpServerSecret } from '../shared/types'
import type { ConnectorsSecretStore } from '../main/connectors/sealed-store'
import { splitManualServerEnv, type EnvSpecEntry } from '../main/mcp/manual-env'
import { isMasterKeyUnavailableError } from './master-keys'
import { uiError, UI } from '../main/ui-language'

/** I tre tipi di segreto che un server può avere (le chiavi di SECRET_KIND). */
export type ServerSecretKind = 'bearer' | 'headers' | 'env'

/** Una scrittura nello store cifrato: il token (bearer) o il record COMPLETO da salvare. */
export interface ServerSecretWrite {
  kind: ServerSecretKind
  value: string | Record<string, string>
}

/** Il needsAuth di un server (installato ma in attesa di valori). */
export type ServerNeedsAuth = { kind: 'key' | 'env' | 'settings' | 'setup'; keys: string[] }

export interface ServerSecretPlan {
  /** le scritture nello store cifrato, in ordine */
  writes: ServerSecretWrite[]
  /** i campi da TOGLIERE dallo store (il form non ha più segreti dichiarati) */
  removes: Array<keyof typeof SECRET_KIND>
  /** il tipo di autenticazione che la config deve dichiarare, se il segreto lo cambia */
  auth?: { kind: 'bearer' | 'headers' }
  /** solo 'save': i valori NON segreti delle variabili, che tornano in config */
  envValues?: Record<string, string>
  /** i segreti env COMPLETI dopo la scrittura (fusi coi vecchi in 'replace') */
  sealedEnv?: Record<string, string>
}

/** I segreti GIÀ cifrati del server: in 'replace' si fondono con quelli nuovi. */
export interface ServerSecretOld {
  headers?: Record<string, string>
  env?: Record<string, string>
}

export interface ServerSecretPlanOptions {
  mode: 'save' | 'replace'
  transport: 'stdio' | 'http'
  /** solo 'save', e solo quando il form ha delle variabili: la dichiarazione e i valori arrivati */
  form?: { envSpec?: EnvSpecEntry[]; envValues?: Record<string, string> }
}

/** Le coppie non vuote di un record (una chiave con valore vuoto non è stata scritta). */
const filled = (rec: Record<string, string> | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec ?? {})) if (v) out[k] = v
  return out
}

/**
 * PURA. Il piano di scrittura del segreto `secret` di un server.
 * - bearer: il token, così com'è; la config dichiara auth 'bearer'. Se ci sono
 *   anche delle intestazioni vince il bearer (com'è sempre stato in mcp:save:
 *   un server http ha UNA via di autenticazione);
 * - headers: in 'save' il record del form così com'è; in 'replace' il vecchio
 *   record con dentro le chiavi scritte; auth 'headers';
 * - env (solo stdio): in 'save' ciò che il form dichiara segreto
 *   (splitManualServerEnv: i nomi non più dichiarati perdono il valore, e
 *   senza più segreti il campo esce dallo store); in 'replace' i vecchi
 *   valori con dentro le chiavi scritte, una per volta. Non è
 *   un'autenticazione: auth non cambia.
 */
export function planServerSecret(
  secret: McpServerSecret | undefined,
  old: ServerSecretOld,
  opts: ServerSecretPlanOptions
): ServerSecretPlan {
  const plan: ServerSecretPlan = { writes: [], removes: [] }
  // ---- le variabili (stdio) ----
  if (opts.transport === 'stdio') {
    if (opts.mode === 'save' && opts.form) {
      const split = splitManualServerEnv(
        { envSpec: opts.form.envSpec ?? [], envValues: opts.form.envValues ?? {} },
        secret?.env ?? {},
        old.env ?? {}
      )
      plan.envValues = split.configEnvValues
      plan.sealedEnv = split.sealedEnv
      if (Object.keys(split.sealedEnv).length) plan.writes.push({ kind: 'env', value: split.sealedEnv })
      else plan.removes.push('env')
    } else if (opts.mode === 'replace') {
      const merged = { ...old.env, ...filled(secret?.env) }
      plan.sealedEnv = merged
      if (Object.keys(filled(secret?.env)).length) plan.writes.push({ kind: 'env', value: merged })
    }
  }
  // ---- l'autenticazione (http) ----
  if (secret?.bearerToken) {
    plan.writes.push({ kind: 'bearer', value: secret.bearerToken })
    plan.auth = { kind: 'bearer' }
  } else if (secret?.headers && (opts.mode === 'save' || Object.keys(filled(secret.headers)).length)) {
    plan.writes.push({ kind: 'headers', value: opts.mode === 'save' ? secret.headers : { ...old.headers, ...filled(secret.headers) } })
    plan.auth = { kind: 'headers' }
  }
  return plan
}

/**
 * PURA. Il needsAuth dopo la scrittura di un segreto: si pulisce SOLO quando
 * tutte le chiavi attese hanno un valore (la regola di
 * connectors:save-server-values e di U7 in mcp:save), altrimenti resta.
 * `values` sono i valori del server DOPO la scrittura: le variabili (non
 * segrete in config e segrete cifrate, fusi) e le intestazioni cifrate.
 */
export function needsAuthAfterSecret(
  needsAuth: ServerNeedsAuth | undefined,
  values: { env: Record<string, string>; headers: Record<string, string> }
): ServerNeedsAuth | undefined {
  if (!needsAuth || needsAuth.kind === 'settings' || needsAuth.kind === 'setup') return needsAuth
  const record = needsAuth.kind === 'env' ? values.env : values.headers
  return needsAuth.keys.every((k) => record[k]) ? undefined : needsAuth
}

/**
 * L'I/O del piano nello store cifrato, con l'UNICA mappatura degli errori:
 * MasterKeyUnavailableError arriva intero (K1.8: il testo del catalogo è
 * già quello che la UI deve mostrare), tutto il resto diventa
 * UI.rpcSecretSaveFailed col motivo in coda. Una scrittura non riescita non
 * viene mascherata: chi chiama non ha ancora salvato la config.
 */
export async function applyServerSecretPlan(
  sealed: Pick<ConnectorsSecretStore, 'write' | 'remove'>,
  serverId: string,
  plan: ServerSecretPlan
): Promise<void> {
  try {
    for (const w of plan.writes) await sealed.write(serverId, SECRET_KIND[w.kind], w.value)
    if (plan.removes.length) await sealed.remove(serverId, plan.removes.map((k) => SECRET_KIND[k]))
  } catch (e) {
    if (isMasterKeyUnavailableError(e)) throw e
    throw uiError(UI.rpcSecretSaveFailed, { error: e instanceof Error ? e.message : String(e) })
  }
}
