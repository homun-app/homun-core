// K1.3 (fase rilascio — correzioni): la sonda «esistono dati sigillati per
// questo servizio?». Con dati presenti e nessuna chiave recuperabile il
// daemon NON genera mai una chiave nuova (sarebbe una chiave sopra segreti
// resi illeggibili per sempre): serve sapere se c'è qualcosa da proteggere.
// Guarda SOLO la forma a riposo nei setting — mai decifrare nulla.
import { getSetting } from '../main/store/db'
import { storedProviders } from '../main/agent/providers'
import { isSealedKey } from '../main/agent/provider-keys'
import { CONNECTORS_SERVICE, VAULT_SERVICE, PROVIDERS_SERVICE } from './keychain'

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return false
}

/**
 * True se per quel servizio esistono dati cifrati con la chiave master:
 * - connettori: `connectors.secrets` non vuoto;
 * - vault: segreti, login o contatti non vuoti (tutti sigillati con la
 *   stessa chiave master);
 * - provider: un provider con `apiKeySealed`.
 */
export function daemonHasSealedData(service: string): boolean {
  if (service === CONNECTORS_SERVICE) return nonEmpty(getSetting('connectors.secrets', {}))
  if (service === VAULT_SERVICE) {
    return (
      nonEmpty(getSetting('vault.secrets', [])) ||
      nonEmpty(getSetting('vault.logins', [])) ||
      nonEmpty(getSetting('vault.contacts', []))
    )
  }
  if (service === PROVIDERS_SERVICE) return storedProviders().some((p) => isSealedKey(p.apiKeySealed))
  return false
}
