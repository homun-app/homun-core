// Verifica impostazioni (Gmail che «non si apre»): la card di collegamento
// proposta dal bot segue la STESSA strada della finestra App. Una curata
// diretta static (Gmail, Calendar, Drive di Google) senza il client OAuth
// dell'utente non può aprire il login: se il marchio esiste su Composio, il
// clic passa da apps:connect (login di Composio, poi l'app), esattamente come
// «Connetti» nella finestra App. Modulo PURO: la regola è loadAppCatalog.
import { loadAppCatalog, type AppCatalogRow } from '../../../shared/app-catalog'
import type { ConnectorInfo } from '../../../shared/types'

export interface ComposioRoute {
  /** l'id della riga dell'elenco app (per apps:connect / apps:cancel-connect) */
  appId: string
  composioSlug: string
}

/**
 * La strada Composio di una card di collegamento diretta, oppure null quando
 * la strada diretta è pronta (dynamic, o static col client salvato) o il
 * marchio non esiste su Composio (resta la strada diretta, che dice il motivo).
 */
export function composioRouteFor(
  connectorId: string | undefined,
  connectors: readonly Pick<ConnectorInfo, 'id' | 'hasStaticCredentials'>[],
  rows?: readonly AppCatalogRow[]
): ComposioRoute | null {
  if (!connectorId || connectorId.includes(':')) return null
  const staticReady = connectors.filter((c) => c.hasStaticCredentials).map((c) => c.id)
  const all = rows ?? loadAppCatalog({ staticClientsReady: staticReady })
  const row = all.find((r) => r.directId === connectorId)
  if (!row || row.via !== 'composio' || !row.composioSlug) return null
  return { appId: row.id, composioSlug: row.composioSlug }
}
