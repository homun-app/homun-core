// R3 (fase app — ritocchi): il modello della card d'approvazione per gli
// strumenti Composio e MCP — come opening-rows, il test lavora sul modello
// puro che ApprovalCard rende punto per punto. Invariante: FUORI dai
// «Dettagli tecnici» non compare mai un nome tecnico (composio__…, mcp__…).
// Fase pulizia (P2): l'invariante si estende agli strumenti DEL BOT — il
// motivo del meta.ui e il titolo generico portano il nome umano di
// toolDisplayName, mai «create_agent richiede approvazione».
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { approvalAppOf, approvalTitleOf, approvalReasonPhrase, approvalTechnicalLine, approvalAskTitle } from '../lib/approval-app'
import { uiTextOfMetaTools } from '../lib/ui-text'
import { itCatalogEntries, enCatalogEntries } from './po-helper'

// come la sidebar: le etichette si risolvono dal catalogo it (i msgid nuovi
// ricadono su se stessi — la lingua sorgente è l'italiano)
i18n.load('it', itCatalogEntries())
i18n.load('en', enCatalogEntries())
i18n.activate('it')

/** Il «come si rende» la card: titolo + motivo nella lingua attiva, e i dettagli tecnici separati. */
function rendered(tool: string, meta: Record<string, unknown> | null | undefined, agentName = 'Contabile', lang: 'it' | 'en' = 'it') {
  const info = approvalAppOf(tool, meta)
  const title = approvalTitleOf(info, agentName, lang)
  const askTitle = approvalAskTitle(tool, meta, agentName, lang)
  return {
    kind: info?.kind ?? null,
    title: title === null ? (typeof askTitle === 'string' ? askTitle : i18n.t(askTitle)) : typeof title === 'string' ? title : i18n.t(title),
    reason: info ? (approvalReasonPhrase(info) ? i18n.t(approvalReasonPhrase(info)!) : null) : null,
    reasonUi: uiTextOfMetaTools(meta, lang),
    technical: info ? approvalTechnicalLine(info, tool) : null
  }
}

describe('R3 — la card d\'approvazione senza riga tecnica (Composio e MCP)', () => {
  const composioMeta = {
    tool: 'composio__slack__SLACK_CREATE_REMINDER',
    composioAction: { app: 'Slack', action: 'Create reminder', slug: 'SLACK_CREATE_REMINDER', version: '20260101_00' },
    input: { channel: '#sonda', text: 'ricordati la sonda' }
  }

  it('card Composio: titolo «Slack · Crea promemoria» (R4) e frase umana di scrittura', () => {
    const r = rendered('composio__slack__SLACK_CREATE_REMINDER', composioMeta)
    expect(r.kind).toBe('composio')
    expect(r.title).toBe('Slack · Crea promemoria')
    expect(r.reason).toBe('Vuole fare questa azione su Slack.')
  })

  it('card Composio DISTRUTTIVA: la frase dice che non si può annullare', () => {
    const r = rendered('composio__slack__SLACK_DELETE_MESSAGE', {
      ...composioMeta,
      tool: 'composio__slack__SLACK_DELETE_MESSAGE',
      composioAction: { app: 'Slack', action: 'Delete message', slug: 'SLACK_DELETE_MESSAGE' },
      composioDestructive: true
    })
    expect(r.reason).toBe("Vuole fare un'azione che non si può annullare su Slack.")
  })

  it('card Composio in INGLESE: il nome originale di Composio («Slack · Create reminder»)', () => {
    const r = rendered('composio__slack__SLACK_CREATE_REMINDER', composioMeta, 'Contabile', 'en')
    expect(r.title).toBe('Slack · Create reminder')
  })

  it('card Composio in inglese col nome SALVATO già localizzato: vince l\'originale di Composio, mai «Crea promemoria»', () => {
    const r = rendered('composio__slack__SLACK_CREATE_REMINDER', {
      ...composioMeta,
      composioAction: { app: 'Slack', action: 'Crea promemoria', slug: 'SLACK_CREATE_REMINDER', version: '20260101_00', original: 'Create reminder' }
    }, 'Contabile', 'en')
    expect(r.title).toBe('Slack · Create reminder')
  })

  it('FUORI dai dettagli tecnici non compare mai composio__ né mcp__ (card Composio e MCP)', () => {
    const composio = rendered('composio__slack__SLACK_CREATE_REMINDER', composioMeta)
    const mcp = rendered('mcp__ufficio__send_email', { tool: 'mcp__ufficio__send_email', mcpApp: 'Ufficio' })
    for (const r of [composio, mcp]) {
      expect(`${r.title} ${r.reason}`).not.toMatch(/composio__|mcp__/)
      // il nome tecnico sta DENTRO i dettagli, con server o toolkit
      expect(r.technical).toMatch(/^(composio__|mcp__)/)
    }
  })

  it('i Dettagli tecnici: nome tecnico, toolkit/server e versione (Composio)', () => {
    const r = rendered('composio__slack__SLACK_CREATE_REMINDER', composioMeta)
    expect(r.technical).toBe('composio__slack__SLACK_CREATE_REMINDER\nComposio · Slack · versione 20260101_00')
  })

  it('i Dettagli tecnici MCP: nome tecnico e server', () => {
    const r = rendered('mcp__ufficio__send_email', { tool: 'mcp__ufficio__send_email', mcpApp: 'Ufficio' })
    expect(r.technical).toBe('mcp__ufficio__send_email\nserver Ufficio')
  })

  it('card MCP: titolo umano col nome del server e frase di scrittura', () => {
    const r = rendered('mcp__ufficio__send_email', { tool: 'mcp__ufficio__send_email', mcpApp: 'Ufficio' })
    expect(r.title).toBe('Contabile vuole usare uno strumento di Ufficio')
    expect(r.reason).toBe('Vuole fare questa azione su Ufficio.')
  })

  it('card MCP SENZA meta.mcpApp (entry vecchia): il server si ricava dal nome del tool', () => {
    const r = rendered('mcp__ufficio__send_email', { tool: 'mcp__ufficio__send_email' })
    expect(r.reason).toBe('Vuole fare questa azione su ufficio.')
  })

  it('card MCP con annotazione distruttiva: frase che non si può annullare', () => {
    const r = rendered('mcp__ufficio__delete_all', { tool: 'mcp__ufficio__delete_all', mcpApp: 'Ufficio', mcpDestructive: true })
    expect(r.reason).toBe("Vuole fare un'azione che non si può annullare su Ufficio.")
  })

  it('gli altri tool NON cambiano: nessuna frase umana, il motivo resta quello del gate', () => {
    const info = approvalAppOf('run-command', { tool: 'run-command' })
    expect(info).toBeNull()
    expect(approvalTitleOf(info, 'Contabile', 'it')).toBeNull()
  })

  it('card Composio entry vecchia (senza slug/versione nel meta): titolo dal nome completo del tool', () => {
    const r = rendered('composio__gmail__GMAIL_SEND_EMAIL', {
      tool: 'composio__gmail__GMAIL_SEND_EMAIL',
      composioAction: { app: 'Gmail', action: 'Send email' }
    })
    expect(r.title).toBe('Gmail · Invia email')
  })
})

