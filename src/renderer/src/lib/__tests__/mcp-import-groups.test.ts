// U2 (fase mcp-ui): «Importa da Cursor, Claude o ZCode» — l'elenco si
// RAGGRUPPA per origine (i gruppi vuoti si nascondono), i DOPPIONI ESATTI
// (stesso nome E stesso comando o URL) si uniscono con «anche in <origine>»,
// lo stesso nome con configurazione diversa resta su due righe, e i server
// già presenti in Homun si spengono («già collegato», non selezionabili).
// PURA: qui solo la funzione di raggruppamento; l'impaginazione la prova la
// sonda sul DOM vero.
import { describe, expect, it } from 'vitest'
import { groupImportRows, importRowKey, type ImportScanRow } from '../mcp-import-groups'

const row = (over: Partial<ImportScanRow>): ImportScanRow => ({
  source: 'cursor',
  name: 'server',
  transport: 'stdio',
  envNames: [],
  secretNames: [],
  sourcePath: '/home/prova/.cursor/mcp.json',
  ...over
})

describe('U2: groupImportRows — raggruppato per origine, doppioni uniti', () => {
  it('un gruppo per origine nell\'ordine fisso (Cursor, Claude Desktop, ZCode); i gruppi VUOTI si nascondono', () => {
    const groups = groupImportRows([
      row({ source: 'zcode', name: 'sequenza', sourcePath: '/home/prova/.zcode/cli/config.json' }),
      row({ source: 'cursor', name: 'mattermost' })
    ], [])
    expect(groups.map((g) => g.source)).toEqual(['cursor', 'zcode'])
    expect(groups[0]!.sourcePath).toBe('/home/prova/.cursor/mcp.json')
    expect(groups[1]!.sourcePath).toBe('/home/prova/.zcode/cli/config.json')
  })

  it('DOPPIONE ESATTO (stesso nome e stesso comando) in più origini: UNA riga sola, con ancheIn', () => {
    const groups = groupImportRows([
      row({ source: 'cursor', name: 'mattermost', commandLine: 'npx -y @donach/mattermost-mcp' }),
      row({ source: 'zcode', name: 'mattermost', commandLine: 'npx -y @donach/mattermost-mcp', sourcePath: '/home/prova/.zcode/cli/config.json' })
    ], [])
    expect(groups.map((g) => g.source)).toEqual(['cursor']) // il gruppo ZCode resta vuoto → nascosto
    const r = groups[0]!.rows[0]!
    expect(r.name).toBe('mattermost')
    expect(r.source).toBe('cursor') // l'origine PRIMA in ordine vince
    expect(r.alsoIn).toEqual(['zcode'])
  })

  it('doppione esatto per URL (http), non solo per comando', () => {
    const groups = groupImportRows([
      row({ source: 'cursor', name: 'orion', transport: 'http', url: 'https://orion.example/mcp' }),
      row({ source: 'claude', name: 'orion', transport: 'http', url: 'https://orion.example/mcp', sourcePath: '/home/prova/Library/Application Support/Claude/claude_desktop_config.json' })
    ], [])
    expect(groups[0]!.rows).toHaveLength(1)
    expect(groups[0]!.rows[0]!.alsoIn).toEqual(['claude'])
  })

  it('stesso nome ma configurazione DIVERSA: due righe, ognuna nel suo gruppo', () => {
    const groups = groupImportRows([
      row({ source: 'cursor', name: 'mattermost', commandLine: 'npx -y @donach/mattermost-mcp' }),
      row({ source: 'zcode', name: 'mattermost', commandLine: 'node /altro/percorso/mm.js', sourcePath: '/home/prova/.zcode/cli/config.json' })
    ], [])
    expect(groups.map((g) => g.source)).toEqual(['cursor', 'zcode'])
    expect(groups[0]!.rows[0]!.alsoIn).toEqual([])
    expect(groups[1]!.rows[0]!.alsoIn).toEqual([])
  })

  it('il nome GIÀ presente in Homun: riga spenta e non selezionabile (existing)', () => {
    const groups = groupImportRows([
      row({ name: 'orion-moon', transport: 'http', url: 'https://orion.example/mcp' }),
      row({ name: 'altro' })
    ], ['orion-moon'])
    expect(groups[0]!.rows.find((r) => r.name === 'orion-moon')!.existing).toBe(true)
    expect(groups[0]!.rows.find((r) => r.name === 'altro')!.existing).toBe(false)
  })

  it('il conteggio dei SEGRETI arriva alla riga (per «N segreti» col plurale)', () => {
    const groups = groupImportRows([
      row({ name: 'uno', secretNames: ['TOKEN'] }),
      row({ name: 'due', secretNames: ['TOKEN', 'KEY'] })
    ], [])
    expect(groups[0]!.rows.find((r) => r.name === 'uno')!.secretCount).toBe(1)
    expect(groups[0]!.rows.find((r) => r.name === 'due')!.secretCount).toBe(2)
  })

  it('importRowKey: la chiave di riga è stabile (origine PRIMARIA : nome) e univoca', () => {
    const g = groupImportRows([
      row({ name: 'mattermost', commandLine: 'npx -y mm' }),
      row({ source: 'zcode', name: 'mattermost', commandLine: 'npx -y mm', sourcePath: '/z' })
    ], [])[0]!
    expect(importRowKey(g.rows[0]!)).toBe('cursor:mattermost')
    // stesso nome, config diversa: chiavi diverse per origine
    const g2 = groupImportRows([
      row({ name: 'mattermost', commandLine: 'npx -y mm' }),
      row({ source: 'zcode', name: 'mattermost', commandLine: 'node x.js', sourcePath: '/z' })
    ], [])
    expect(new Set(g2.flatMap((x) => x.rows.map(importRowKey))).size).toBe(2)
  })
})
