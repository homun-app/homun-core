// Riferimenti opachi ai segreti (§5.6) — modulo PURO (nessun import Electron).
// Il modello NON vede mai i valori: scrive {{secret:NOME}} negli argomenti di
// run-command; il runtime risolve il riferimento SOLO al momento dell'esecuzione,
// iniettandolo come variabile d'ambiente SANDBOT_SECRET_NOME e riscrivendo il
// comando per usare la variabile. I valori vengono poi redatti da stdout/stderr
// prima di arrivare al modello o al transcript.
export const SECRET_REF = /\{\{secret:([A-Za-z0-9_.-]+)\}\}/g

/** NOME variabile d'ambiente per un segreto (API_KEY → SANDBOT_SECRET_API_KEY). */
export function secretEnvName(name: string): string {
  return 'SANDBOT_SECRET_' + name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
}

export interface ResolvedSecret {
  name: string
  envName: string
  value: string
}

export interface SecretResolution {
  /** Comando riscritto: $SANDBOT_SECRET_X al posto di ogni {{secret:X}}. Nessun riferimento residuo. */
  command: string
  /** env da iniettare nell'esecuzione (valori qui, mai nel comando). */
  env: Record<string, string>
  /** segreti effettivamente usati (per redigere l'output). */
  used: ResolvedSecret[]
  /** nomi richiesti ma assenti dal vault. */
  missing: string[]
}

/**
 * Risolve i riferimenti {{secret:NOME}} in un comando.
 * `reveal` non deve mai comparire nel risultato: il valore entra solo in env.
 */
export async function resolveSecretRefs(
  command: string,
  reveal: (name: string) => Promise<string>
): Promise<SecretResolution> {
  const names = [...new Set([...command.matchAll(SECRET_REF)].map((m) => m[1]!))]
  const used: ResolvedSecret[] = []
  const missing: string[] = []
  const env: Record<string, string> = {}
  for (const name of names) {
    const envName = secretEnvName(name)
    if (envName in env) continue // due nomi che sanitizzano alla stessa variabile: la prima vince
    try {
      const value = await reveal(name)
      used.push({ name, envName, value })
      env[envName] = value
    } catch {
      missing.push(name)
    }
  }
  const rewritten = used.length || missing.length
    ? command.replace(SECRET_REF, (_m, name: string) => `$${secretEnvName(name)}`)
    : command
  return { command: rewritten, env, used, missing }
}

/**
 * Sostituisce ogni occorrenza dei valori dei segreti con [redacted:NOME].
 * Oltre al valore letterale oscura anche le codifiche più comuni (base64 e
 * URL-encoding): un comando che stampa `echo $SANDBOT_SECRET_X | base64`
 * non deve far uscire il segreto in forma codificata.
 */
export function redactSecrets(text: string, secrets: readonly ResolvedSecret[]): string {
  let out = text
  for (const s of secrets) {
    if (!s.value) continue
    const variants = [
      s.value,
      Buffer.from(s.value, 'utf8').toString('base64'),
      encodeURIComponent(s.value)
    ]
    for (const v of variants) {
      if (v) out = out.split(v).join(`[redacted:${s.name}]`)
    }
  }
  return out
}
