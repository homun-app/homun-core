// Fase Composio OAuth (C3/C5): i METADATI del server MCP «For You» di
// Composio, PURI. Due tabelle:
// - la tabella degli strumenti (C3): un elenco CHIUSO per nome originale. Il
//   server dichiara `tools.listChanged: true`: uno strumento NUOVO, che non è
//   in tabella, NON si offre al modello finché non lo classifichiamo (fail
//   closed). I nomi e gli schemi veri vengono dal file di scoperta
//   2026-11-03 (12 strumenti, vedi la fixture ridotta nei test);
// - i toolkit comuni (C5): la lista del campo «Collega un'app» nel dettaglio
//   di Composio nella finestra App (slug, nome), più la ricerca libera dello
//   slug che il daemon passa al server.
// Modulo puro: nessuna dipendenza, testabile in nodo puro.

/** Che cosa fa lo strumento del server Composio e come lo tratta Homun. */
export type ComposioToolGate =
  /** lettura: auto-consentita (come le letture di ogni connettore del catalogo) */
  | 'read'
  /** il blocco COMPOSIO_MULTI_EXECUTE_TOOL: giudicato AZIONE PER AZIONE (C2) */
  | 'batch'
  /** COMPOSIO_MANAGE_CONNECTIONS: per voce di toolkits[] (list lettura, add
   *  card di collegamento, rename card, remove card distruttiva) */
  | 'connections'
  /** COMPOSIO_PROXY_EXECUTE: richiesta HTTP grezza all'API di un'app — SEMPRE card */
  | 'proxy'

/** La voce della tabella C3 per uno strumento del server Composio. */
export interface ComposioToolPolicy {
  /** lo strumento si offre al modello? (false = nascosto, rifiuto se chiamato) */
  offered: boolean
  /** come lo giudica il gate (senza senso quando offered è false) */
  gate: ComposioToolGate
  /** la riga del REPORT/per i test */
  note: string
}

/**
 * La tabella C3 (elenco CHIUSO, per nome originale). Descrizioni e schemi
 * restano quelli del SERVER: non si riscrivono. Le due code tool
 * (REMOTE_WORKBENCH, REMOTE_BASH_TOOL) eseguono codice nel cloud di Composio
 * e possono chiamare qualunque azione (Rakazo packages/core/src/
 * action-approval.ts:325–345, COMPOSIO_CODE_TOOLS), aggirando bozze e card:
 * non si offrono. Le skill dell’organizzazione Composio si sovrappongono
 * alle skill di Homun; SUBMIT_FEEDBACK manda testo a Composio senza utilità
 * per l'utente.
 */
export const COMPOSIO_TOOL_POLICIES: Readonly<Record<string, ComposioToolPolicy>> = {
  COMPOSIO_SEARCH_TOOLS: { offered: true, gate: 'read', note: 'tool search: read (auto)' },
  COMPOSIO_GET_TOOL_SCHEMAS: { offered: true, gate: 'read', note: 'tool schemas: read (auto)' },
  COMPOSIO_WAIT_FOR_CONNECTIONS: { offered: true, gate: 'read', note: 'waiting for the login: read (auto)' },
  COMPOSIO_MULTI_EXECUTE_TOOL: { offered: true, gate: 'batch', note: 'the batch: action by action (C2)' },
  COMPOSIO_MANAGE_CONNECTIONS: { offered: true, gate: 'connections', note: 'connecting apps: per toolkits[] entry (C5)' },
  COMPOSIO_PROXY_EXECUTE: { offered: true, gate: 'proxy', note: 'raw HTTP to an app API: always a card, never "always allow"' },
  COMPOSIO_REMOTE_WORKBENCH: { offered: false, gate: 'proxy', note: 'runs code in the Composio cloud and can call any action: not offered' },
  COMPOSIO_REMOTE_BASH_TOOL: { offered: false, gate: 'proxy', note: 'bash in the Composio cloud, can call any action: not offered' },
  COMPOSIO_SUBMIT_FEEDBACK: { offered: false, gate: 'proxy', note: 'sends text to Composio: not offered' },
  COMPOSIO_SEARCH_SKILLS: { offered: false, gate: 'proxy', note: 'Composio org skills overlap Homun skills: not offered' },
  COMPOSIO_USE_SKILL: { offered: false, gate: 'proxy', note: 'Composio org skills: not offered' },
  COMPOSIO_MANAGE_SKILL: { offered: false, gate: 'proxy', note: 'Composio org skills: not offered' }
}

/**
 * La politica di uno strumento del server Composio (fail closed): un nome
 * che NON è in tabella non si offre al modello.
 */
export function composioToolPolicy(originalName: string): ComposioToolPolicy {
  return COMPOSIO_TOOL_POLICIES[originalName] ?? { offered: false, gate: 'proxy', note: 'new unclassified tool: not offered (fail closed)' }
}

/**
 * Rakazo action-approval.ts:325–345 (COMPOSIO_CODE_TOOLS): eseguono codice
 * dentro Composio che può chiamare qualunque azione, quindi un blocco scoped
 * a un'azione si potrebbe aggirare attraverso loro.
 */
export const COMPOSIO_CODE_TOOLS: ReadonlySet<string> = new Set([
  'COMPOSIO_REMOTE_WORKBENCH',
  'COMPOSIO_REMOTE_BASH_TOOL'
])

// ---- C5: i toolkit comuni del campo «Collega un'app» ----
// La tabella vive in shared/composio-names.ts (la usa anche il renderer per
// la lista del campo): qui si riesporta per i moduli del daemon.

export { COMMON_COMPOSIO_TOOLKITS, knownToolkitSlugs, composioToolkitName } from '../../shared/composio-names'
export type { ComposioToolkitRef } from '../../shared/composio-names'
