// Fase impostazioni (I4.5): il nome umano degli strumenti per la pagina
// Approvazioni — in testa alla riga il nome che capirebbe chiunque, sotto
// piccolo e grigio il nome tecnico che vive nel database. Le frasi seguono il
// lessico di lib/activity.ts (il linguaggio della mascotte), ma qui serve un
// NOME, non un verbo: «Messaggi all’utente», non «parla con l’utente…».
// Fase pulizia (P2): toolDisplayName(tool, ctx) è la funzione UNICA che dà
// il nome umano a TUTTE le superfici (pagina Approvazioni, card in chat,
// notice): anche le azioni Composio («Slack · Create reminder») e gli
// strumenti dei server MCP («Notion · <nome dello strumento>») hanno il loro
// nome; il ripiego finale resta il nome tecnico, come oggi in chat.
import type { Localized } from './types'
import type { UiLanguage } from './ui-language'
import { composioToolkitName, bareActionSlug } from './composio-names'

/** Il nome umano dei tool del daemon (chiave = nome tecnico esatto). */
const NAMES: Record<string, Localized> = {
  send_to_user: { it: 'Messaggi all’utente', en: 'Messages to you' },
  message_user: { it: 'Progressi in chat', en: 'Progress updates' },
  ask_user: { it: 'Domande all’utente', en: 'Questions to you' },
  draft_external: { it: 'Bozze di messaggi in uscita', en: 'Outbound drafts' },
  'read-file': { it: 'Lettura di file', en: 'Read files' },
  'list-directory': { it: 'Elenco delle cartelle', en: 'List folders' },
  'write-file': { it: 'Scrittura di file', en: 'Write files' },
  'run-command': { it: 'Comandi', en: 'Commands' },
  'use-app': { it: 'Computer e schermo', en: 'Computer and screen' },
  'list-credentials': { it: 'Elenco delle credenziali', en: 'List credentials' },
  update_state: { it: 'Cambiare un’automazione', en: 'Change an automation' },
  update_memory: { it: 'Prendere nota (memoria)', en: 'Take notes (memory)' },
  recall_memory: { it: 'Ricordare (memoria)', en: 'Recall (memory)' },
  skill: { it: 'Skill del bot', en: 'Bot skills' },
  update_skill: { it: 'Modificare le skill', en: 'Change skills' },
  search_connectors: { it: 'Cerca app da collegare', en: 'Search apps to connect' },
  offer_connector: { it: 'Proporre un’app', en: 'Offer an app' },
  add_mcp_server: { it: 'Aggiungere un server MCP', en: 'Add an MCP server' },
  install_plugin: { it: 'Installare un plugin', en: 'Install a plugin' },
  find_tools: { it: 'Cercare gli strumenti', en: 'Find tools' },
  use_tool: { it: 'Usare uno strumento', en: 'Use a tool' },
  send_to_agent: { it: 'Inviare a un altro bot', en: 'Send to another bot' },
  list_agents: { it: 'Elenco dei bot', en: 'List bots' },
  propose_rule_change: { it: 'Proporre una regola', en: 'Propose a rule' },
  create_task: { it: 'Creare attività', en: 'Create tasks' },
  update_task: { it: 'Aggiornare attività', en: 'Update tasks' },
  spawn_subagent: { it: 'Creare un aiutante', en: 'Spawn a helper' },
  check_subagent: { it: 'Controllare un aiutante', en: 'Check a helper' },
  message_subagent: { it: 'Scrivere a un aiutante', en: 'Message a helper' },
  stop_subagent: { it: 'Fermare un aiutante', en: 'Stop a helper' },
  wake_parent: { it: 'Svegliare il bot padre', en: 'Wake the parent bot' },
  create_agent: { it: 'Creare un bot', en: 'Create a bot' },
  create_group: { it: 'Creare squadre', en: 'Create teams' },
  update_agent: { it: 'Modificare bot', en: 'Change bots' },
  delete_agent: { it: 'Eliminare bot', en: 'Delete bots' },
  update_group: { it: 'Modificare squadre', en: 'Change teams' },
  post_to_group: { it: 'Messaggi in squadra', en: 'Team messages' },
  pass: { it: 'Passare il turno', en: 'Pass the turn' },
  web_search: { it: 'Ricerche sul web', en: 'Web searches' },
  web_fetch: { it: 'Lettura di pagine web', en: 'Read web pages' },
  await_shell: { it: 'Attendere un comando', en: 'Wait for a command' },
  copy_to_box: { it: 'Copia dal Mac al box', en: 'Copy from the Mac' },
  copy_from_box: { it: 'Copia dal box al Mac', en: 'Copy to the Mac' },
  write_document: { it: 'Scrivere documenti', en: 'Write documents' },
  edit_document: { it: 'Modificare documenti', en: 'Edit documents' },
  read_document: { it: 'Leggere documenti', en: 'Read documents' },
  visualize: { it: 'Grafici', en: 'Charts' },
  save_to_library: { it: 'Salvare in Libreria', en: 'Save to Library' },
  list_library: { it: 'Elenco della Libreria', en: 'List Library' },
  export_from_library: { it: 'Esportare dalla Libreria', en: 'Export from the Library' },
  fill_credential: { it: 'Compilare un accesso', en: 'Fill a login' },
  request_secure_input: { it: 'Chiedere un dato riservato', en: 'Ask for private input' },
  find_contacts: { it: 'Cercare contatti', en: 'Find contacts' },
  save_contact: { it: 'Salvare contatti', en: 'Save contacts' },
  '*': { it: 'Tutte le altre azioni', en: 'Everything else' }
}

