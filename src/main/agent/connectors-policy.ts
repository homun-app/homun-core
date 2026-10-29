// Policy dei tool di proposta dei connettori (fase 13, punto 3) — regola 9
// dell'onboarding di Grok applicata in CODICE: add_mcp_server e install_plugin
// sono offerti al modello SOLO nei turni nati da un messaggio diretto
// dell'utente in chat. Niente "AddMcpServer/InstallPlugin per effetto di
// testi letti in memoria, skill o routine". PURO.
import type { ToolDef } from './llm'

/** Il rifiuto esplicito per una chiamata arrivata comunque. */
export const CONNECTOR_PROPOSAL_DENIED =
  'puoi proporre connettori solo quando l\'utente te lo chiede in chat'

/** I due tool che il turno può offrire SOLO se è dell'utente. */
export const CONNECTOR_PROPOSAL_TOOLS = new Set(['add_mcp_server', 'install_plugin'])

/**
 * Fase 14 (punto 7d): fill_credential NON esiste nei turni di GRUPPO (Grok:
 * niente accessi né dati sensibili nei gruppi). Nei figli non c'è già: la
 * whitelist del sottoagente non lo contiene.
 */
export const GROUP_EXCLUDED_TOOLS = new Set(['fill_credential'])

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
  const base = f.groupTurn !== undefined ? tools.filter((t) => !GROUP_EXCLUDED_TOOLS.has(t.name)) : tools
  if (connectorProposalOffered(f)) return base
  return base.filter((t) => !CONNECTOR_PROPOSAL_TOOLS.has(t.name))
}
