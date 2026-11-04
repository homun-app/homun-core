// Fase impostazioni (I4.5): i nomi umani degli strumenti per la pagina
// Approvazioni — la tabella, le famiglie di prefisso e il ripiego leggibile.
import { describe, expect, it } from 'vitest'
import { toolDisplayName, readableToolName } from '../tool-names'
import { getPermissions } from '../../main/store/db'
import type { PermissionRule } from '../types'

describe('toolDisplayName', () => {
  it('la voce esatta della tabella, nella lingua chiesta', () => {
    expect(toolDisplayName('run-command', 'it')).toBe('Comandi')
    expect(toolDisplayName('run-command', 'en')).toBe('Commands')
    expect(toolDisplayName('message_user', 'it')).toBe('Progressi in chat')
    expect(toolDisplayName('*', 'it')).toBe('Tutte le altre azioni')
  })

  it('le famiglie di prefisso', () => {
    expect(toolDisplayName('mcp__linear__create_issue', 'it')).toBe('Strumenti delle app collegate')
    expect(toolDisplayName('browser_click', 'en')).toBe('Bot browser actions')
    expect(toolDisplayName('computer_click', 'it')).toBe('Azioni al computer del bot')
  })

  it('il ripiego: il nome tecnico reso leggibile', () => {
    expect(toolDisplayName('tool-sconosciuto', 'it')).toBe('Tool sconosciuto')
    expect(readableToolName('read-file')).toBe('Read file')
  })

  it('I4.5: OGNI regola di default dei permessi ha un nome (niente tecnico nudo in pagina)', () => {
    const rules: PermissionRule[] = getPermissions().rules
    for (const r of rules) {
      const named = toolDisplayName(r.tool, 'it')
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
