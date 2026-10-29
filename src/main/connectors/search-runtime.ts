// Runtime della ricerca unificata (fase 13, punto 1): il daemon registra qui
// il runner vero (catalogo + marketplace + registro, col fetch di rete); i
// test e i moduli senza wiring usano il ripiego a solo catalogo. Il result
// dice se contiene testo di TERZI (registro/marketplace): in quel caso il
// loop lo mette nel blocco dati esterni e CONTAMINA il turno.
import { loadCatalog } from './index'
import { formatSearchResults, mergeConnectorResults } from './search'

export interface ConnectorsSearchOutcome {
  text: string
  /** true quando ci sono righe di registro o marketplace (testo di terzi) */
  thirdParty: boolean
}

export type ConnectorsSearchRunner = (query: string) => Promise<ConnectorsSearchOutcome>

let runner: ConnectorsSearchRunner | null = null

/** Il daemon registra il runner con le tre fonti (chiamato a ogni search_connectors). */
export function setConnectorsSearchRunner(fn: ConnectorsSearchRunner | null): void {
  runner = fn
}

export async function runConnectorsSearch(query: string): Promise<ConnectorsSearchOutcome> {
  if (runner) return runner(query)
  // ripiego senza wiring: solo catalogo verificato, nessun testo di terzi
  const out = mergeConnectorResults({ catalog: loadCatalog().map((entry) => ({ entry })), plugins: [], registry: [] }, query)
  return { text: formatSearchResults(out), thirdParty: false }
}
