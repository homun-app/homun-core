// R3 (fase app — ritocchi): il modello della card d'approvazione per gli
// strumenti Composio e MCP — come opening-rows, il test lavora sul modello
// puro che ApprovalCard rende punto per punto. Invariante: FUORI dai
// «Dettagli tecnici» non compare mai un nome tecnico (composio__…, mcp__…).
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { approvalAppOf, approvalTitleOf, approvalReasonPhrase, approvalTechnicalLine } from '../lib/approval-app'
import { itCatalogEntries } from './po-helper'

// come la sidebar: le etichette si risolvono dal catalogo it (i msgid nuovi
// ricadono su se stessi — la lingua sorgente è l'italiano)
i18n.load('it', itCatalogEntries())
i18n.activate('it')

/** Il «come si rende» la card: titolo + motivo nella lingua attiva, e i dettagli tecnici separati. */
function rendered(tool: string, meta: Record<string, unknown> | null | undefined, agentName = 'Contabile', lang: 'it' | 'en' = 'it') {
  const info = approvalAppOf(tool, meta)
  const title = approvalTitleOf(info, agentName, lang)
  return {
    kind: info?.kind ?? null,
    title: title === null ? null : typeof title === 'string' ? title : i18n.t(title),
    reason: info ? i18n.t(approvalReasonPhrase(info)) : null,
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
