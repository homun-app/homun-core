// E1 (fase mcp-env): il modello delle righe «Variabili» del form stdio della
// finestra «Server MCP». Puro: il componente ci costruisce le righe e ne
// ricava il payload del salvataggio (envSpec + envValues nella config, i
// SEGRETI solo nel parametro cifrato di mcp:save).
import { envNameLooksSecret } from '../../../shared/mcp-env'

export interface EnvRow {
  name: string
  value: string
  secret: boolean
  /** true quando la riga è segreta e un valore CIFRATO esiste già (si sostituisce, non si legge) */
  saved: boolean
}

/** Le righe del form dal server salvato: i segreti tornano VUOTI (mai letti). */
export function envRowsFromServer(server: { envSpec?: Array<{ name: string; secret: boolean }>; envValues?: Record<string, string> }): EnvRow[] {
  return (server.envSpec ?? []).map((v) => ({
    name: v.name,
    value: v.secret ? '' : (server.envValues?.[v.name] ?? ''),
    secret: v.secret,
    saved: v.secret
  }))
}

/** La riga vuota del «+ Variabile» (secret dall'euristica del nome, quando lo si scrive). */
export function newEnvRow(): EnvRow {
  return { name: '', value: '', secret: false, saved: false }
}

/** Il payload del salvataggio: la dichiarazione, i valori in chiaro e i SOLO segreti digitati. */
export function saveEnvPayload(rows: EnvRow[]): {
  envSpec: Array<{ name: string; secret: boolean }>
  envValues: Record<string, string>
  envSecrets: Record<string, string>
} {
  const envSpec: Array<{ name: string; secret: boolean }> = []
  const envValues: Record<string, string> = {}
  const envSecrets: Record<string, string> = {}
  for (const r of rows) {
    const name = r.name.trim()
    if (!name) continue
    envSpec.push({ name, secret: r.secret })
    if (r.secret) {
      // in modifica il segreto si SOSTITUISCE: si manda solo quello digitato
      if (r.value) envSecrets[name] = r.value
    } else if (r.value) {
      envValues[name] = r.value
    }
  }
  return { envSpec, envValues, envSecrets }
}

export { envNameLooksSecret }
