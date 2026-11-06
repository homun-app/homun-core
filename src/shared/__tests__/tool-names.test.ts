// Fase impostazioni (I4.5): i nomi umani degli strumenti per la pagina
// Approvazioni. Fase pulizia (P2): toolDisplayName(tool, ctx) è la funzione
// UNICA che dà il nome umano a tutto ciò che l'utente vede — la pagina
// Approvazioni, le card in chat e le notice — con le azioni Composio
// («Slack · Create reminder») e gli strumenti dei server MCP
// («Notion · <nome dello strumento>»). Il nome tecnico resta il ripiego
// finale (e vive nei «Dettagli tecnici» della card).
import { describe, expect, it } from 'vitest'
import { toolDisplayName, readableToolName, mcpToolPresentation } from '../tool-names'
import { getPermissions } from '../../main/store/db'
import type { PermissionRule } from '../types'

describe('toolDisplayName — strumenti del bot: etichetta del catalogo', () => {
  it('la voce esatta della tabella, nella lingua chiesta', () => {
    expect(toolDisplayName('run-command', { lang: 'it' })).toBe('Comandi')
    expect(toolDisplayName('run-command', { lang: 'en' })).toBe('Commands')
    expect(toolDisplayName('message_user', { lang: 'it' })).toBe('Progressi in chat')
    expect(toolDisplayName('*', { lang: 'it' })).toBe('Tutte le altre azioni')
  })

  it('P2: i verbi delle card («Creare un bot», «Inviare a un altro bot»)', () => {
    expect(toolDisplayName('create_agent', { lang: 'it' })).toBe('Creare un bot')
    expect(toolDisplayName('create_agent', { lang: 'en' })).toBe('Create a bot')
    expect(toolDisplayName('send_to_agent', { lang: 'it' })).toBe('Inviare a un altro bot')
    expect(toolDisplayName('send_to_agent', { lang: 'en' })).toBe('Send to another bot')
    expect(toolDisplayName('update_state', { lang: 'it' })).toBe('Cambiare un’automazione')
    expect(toolDisplayName('update_state', { lang: 'en' })).toBe('Change an automation')
  })

  it('P2: copre TUTTI gli strumenti del bot che possono chiedere approvazione', () => {
    // gli strumenti che il gate generico porta su una card approval.toolRequires
    const askers = [
      'update_state', 'update_memory', 'create_agent', 'update_agent', 'delete_agent',
      'create_group', 'update_group', 'send_to_agent', 'run-command', 'write-file',
      'read-file', 'use-app', 'update_skill', 'propose_rule_change', 'export_from_library',
      'fill_credential', 'save_contact', 'request_secure_input', 'copy_to_box', 'copy_from_box'
    ]
    for (const tool of askers) {
      const name = toolDisplayName(tool, { lang: 'it' })
      expect(name === tool ? `senza nome umano: ${tool}` : '').toBe('')
    }
  })

  it('la stringa di lingua resta accettata (pagina Approvazioni, I4.5)', () => {
    expect(toolDisplayName('run-command', 'it')).toBe('Comandi')
    expect(toolDisplayName('run-command', 'en')).toBe('Commands')
  })
})