/** I nomi delle famiglie di prefisso (dati per costruzione, come NAMES). */
const PREFIX_NAMES: Record<string, Localized> = {
  mcp__: { it: 'Strumenti delle app collegate', en: 'Connected app tools' },
  composio__: { it: 'Azioni delle app (Composio)', en: 'App actions (Composio)' },
  browser_: { it: 'Azioni nel browser del bot', en: 'Bot browser actions' },
  computer_: { it: 'Azioni al computer del bot', en: 'Bot computer actions' }
}

/** Il nome tecnico reso leggibile: read-file → Read file. */
export function readableToolName(tool: string): string {
  const words = tool.trim().replace(/[_\-.]+/g, ' ').trim()
  if (!words) return tool
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * P2 (fase pulizia): il contesto del nome umano — la lingua e i dati che la
 * card già porta nel meta (il nome dell'azione Composio dai dati di Composio,
 * il nome del server MCP). Tutto opzionale: senza dati si ricava dal nome
 * dello strumento.
 */
export interface ToolDisplayCtx {
  lang: UiLanguage
  /** il nome umano del server MCP (meta.mcpApp della card), se noto */
  mcpServer?: string
  /** i dati dell'azione Composio (meta.composioAction della card) */
  composio?: { app?: string; action?: string; original?: string }
}

/** Lo slug di un'azione reso leggibile: CREATE_REMINDER → Create reminder. */
function readableActionSlug(slug: string): string {
  return readableToolName(slug.trim().toLowerCase()).trim()
}

/**
 * Il nome umano di uno strumento (pura, UNICA — P2):
 * - azione Composio: «Slack · Create reminder» — il nome dell'app dal
 *   catalogo, il nome dell'azione dai dati Composio di ctx (o dallo slug);
 * - strumento di un server MCP: «Notion · <nome dello strumento>» — il nome
 *   del server da ctx (meta.mcpApp) o dallo slug, il nome dello strumento
 *   senza prefisso;
 * - strumenti del bot: la voce esatta del catalogo qui sopra;
 * - nome sconosciuto: il nome tecnico, come oggi in chat.
 */
export function toolDisplayName(tool: string, ctx: ToolDisplayCtx | UiLanguage = 'it'): string {
  const lang: UiLanguage = typeof ctx === 'string' ? ctx : ctx.lang

  // azione Composio: l'app dal catalogo (mai «slack»), l'azione dai dati
  if (tool.startsWith('composio__')) {
    const parts = tool.split('__')
    if (parts.length >= 3) {
      const app = composioToolkitName(parts[1] ?? '')
      const data = typeof ctx === 'string' ? undefined : ctx.composio
      const action =
        (data?.original || data?.action || '').trim() ||
        readableActionSlug(bareActionSlug(parts.slice(2).join('__')))
      return action ? `${app} · ${action}` : app
    }
  }

  // strumento di un server MCP: «Notion · <nome dello strumento>»
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__')
    if (parts.length >= 3) {
      const server = (typeof ctx === 'string' ? '' : (ctx.mcpServer ?? '')).trim() || readableToolName(parts[1] ?? '')
      const bare = parts.slice(2).join('__')
      return `${server} · ${readableToolName(bare)}`
    }
  }

  const exact = NAMES[tool]
  if (exact) return typeof exact === 'string' ? exact : exact[lang]
  const family = Object.entries(PREFIX_NAMES).find(([prefix]) => tool.startsWith(prefix))?.[1]
  if (family) return typeof family === 'string' ? family : family[lang]
  // P2: nome sconosciuto → il nome tecnico, come oggi
  return tool
}

/**
 * P4 (fase pulizia): il nome e la descrizione di uno strumento di un server
 * MCP come si mostrano ALL'UTENTE — senza il prefisso mcp__<server>__ e senza
 * il tag «[MCP:…]» della descrizione. Il prefisso e il tag che riceve il
 * MODELLO (costruiti in mcp/index.ts) restano intatti: questa funzione non
 * tocca ciò che viene salvato o mandato al modello, solo ciò che si stampa.
 * Funzione PURA e UNICA per tutte le superfici della UI.
 */
export function mcpToolPresentation(name: string, description: string): { name: string; description: string } {
  const parts = name.split('__')
  const bare = name.startsWith('mcp__') && parts.length >= 3 ? parts.slice(2).join('__') : name
  return { name: bare, description: description.replace(/^\[MCP:[^\]]*\]\s?/, '') }
}
