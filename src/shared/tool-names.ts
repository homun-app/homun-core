// Fase impostazioni (I4.5): il nome umano degli strumenti per la pagina
// Approvazioni — in testa alla riga il nome che capirebbe chiunque, sotto
// piccolo e grigio il nome tecnico che vive nel database. Le frasi seguono il
// lessico di lib/activity.ts (il linguaggio della mascotte), ma qui serve un
// NOME, non un verbo: «Messaggi all'utente», non «parla con l'utente…».
// Le voci mancanti ricadono sul nome tecnico reso leggibile (maiuscola e
// spazi al posto dei trattini), i prefissi noti hanno la loro famiglia.
import type { Localized } from './types'

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
  update_memory: { it: 'Prendere nota (memoria)', en: 'Take notes (memory)' },
  recall_memory: { it: 'Ricordare (memoria)', en: 'Recall (memory)' },
  skill: { it: 'Skill del bot', en: 'Bot skills' },
  update_skill: { it: 'Modificare le skill', en: 'Change skills' },
  search_connectors: { it: 'Cerca app da collegare', en: 'Search apps to connect' },
  offer_connector: { it: 'Proporre un’app', en: 'Offer an app' },
  send_to_agent: { it: 'Messaggi tra bot', en: 'Messages between bots' },
  list_agents: { it: 'Elenco dei bot', en: 'List bots' },
  propose_rule_change: { it: 'Proporre una regola', en: 'Propose a rule' },
  create_task: { it: 'Creare attività', en: 'Create tasks' },
  update_task: { it: 'Aggiornare attività', en: 'Update tasks' },
  spawn_subagent: { it: 'Creare un aiutante', en: 'Spawn a helper' },
  check_subagent: { it: 'Controllare un aiutante', en: 'Check a helper' },
  message_subagent: { it: 'Scrivere a un aiutante', en: 'Message a helper' },
  stop_subagent: { it: 'Fermare un aiutante', en: 'Stop a helper' },
  wake_parent: { it: 'Svegliare il bot padre', en: 'Wake the parent bot' },
  create_agent: { it: 'Creare bot', en: 'Create bots' },
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
  export_from_library: { it: 'Esportare dalla Libreria', en: 'Export from Library' },
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
 * Il nome umano di uno strumento (pura): la voce esatta della tabella, o la
 * famiglia del prefisso (mcp__ = strumenti delle app collegate,
 * composio__ = azioni Composio, browser_ = browser del bot, computer_ =
 * computer del bot), o il nome tecnico reso leggibile.
 */
export function toolDisplayName(tool: string, lang: 'it' | 'en' = 'it'): string {
  const exact = NAMES[tool]
  if (exact) return typeof exact === 'string' ? exact : exact[lang]
  const family = Object.entries(PREFIX_NAMES).find(([prefix]) => tool.startsWith(prefix))?.[1]
  if (family) return typeof family === 'string' ? family : family[lang]
  return readableToolName(tool)
}
