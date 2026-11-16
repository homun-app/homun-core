// CC4 (fase computer-card): quali strumenti sono «del computer». L'elenco è
// ESPLICITO (COMPUTER_TOOLS in activity.ts + la famiglia browser* del
// registro e la facciata browser) e QUESTO test lo blinda contro il REGISTRO
// degli strumenti del daemon: uno strumento nuovo o è del computer, o sta
// nell'elenco ESPlicito degli esclusi — se nasce nel mezzo, il test FALLISCE
// e chi lo ha scritto decide da che parte sta (la card «Computer» conta
// SOLO gli strumenti del computer per dire «Acceso»). I nomi si prendono dal
// REGISTRO (toolDefs, computerToolDefs, i browser del manager, le facciate,
// find_tools, i provider della ricerca): mai scritti a mano due volte.
import { describe, expect, it } from 'vitest'
import { isComputerTool } from '../activity'
import { toolDefs, computerToolDefs, wakeParentToolDef } from '../../../../main/agent/tools'
import { browserToolDefs } from '../../../../main/agent/browser'
import { FACADES } from '../../../../main/agent/facades'
import { findToolsGroupedDef } from '../../../../main/mcp/find-tools'
import {
  youKeylessProvider, exaMcpKeylessProvider, tavilyKeylessProvider, EXA_MCP_SEARCH_TOOL
} from '../../../../main/agent/web-search-providers'

/** Il REGISTRO degli strumenti: i nomi VERI, non scritti a mano. */
function registry(): string[] {
  return [
    ...toolDefs.map((t) => t.name),
    ...computerToolDefs.map((t) => t.name),
    ...browserToolDefs.map((t) => t.name),
    ...Object.keys(FACADES),
    wakeParentToolDef.name,
    findToolsGroupedDef([]).name,
    youKeylessProvider().name,
    exaMcpKeylessProvider().name,
    tavilyKeylessProvider().name,
    EXA_MCP_SEARCH_TOOL
  ]
}

/**
 * Gli strumenti che NON sono del computer del bot, ESPliciti: la chat, la
 * memoria, i documenti, i task, le app e i connettori, la ricerca web, la
 * gestione dei bot e dei figli, le skill. Se uno strumento NUOVO non sta né
 * qui né tra i computer, il test sotto fallisce: va classificato.
 */
const NOT_COMPUTER_TOOLS: ReadonlySet<string> = new Set([
  // la chat con l'utente e i suoi input (le richieste e le domande all'utente)
  'send_to_user', 'message_user', 'ask_user', 'request_secure_input', 'draft_external', 'post_to_group',
  // la memoria e la storia
  'update_memory', 'recall_memory', 'search_history', 'read_history',
  // i documenti e la libreria
  'write_document', 'edit_document', 'read_document', 'visualize', 'save_to_library', 'list_library', 'export_from_library',
  // i task e i bot (creazione, gestione, figli)
  'create_task', 'update_task', 'pass', 'propose_rule_change',
  'send_to_agent', 'list_agents', 'create_agent', 'update_agent', 'update_self', 'delete_agent',
  'create_group', 'update_group', 'spawn_subagent', 'check_subagent', 'message_subagent', 'stop_subagent', 'update_state', 'wake_parent',
  // le app del Mac/Composio e i connettori (NON toccano il box del bot)
  'use-app', 'search_connectors', 'offer_connector', 'add_mcp_server', 'install_plugin', 'find_tools',
  // credenziali e contatti (il vault del daemon, non il box)
  'list-credentials', 'fill_credential', 'find_contacts', 'save_contact',
  // le skill
  'skill', 'update_skill',
  // la ricerca web e i suoi provider (show_images: la galleria in chat, CL3)
  'web_search', 'web_fetch', 'show_images', 'you', 'exa', 'tavily', 'web_search_exa',
  // le facciate che NON sono il browser
  'document', 'task', 'memory',
  // la richiesta di presa di controllo è una domanda ALL'UTENTE, non un'azione nel box
  'request_takeover'
])

describe('CC4: il registro degli strumenti è TUTTO classificato (computer o escluso)', () => {
  it('ogni strumento del registro o è del computer o è ESPlicitamente escluso', () => {
    const uncovered = registry().filter((n) => !isComputerTool(n) && !NOT_COMPUTER_TOOLS.has(n))
    expect(uncovered).toEqual([])
    expect(new Set(registry()).size).toBe(registry().length) // il registro non ha doppioni
  })

  it('nessuno sta DUE volte (un escluso non è anche del computer)', () => {
    const both = [...NOT_COMPUTER_TOOLS].filter((n) => isComputerTool(n))
    expect(both).toEqual([])
  })

  it('la famiglia browser* del registro è TUTTA del computer, con la facciata browser', () => {
    for (const t of browserToolDefs.map((x) => x.name)) expect(isComputerTool(t), t).toBe(true)
    expect(isComputerTool('browser')).toBe(true)
    expect(isComputerTool('browser_futuro_nuovo')).toBe(true) // la famiglia intera, non i nomi uno a uno
  })

  it('i tool MCP generici NON sono del computer (non girano nel box del bot)', () => {
    expect(isComputerTool('mcp__linear__create_issue')).toBe(false)
    expect(isComputerTool('composio__GMAIL_SEND_EMAIL')).toBe(false)
  })
})