describe('P2 — la card degli strumenti DEL BOT senza nome tecnico', () => {
  it('create_agent: il motivo del meta.ui dice «Creare un bot richiede approvazione»', () => {
    const r = rendered('create_agent', {
      tool: 'create_agent',
      ui: { id: 'approval.toolRequires', values: { tool: 'create_agent' } }
    })
    expect(r.reasonUi).toBe('Creare un bot richiede approvazione')
    // U1 (fase pulizia · ritocchi): il titolo usa la FRASE VERBALE — mai
    // «vuole usare create_agent», e nemmeno «vuole usare Creare un bot»
    expect(r.title).toBe('Contabile vuole creare un bot')
  })

  it('U1: in inglese il titolo è «{name} wants to {action}» («Contabile wants to create a bot»)', () => {
    i18n.activate('en')
    try {
      const r = rendered('create_agent', {
        tool: 'create_agent',
        ui: { id: 'approval.toolRequires', values: { tool: 'create_agent' } }
      }, 'Contabile', 'en')
      expect(r.title).toBe('Contabile wants to create a bot')
    } finally {
      i18n.activate('it')
    }
  })

  it('U1: un altro strumento del bot con la sua frase («Contabile vuole inviare un messaggio a un altro bot»)', () => {
    expect(rendered('send_to_agent', { tool: 'send_to_agent' }).title).toBe('Contabile vuole inviare un messaggio a un altro bot')
  })

  it('send_to_agent (contaminato): il motivo porta «Inviare a un altro bot»', () => {
    const r = rendered('send_to_agent', {
      tool: 'send_to_agent',
      ui: { id: 'approval.contaminated', values: { tool: 'send_to_agent' } }
    })
    expect(r.reasonUi).toContain('Inviare a un altro bot')
    expect(r.reasonUi).not.toMatch(/send_to_agent/)
  })

  it('card MCP con motivo del meta.ui: {tool} umano anche lì («Notion · Search pages …»)', () => {
    const r = rendered('mcp__notion__search_pages', {
      tool: 'mcp__notion__search_pages',
      mcpApp: 'Notion',
      ui: { id: 'approval.mcpOutward', values: { tool: 'mcp__notion__search_pages' } }
    })
    expect(r.reasonUi).toBe('Notion · Search pages agisce verso l’esterno (annotazione del server MCP)')
  })

  it('i testi del meta.ui SENZA valori strumento passano identici', () => {
    const r = rendered('run-command', { tool: 'run-command', ui: { id: 'approval.rcRequires', values: { key: 'curl' } } })
    expect(r.reasonUi).toBe('curl richiede approvazione')
  })

  it('il titolo specifico dei tool noti non cambia (comando, file…)', () => {
    expect(rendered('run-command', { tool: 'run-command' }).title).toBe('Contabile vuole eseguire un comando')
    expect(rendered('write-file', { tool: 'write-file' }).title).toBe('Contabile vuole scrivere un file')
    expect(rendered('update_state', { tool: 'update_state' }).title).toBe('Contabile vuole cambiare un\'automazione')
  })

  it('tool senza etichetta: il nome tecnico, come oggi', () => {
    const r = rendered('tool_sconosciuto', {
      tool: 'tool_sconosciuto',
      ui: { id: 'approval.toolRequires', values: { tool: 'tool_sconosciuto' } }
    })
    // U1: nessuna frase verbale → resta il modello di oggi, «vuole usare …»
    expect(r.title).toBe('Contabile vuole usare tool_sconosciuto')
    expect(r.reasonUi).toBe('tool_sconosciuto richiede approvazione')
  })

  it('U1: un\'azione Composio senza dati della card passa dal modello «vuole usare Slack · Create reminder»', () => {
    // il caso del titolo GENERICO per Composio (approvalAskTitle): nessuna
    // frase verbale, il nome umano dell'azione
    const title = approvalAskTitle('composio__slack__SLACK_CREATE_REMINDER', null, 'Contabile', 'it')
    expect(i18n.t(title)).toBe('Contabile vuole usare Slack · Create reminder')
  })
})