describe('toolDisplayName — azioni Composio e server MCP (P2)', () => {
  it('azione Composio: «Slack · Create reminder» — app dal catalogo, azione dai dati', () => {
    expect(
      toolDisplayName('composio__slack__SLACK_CREATE_REMINDER', { lang: 'it', composio: { app: 'Slack', action: 'Create reminder' } })
    ).toBe('Slack · Create reminder')
  })

  it('azione Composio senza dati della card: il nome dallo slug dello strumento', () => {
    expect(toolDisplayName('composio__slack__SLACK_CREATE_REMINDER', { lang: 'it' })).toBe('Slack · Create reminder')
    expect(toolDisplayName('composio__gmail__GMAIL_SEND_EMAIL', { lang: 'en' })).toBe('Gmail · Send email')
  })

  it('azione Composio: il nome dell’app arriva dal catalogo, mai il toolkit minuscolo', () => {
    expect(
      toolDisplayName('composio__googlecalendar__GOOGLECALENDAR_LIST_EVENTS', { lang: 'it', composio: { app: 'googlecalendar', action: 'List events' } })
    ).toBe('Google Calendar · List events')
  })

  it('strumento di un server MCP: «Notion · <nome dello strumento>»', () => {
    expect(toolDisplayName('mcp__notion__search_pages', { lang: 'it', mcpServer: 'Notion' })).toBe('Notion · Search pages')
    expect(toolDisplayName('mcp__notion__search_pages', { lang: 'en', mcpServer: 'Notion' })).toBe('Notion · Search pages')
  })

  it('strumento MCP senza nome del server (entry vecchia): lo slug reso leggibile', () => {
    expect(toolDisplayName('mcp__notion__search_pages', { lang: 'it' })).toBe('Notion · Search pages')
    expect(toolDisplayName('mcp__ufficio__send_email', { lang: 'it' })).toBe('Ufficio · Send email')
  })

  it('le famiglie di prefisso restano per i nomi incompleti (regola mcp__*)', () => {
    expect(toolDisplayName('mcp__*', { lang: 'it' })).toBe('Strumenti delle app collegate')
    expect(toolDisplayName('browser_click', { lang: 'en' })).toBe('Bot browser actions')
    expect(toolDisplayName('computer_click', { lang: 'it' })).toBe('Azioni al computer del bot')
  })
})

describe('toolDisplayName — il ripiego', () => {
  it('nome sconosciuto: il nome tecnico, come oggi (P2)', () => {
    expect(toolDisplayName('tool_mai_visto', { lang: 'it' })).toBe('tool_mai_visto')
    expect(readableToolName('read-file')).toBe('Read file')
  })

  it('I4.5: OGNI regola di default dei permessi ha un nome (niente tecnico nudo in pagina)', () => {
    const rules: PermissionRule[] = getPermissions().rules
    for (const r of rules) {
      const named = toolDisplayName(r.tool, { lang: 'it' })
      // il nome umano non è il nome tecnico ripulito MECCANICAMENTE...
      const mechanical = r.tool === '*' ? null : readableToolName(r.tool)
      if (mechanical !== null) {
        expect(named === mechanical ? `senza nome umano: ${r.tool}` : '').toBe('')
      }
    }
  })

  it('I4.5: message_user è nei default dei permessi (accanto a send_to_user)', () => {
    const rules = getPermissions().rules
    expect(rules.some((r) => r.tool === 'message_user' && r.mode === 'always_allow')).toBe(true)
    expect(rules.some((r) => r.tool === 'send_to_user' && r.mode === 'always_allow')).toBe(true)
  })
})

describe('P4 (fase pulizia) — mcpToolPresentation: lo strumento come lo vede l’utente', () => {
  it('il nome senza prefisso mcp__<server>__ e la descrizione senza «[MCP:…]»', () => {
    expect(mcpToolPresentation('mcp__notion__search_pages', '[MCP:Notion] Search pages in the workspace')).toEqual({
      name: 'search_pages',
      description: 'Search pages in the workspace'
    })
  })

  it('il prefisso del MODELLO resta intatto nell’input: la funzione NON modifica il nome che riceve il modello', () => {
    const model = 'mcp__notion__search_pages'
    const shown = mcpToolPresentation(model, '[MCP:Notion] cerca')
    expect(shown.name).not.toContain('mcp__')
    expect(model).toBe('mcp__notion__search_pages')
  })

  it('più segmenti dopo il server e descrizione senza tag: tutto resta, il nome tiene i __ interni', () => {
    expect(mcpToolPresentation('mcp__ufficio__send__email_v2', '[MCP:Ufficio] invia')).toEqual({
      name: 'send__email_v2',
      description: 'invia'
    })
    expect(mcpToolPresentation('search', 'cerca senza tag')).toEqual({ name: 'search', description: 'cerca senza tag' })
  })

  it('descrizione vuota o solo tag: descrizione vuota, mai il tag al moto', () => {
    expect(mcpToolPresentation('mcp__notion__list', '[MCP:Notion]')).toEqual({ name: 'list', description: '' })
    expect(mcpToolPresentation('mcp__notion__list', '')).toEqual({ name: 'list', description: '' })
  })

  it('nome senza prefisso mcp__ ma con __: invariato (non è un nome MCP)', () => {
    expect(mcpToolPresentation('composio__slack__X', 'desc')).toEqual({ name: 'composio__slack__X', description: 'desc' })
  })
})
