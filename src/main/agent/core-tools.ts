// Fase token (T1/T2): il NUCLEO piccolo (sempre nel prompt del turno) e i
// GRUPPI (come i namespace di OpenAI: il dettaglio arriva quando l'area si
// attiva, l'indice dei gruppi sta nella descrizione di find_tools). Prima
// (fase velocità S3) c'erano un elenco CORE di 32 tool e 19 differiti dietro
// use_tool: ora il nucleo del turno normale sono parlare/pc/web/memory/skill
// e TUTTO il resto vive in gruppi attivabili con find_tools({group}|{query}).
// Tutto PURO: nomi, partizioni stabili e testi.
import type { ToolDef } from './llm'

/**
 * Fase token (T1): gli strumenti SEMPRE nel prompt del turno normale. Il
 * computer di base (un QUALSIASI primo passo), il web in lettura, la facciata
 * memory (update_memory + recall_memory) e la ricerca. Verso il modello la
 * coppia update_memory/recall_memory appare come la facciata `memory`
 * (facades.ts): qui restano i nomi INTERNI. `pass` e `post_to_group` esistono
 * per costruzione nei turni di gruppo; `wake_parent` (figlio) lo aggiunge
 * l'assemblaggio del turno. Fase token · scoperta (R7.2): anche la facciata
 * `document` (write/read/edit_document) sta nel nucleo.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // parlare con l'utente (message_user fuori dai gruppi, send_to_user nei gruppi)
  'send_to_user',
  'message_user',
  'ask_user',
  // il computer
  'run-command',
  'read-file',
  'write-file',
  'list-directory',
  // il web in lettura
  'web_search',
  'web_fetch',
  // la facciata memory (update_memory + recall_memory)
  'update_memory',
  'recall_memory',
  // fase token · scoperta (R7.2): la facciata document (write/read/edit) —
  // i documenti sono un'uscita frequente quanto un messaggio
  'write_document',
  'read_document',
  'edit_document',
  // le skill installate
  'skill',
  // per costruzione nei turni di gruppo
  'pass',
  'post_to_group'
])

/** Una voce dell'indice/gruppo: id, descrizione (≤ 90 caratteri), tool (nomi INTERNI), guida (T4). */
export interface ToolGroup {
  id: string
  description: string
  tools: ReadonlyArray<string>
  /** la guida che entra nel result dell'attivazione (T4: le sezioni spostate dal prompt) */
  guide: string
}

/**
 * Fase token (T2): i GRUPPI, in ordine STABILE (l'ordine con cui i gruppi
 * attivati entrano in coda all'elenco del turno). I nomi sono INTERNI: verso
 * il modello la famiglia coperta da una facciata appare con il nome della
 * facciata (browser, document, task, memory) — la sostituzione la fa
 * l'assemblaggio del turno. `mcp:<server>` non sta qui: si costruisce dai
 * tool MCP del bot quando sono differiti (come oggi, ma per server).
 */
export const TOOL_GROUPS: ReadonlyArray<ToolGroup> = [
  {
    id: 'browser',
    description: 'Open and drive web pages: snapshot text with refs, click, type, takeover for logins.',
    tools: [
      'browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_select',
      'browser_press_key', 'browser_back', 'browser_wait', 'browser_tabs', 'browser_screenshot',
      'browser_close', 'request_takeover', 'computer_observe', 'computer_act'
    ],
    guide: ''
  },
  {
    // R7.2: write/read/edit_document (la facciata document) sono nel NUCLEO;
    // qui restano charts e libreria
    id: 'documents',
    description: 'Charts and the library of files the user keeps (document itself is a base tool).',
    tools: ['visualize', 'save_to_library', 'list_library', 'export_from_library'],
    guide: ''
  },
  {
    id: 'tasks',
    description: 'Long work: task threads, routine state, background shells.',
    tools: ['create_task', 'update_task', 'update_state', 'await_shell'],
    guide: ''
  },
  {
    id: 'credentials',
    description: 'The vault: list saved logins, fill them into pages, save new ones securely.',
    tools: ['list-credentials', 'fill_credential', 'request_secure_input'],
    guide: ''
  },
  {
    id: 'outside',
    description: 'Outbound drafts (email, messages), the user contacts, saving new contacts.',
    tools: ['draft_external', 'find_contacts', 'save_contact'],
    guide: ''
  },
  {
    id: 'subagents',
    description: 'Parallel helpers: spawn subagents, check, message, stop them.',
    tools: ['spawn_subagent', 'check_subagent', 'message_subagent', 'stop_subagent'],
    guide: ''
  },
  {
    id: 'bots',
    description: 'The other bots and groups: list, create, update, delete, message them.',
    tools: ['list_agents', 'create_agent', 'update_agent', 'delete_agent', 'create_group', 'update_group', 'send_to_agent'],
    guide: ''
  },
  {
    id: 'connectors',
    description: 'Search apps and services, propose connectors, add MCP servers and plugins.',
    tools: ['search_connectors', 'offer_connector', 'add_mcp_server', 'install_plugin'],
    guide: ''
  },
  {
    id: 'apps',
    description: 'use-app: drive apps on the user own Mac with their account.',
    tools: ['use-app'],
    guide: ''
  },
  {
    id: 'admin',
    description: 'Skills, permission rules, file exchange with the user Mac (the box).',
    tools: ['update_skill', 'propose_rule_change', 'copy_to_box', 'copy_from_box'],
    guide: ''
  }
]

/** Il gruppo builtin (TOOL_GROUPS) che contiene un nome interno, o null. */
export function builtinGroupOf(internalName: string): ToolGroup | null {
  return TOOL_GROUPS.find((g) => g.tools.includes(internalName)) ?? null
}

/**
 * La divisione nucleo/gruppi di un elenco di tool (puro, ordine stabile):
 * l'input sono gli integrati del turno DOPO le regole del turno (whitelist
 * dei figli, toolsForTurnSource). Core = i nomi del nucleo (T1); tutto il
 * resto appartiene a un gruppo di TOOL_GROUPS.
 */
export function partitionTools(tools: ToolDef[]): { core: ToolDef[]; grouped: ToolDef[] } {
  const core: ToolDef[] = []
  const grouped: ToolDef[] = []
  for (const t of tools) {
    if (CORE_TOOL_NAMES.has(t.name)) core.push(t)
    else grouped.push(t)
  }
  return { core, grouped }
}

/** L'esecutore degli integrati differiti: use_tool si «srotola» nel loop.
 *  Fase token (T2): NON si offre più nei turni nuovi; se il modello lo chiama
 *  ancora (storie vecchie) il loop lo srotola come oggi e attiva il gruppo. */
export const useToolDef: ToolDef = {
  name: 'use_tool',
  description:
    'Runs one of the built-in tools listed by find_tools: pass its exact name and its arguments object. The tool runs exactly as if called directly, with the same permissions and confirmation cards. It cannot call itself or find_tools.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The built-in tool name exactly as returned by find_tools (e.g. "create_agent")' },
      arguments: { type: 'object', description: 'The arguments of that tool, as an object', additionalProperties: true }
    },
    required: ['name', 'arguments']
  }
}
