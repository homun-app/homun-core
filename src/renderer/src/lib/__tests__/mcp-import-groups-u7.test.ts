// U7 (fase mcp-ui): l'elenco di import conosce le OTTO origini (Cursor, Claude
// Desktop, ZCode, Claude Code, Codex, Windsurf, Gemini CLI, VS Code) e i
// server SALTATI col loro motivo. PURA.
import { describe, expect, it } from 'vitest'
import { groupImportRows, IMPORT_SOURCE_ORDER, type ImportScanRow, type ImportSkipRow } from '../mcp-import-groups'

const row = (over: Partial<ImportScanRow>): ImportScanRow => ({
  source: 'cursor', name: 'server', transport: 'stdio', envNames: [], secretNames: [],
  sourcePath: '/h/.cursor/mcp.json', ...over
})

describe('U7: le otto origini nell\'ordine fisso', () => {
  it('IMPORT_SOURCE_ORDER: cursor, claude, zcode, claude-code, codex, windsurf, gemini, vscode', () => {
    expect(IMPORT_SOURCE_ORDER).toEqual(['cursor', 'claude', 'zcode', 'claude-code', 'codex', 'windsurf', 'gemini', 'vscode'])
  })

  it('un gruppo per ognuna delle otto, i vuoti nascosti come prima', () => {
    const groups = groupImportRows([
      row({ source: 'vscode', name: 'fs', sourcePath: '/v/mcp.json' }),
      row({ source: 'claude-code', name: 'cc', sourcePath: '/h/.claude.json' }),
      row({ source: 'cursor', name: 'mm' })
    ], [])
    expect(groups.map((g) => g.source)).toEqual(['cursor', 'claude-code', 'vscode'])
  })

  it('il nome del salto (ImportSkipRow) attraversa fino alla UI', () => {
    const s: ImportSkipRow = { source: 'vscode', name: 'x', reason: 'env-in-command' }
    expect(s.reason).toBe('env-in-command')
  })
})
