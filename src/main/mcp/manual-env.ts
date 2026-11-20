// E1 (fase mcp-env): le VARIABILI D'AMBIENTE dei server stdio MANUALI — chi
// sta dove. La DICHIARAZIONE (nome + segreto) in envSpec della config; i
// valori NON segreti in envValues (config); i SEGRETI solo nello store
// cifrato (kind 'env', lo stesso di bearer e header): mai nei settings in
// chiaro, mai nel DB in chiaro. PURA, usata dall'RPC mcp:save.
import { envNameLooksSecret } from '../../shared/mcp-env'

export interface EnvSpecEntry {
  name: string
  secret: boolean
}

export interface ManualEnvSplitInput {
  envSpec?: EnvSpecEntry[]
  envValues?: Record<string, string>
}

/**
 * Divide i valori: quello che può stare nella config (non segreti, soli nomi
 * dichiarati) e quello che va nello store cifrato (segreti). incomingValues
 * sono i valori appena arrivati dal form (mescolati: la borsa di mcp:save) e
 * oldSealed i segreti GIÀ salvati (in modifica il segreto si sostituisce, non
 * si legge: chi non arriva nuovo resta com'era). Un valore segreto rimasto
 * per sbaglio in envValues NON ci resta: finisce cifrato.
 */
export function splitManualServerEnv(
  server: ManualEnvSplitInput,
  incomingValues: Record<string, string> = {},
  oldSealed: Record<string, string> = {}
): { configEnvValues: Record<string, string>; sealedEnv: Record<string, string> } {
  const spec = server.envSpec ?? []
  const secretNames = new Set(spec.filter((v) => v.secret).map((v) => v.name))
  const plainNames = new Set(spec.filter((v) => !v.secret).map((v) => v.name))
  const configEnvValues: Record<string, string> = {}
  const sealedEnv = mergeManualEnvSecrets(spec, oldSealed, {})
  for (const source of [server.envValues ?? {}, incomingValues]) {
    for (const [k, v] of Object.entries(source)) {
      if (!v) continue
      if (secretNames.has(k)) sealedEnv[k] = v
      else if (plainNames.has(k)) configEnvValues[k] = v
    }
  }
  return { configEnvValues, sealedEnv }
}

/**
 * Il merge dei segreti in MODIFICA: restano i vecchi valori delle righe
 * ancora dichiarate SEGRETE (e solo quelli), i nuovi arrivati sovrascrivono;
 * le righe tolte (o diventate non segrete) perdono il valore.
 */
export function mergeManualEnvSecrets(
  spec: EnvSpecEntry[],
  oldSealed: Record<string, string>,
  incoming: Record<string, string>
): Record<string, string> {
  const secretNames = new Set(spec.filter((v) => v.secret).map((v) => v.name))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(oldSealed)) {
    if (secretNames.has(k) && v) out[k] = v
  }
  for (const [k, v] of Object.entries(incoming)) {
    if (secretNames.has(k) && v) out[k] = v
  }
  return out
}

/** L'euristica condivisa del «segreto di default» (per il form). */
export { envNameLooksSecret }
