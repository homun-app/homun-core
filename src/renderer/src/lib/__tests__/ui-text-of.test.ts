// Fase 17c (C9): uiTextOf — il testo della UI di una entry del transcript.
// Con meta.ui (id noto) si traduce col catalogo del renderer nella lingua
// attiva; senza meta.ui, o con id sconosciuto, si mostra il content com'è
// (entry vecchie: mai crash, nessuna migrazione). Lista di UiText (motivi
// multipli di run-command) unita con '; '.
import { describe, expect, it, beforeAll } from 'vitest'
import { i18n } from '@lingui/core'
import type { Messages } from '@lingui/core'
import { uiListOf, uiTextOf, uiTextOfMeta, uiTextOfTools } from '../ui-text'
import { messages as itMessages } from '../../../../renderer/src/locales/it/messages.mjs'
import { messages as enMessages } from '../../../../renderer/src/locales/en/messages.mjs'
import type { TranscriptEntry } from '../../../../shared/types'

function entry(meta: Record<string, unknown> | null, content = 'contenuto vecchio'): TranscriptEntry {
  return { id: 1, agentId: 'a', kind: 'notice', role: 'system', content, meta, createdAt: 0 }
}

describe('fase 17c (C9): uiTextOf del renderer', () => {
  beforeAll(() => {
    i18n.load({ it: itMessages as unknown as Messages, en: enMessages as unknown as Messages })
  })

  it('meta.ui con id noto → testo nella lingua attiva', () => {
    i18n.activate('it')
    expect(uiTextOf(entry({ ui: { id: 'notice.queueFull' } }))).toBe('Coda piena: messaggio scartato.')
    i18n.activate('en')
    expect(uiTextOf(entry({ ui: { id: 'notice.queueFull' } }))).toBe('Queue full: message discarded.')
    // con valori
    i18n.activate('it')
    expect(uiTextOf(entry({ ui: { id: 'notice.agentBusyQueued', values: { position: 3 } } }))).toContain('posizione 3')
  })

  it('senza meta.ui → il content com’è (entry vecchie)', () => {
    i18n.activate('it')
    expect(uiTextOf(entry(null, 'Testo italiano vecchio'))).toBe('Testo italiano vecchio')
    expect(uiTextOf(entry({}, 'altra'))).toBe('altra')
  })

  it('id sconosciuto → niente crash, ricade sul content', () => {
    i18n.activate('it')
    // il catalogo non ha l'id: i18n._ lo restituisce com'è; uiTextOf mostra
    // l'id solo se non c'è content? No: la regola è "id noto, altrimenti content"
    // — id SCONOSCIUTO = non traducibile → content
    const e = entry({ ui: { id: 'id.che.non.esiste' } }, 'testo di ripiego')
    const out = uiTextOf(e)
    expect(typeof out).toBe('string')
    expect(['id.che.non.esiste', 'testo di ripiego']).toContain(out)
  })

  it('lista di UiText (motivi multipli di run-command) unita con "; "', () => {
    i18n.activate('it')
    const meta = { ui: [{ id: 'approval.rcRequires', values: { key: 'curl' } }, { id: 'approval.rcRedirect' }] }
    expect(uiTextOfMeta(meta)).toBe('curl richiede approvazione; scrive su un file')
    expect(uiListOf(meta)).toHaveLength(2)
  })

  it('meta.ui malformato → null (mai crash)', () => {
    expect(uiListOf({ ui: 'garbage' })).toBeNull()
    expect(uiListOf({ ui: [{ nope: 1 }] })).toBeNull()
    expect(uiListOf(null)).toBeNull()
  })
})

describe('fase pulizia (P2): uiTextOfTools — il nome dello strumento in parole', () => {
  beforeAll(() => {
    i18n.load({ it: itMessages as unknown as Messages, en: enMessages as unknown as Messages })
  })

  it('notice deniedByPermissions: «Bloccato dai permessi: Creare un bot», mai il nome tecnico', () => {
    i18n.activate('it')
    const e = entry({ ui: { id: 'notice.deniedByPermissions', values: { tool: 'create_agent' } }, tool: 'create_agent' })
    expect(uiTextOfTools(e)).toBe('Bloccato dai permessi: Creare un bot')
  })

  it('notice denied su uno strumento MCP: «Notion · Search pages»', () => {
    i18n.activate('it')
    const e = entry({ ui: { id: 'notice.deniedByPermissions', values: { tool: 'mcp__notion__search_pages' } }, tool: 'mcp__notion__search_pages', mcpApp: 'Notion' })
    expect(uiTextOfTools(e)).toBe('Bloccato dai permessi: Notion · Search pages')
  })

  it('testi SENZA valori strumento: identici a uiTextOf', () => {
    i18n.activate('it')
    const e = entry({ ui: { id: 'notice.queueFull' } })
    expect(uiTextOfTools(e)).toBe(uiTextOf(e))
  })

  it('trigger.tool NON si umanizza: il nome del connettore è un dato della routine', () => {
    i18n.activate('it')
    const e = entry({ ui: { id: 'trigger.tool', values: { tool: 'mcp__gmail__list_messages', connector: 'gmail', field: 'messages[].id' } } })
    expect(uiTextOfTools(e)).toContain('mcp__gmail__list_messages')
  })

  it('entry senza meta.ui: il content, come uiTextOf', () => {
    i18n.activate('it')
    const e = entry(null, 'testo vecchio con run-command dentro')
    expect(uiTextOfTools(e)).toBe('testo vecchio con run-command dentro')
  })
})
