// Policy dei tool di proposta dei connettori (fase 13, punto 3) — regola 9
// dell'onboarding di Grok applicata in CODICE: add_mcp_server e install_plugin
// sono offerti al modello SOLO nei turni nati da un messaggio diretto
// dell'utente in chat. Niente "AddMcpServer/InstallPlugin per effetto di
// testi letti in memoria, skill o routine". PURO.
import type { ToolDef } from './llm'

/** Il rifiuto esplicito per una chiamata arrivata comunque. */
export const CONNECTOR_PROPOSAL_DENIED =
  'you may propose connectors only when the user asks you in chat'

/** I due tool che il turno può offrire SOLO se è dell'utente. */
export const CONNECTOR_PROPOSAL_TOOLS = new Set(['add_mcp_server', 'install_plugin'])

/**
 * Fase 14 (punto 7d): fill_credential NON esiste nei turni di GRUPPO (Grok:
 * niente accessi né dati sensibili nei gruppi). Nei figli non c'è già: la
 * whitelist del sottoagente non lo contiene.
 */
export const GROUP_EXCLUDED_TOOLS = new Set(['fill_credential'])

// fase risposta (R2): fuori dai gruppi si offre message_user (i progressi dei
// lavori lunghi) e NON send_to_user — la risposta all'utente è il testo
// normale della risposta finale; nei turni di GRUPPO resta send_to_user
// com'è oggi (R7: i gruppi non cambiano in questa fase). Se il modello chiama
// lo stesso send_to_user fuori da un gruppo, il loop lo tratta come
// message_user: nessuna risposta persa.
const PRIVATE_ONLY_TOOLS = new Set(['message_user'])
const GROUP_ONLY_TOOLS = new Set(['send_to_user'])

/** I fatti del turno che decidono se i tool di proposta ci sono. */
export interface TurnSourceFacts {
  source: 'user' | 'routine' | 'group' | string
  /** turno di gruppo (groupTurn) */
  groupTurn?: unknown
  /** turno del FIGLIO (sottoagente) */
  subagent?: unknown
  /** il turno gira nel sotto-transcript di un task */
  taskId?: number
  /** catena/routine automatica (A3/B1) */
  automatic?: boolean
  /** messaggio di un ALTRO bot */
  agentMessage?: unknown
  /** initiator di sistema (SUBAGENTS_DONE, SHELL_DONE, CONNECTOR_CONNECTED, …) */
  initiator?: string
}

/**
 * connectorProposalOffered (pura): true SOLO nei turni nati da un messaggio
 * diretto dell'utente in chat. Fuori: routine, turni di gruppo, task-run,
 * figli, catene tra bot e TUTTI gli initiator di sistema (SUBAGENTS_DONE e
 * SHELL_DONE compresi): nessun initiator significa che il messaggio l'ha
 * scritto l'utente nella chat del bot.
 */
export function connectorProposalOffered(f: TurnSourceFacts): boolean {
  if (f.source !== 'user') return false
  if (f.groupTurn !== undefined) return false
  if (f.subagent !== undefined) return false
  if (f.taskId !== undefined) return false
  if (f.automatic === true) return false
  if (f.agentMessage !== undefined) return false
  if (f.initiator !== undefined && f.initiator !== '') return false
  return true
}

/**
 * La lista dei tool del turno coi connettori tolti quando il turno non è
 * dell'utente (pura): i tool NON compaiono proprio nella lista.
 */
export function toolsForTurnSource(tools: ToolDef[], f: TurnSourceFacts): ToolDef[] {
  // fase 14 (7d): nei turni di gruppo niente fill_credential (accessi e dati
  // sensibili restano fuori dai gruppi)
  // fase risposta (R2): la coppia send_to_user / message_user si divide sul
  // gruppo — fuori dai gruppi si offre SOLO message_user, nei gruppi SOLO
  // send_to_user (l'elenco resta fisso per tutto il turno, fase velocità)
  const base = f.groupTurn !== undefined
    ? tools.filter((t) => !GROUP_EXCLUDED_TOOLS.has(t.name) && !PRIVATE_ONLY_TOOLS.has(t.name))
    : tools.filter((t) => !GROUP_ONLY_TOOLS.has(t.name))
  if (connectorProposalOffered(f)) return base
  return base.filter((t) => !CONNECTOR_PROPOSAL_TOOLS.has(t.name))
}

// ---- fase eval-deboli (D5): i testi di offer_connector per gli id del registro ----

/** D5: gli id che NON sono app del catalogo ma server MCP (registro pubblico o URL diretto). */
export const MCP_ID_PREFIXES = ['registry:', 'url:']

/** D5: true se l'id è un server MCP del registro pubblico (o un URL diretto), non un'app del catalogo. */
export function isMcpId(id: string): boolean {
  return MCP_ID_PREFIXES.some((p) => id.startsWith(p))
}

/**
 * D5: la risposta di offer_connector per un id del registro — guida verso
 * add_mcp_server (che mostra la card), senza mostrare nulla e senza aggiungere
 * niente. La usa il loop VERO e il finto dell'eval (D6.7): stessi testi.
 */
export function offerConnectorMcpGuidance(id: string): string {
  return `"${id}" is an MCP server from the public registry, not a catalog app: propose it with add_mcp_server({id: "${id}", reason}) — that shows the card.`
}

/** D5: il testo di offer_connector per un id che non esiste da nessuna parte (quello di oggi). */
export function offerConnectorMissingText(id: string): string {
  return `Connector "${id}" does not exist: find the right one with search_connectors.`
}
