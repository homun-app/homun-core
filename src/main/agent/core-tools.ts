// Fase velocità (S3): gli strumenti integrati si dividono in un elenco CORE
// fisso (sempre nel prompt del turno) e un elenco DIFFERITO, che il modello
// raggiunge con find_tools + use_tool (stessa idea di Rakazo,
// builtin-tool-bridge.ts: CORE_BUILTIN_TOOL_NAMES e partitionTools). Così
// ogni chiamata porta molti meno byte di schemi e l'elenco del turno non
// cambia durante il turno (condizione per la cache del prefisso).
// Tutto PURO: solo nomi e una partizione stabile.
import type { ToolDef } from './llm'

/**
 * Gli strumenti integrati SEMPRE nel prompt del turno. Alla proposta di
 * partenza della fase si aggiungono i tool di base del computer
 * (run-command, read-file, write-file, list-directory, use-app,
 * list-credentials): servono a QUALSIASI primo passo (i prompt li nominano
 * e la whitelist dei figli è costruita su di loro) — differirli renderebbe
 * il bot meno capace per risparmiare poco.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // i base del computer (vedi sopra: aggiunti alla proposta della fase)
  'run-command',
  'read-file',
  'write-file',
  'list-directory',
  'use-app',
  'list-credentials',
  // la proposta di partenza della fase
  'send_to_user',
  // fase risposta (R2): il progresso dei lavori lunghi nei turni non di
  // gruppo (nei gruppi si offre solo send_to_user, R7)
  'message_user',
  'ask_user',
  'draft_external',
  'web_search',
  'web_fetch',
  'update_memory',
  'recall_memory',
  'skill',
  'search_connectors',
  'offer_connector',
  'spawn_subagent',
  'check_subagent',
  'create_task',
  'update_task',
  'update_state',
  'write_document',
  'read_document',
  'edit_document',
  'visualize',
  'await_shell',
  'find_contacts',
  'fill_credential',
  'request_secure_input',
  'request_takeover',
  // quando esistono nel turno (fase): pass e post_to_group vivono in toolDefs
  // (i turni di gruppo); i tool del browser e dello schermo arrivano da
  // browser.ts/computerToolDefs coi prefissi browser_/computer_ e restano
  // core per costruzione (mai nell'elenco differito)
  'pass',
  'post_to_group'
])

/**
 * Gli strumenti integrati DIFFERITI: niente schema nel prompt, si trovano
 * con find_tools e si chiamano con use_tool. Sono i tool di amministrazione
 * e di scambio rari (bot, gruppi, skill, connettori, libreria, contatti):
 * nessun flusso li necesita al primo passo.
 */
export const DEFERRED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'list_agents',
  'create_agent',
  'update_agent',
  'delete_agent',
  'create_group',
  'update_group',
  'send_to_agent',
  'message_subagent',
  'stop_subagent',
  'update_skill',
  'add_mcp_server',
  'install_plugin',
  'propose_rule_change',
  'copy_to_box',
  'copy_from_box',
  'save_to_library',
  'list_library',
  'export_from_library',
  'save_contact'
])

/**
 * Le AREE dell'indice dei nomi differiti (come formatNameIndexText di
 * Rakazo): l'indice nella descrizione di find_tools raggruppa i nomi per
 * area, così il modello sa che esistono anche senza cercare.
 */
export const DEFERRED_TOOL_AREAS: ReadonlyArray<{ area: string; tools: ReadonlyArray<string> }> = [
  { area: 'Other bots and groups', tools: ['list_agents', 'create_agent', 'update_agent', 'delete_agent', 'create_group', 'update_group', 'send_to_agent'] },
  { area: 'Subagents', tools: ['message_subagent', 'stop_subagent'] },
  { area: 'Skills', tools: ['update_skill'] },
  { area: 'Connectors and plugins', tools: ['add_mcp_server', 'install_plugin'] },
  { area: 'Permissions', tools: ['propose_rule_change'] },
  { area: 'Files with the Mac', tools: ['copy_to_box', 'copy_from_box'] },
  { area: 'Library', tools: ['save_to_library', 'list_library', 'export_from_library'] },
  { area: 'Contacts', tools: ['save_contact'] }
]

/**
 * L'indice dei nomi degli integrati differiti, raggruppati per area (puro):
 * una riga per area presente nel turno, i nomi in ordine alfabetico. È il
 * testo che va nella descrizione di find_tools (il modello lo legge in ogni
 * chiamata: gli dice CHE COSA esiste dietro la ricerca).
 */
export function formatNameIndexText(deferredNames: string[]): string {
  const present = new Set(deferredNames)
  const lines: string[] = []
  for (const { area, tools } of DEFERRED_TOOL_AREAS) {
    const names = tools.filter((t) => present.has(t)).sort((a, b) => a.localeCompare(b))
    if (names.length) lines.push(`${area}: ${names.join(', ')}`)
  }
  // nomi differiti fuori da ogni area (non dovrebbe capitare: test di coerenza)
  const covered = new Set(DEFERRED_TOOL_AREAS.flatMap((a) => [...a.tools]))
  const extra = [...present].filter((n) => !covered.has(n)).sort((a, b) => a.localeCompare(b))
  if (extra.length) lines.push(`Other: ${extra.join(', ')}`)
  return lines.join('\n')
}

/**
 * La divisione core/differiti di un elenco di tool (puro, ordine stabile):
 * l'input sono gli integrati del turno DOPO le regole del turno (whitelist
 * dei figli, toolsForTurnSource: un figlio non trova con find_tools ciò che
 * la sua lista bianca esclude). Core = tutto ciò che non è nell'elenco
 * differito (i tool del browser e dello schermo, pass, post_to_group e
 * wake_parent vivono qui quando esistono nel turno).
 */
export function partitionTools(tools: ToolDef[]): { core: ToolDef[]; deferred: ToolDef[] } {
  const core: ToolDef[] = []
  const deferred: ToolDef[] = []
  for (const t of tools) {
    if (DEFERRED_TOOL_NAMES.has(t.name)) deferred.push(t)
    else core.push(t)
  }
  return { core, deferred }
}

/** L'esecutore degli integrati differiti: use_tool si «srotola» nel loop. */
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
