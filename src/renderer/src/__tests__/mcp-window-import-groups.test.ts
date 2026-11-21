// U2 (fase mcp-ui): il render dell'elenco di import — componente VERO
// (ImportList esportata da McpWindow) con righe fintre, come gli altri test
// del renderer senza DOM: raggruppato per origine con intestazione (nome
// dell'app + percorso del file), icone del tipo (Terminal/Globe), segreti
// con l'icona lucide e il conteggio col plurale, doppione esatto unito con
// «anche in…», già collegato spento, e il fondo «N selezionati / Annulla /
// Importa N». NESSUNA emoji 🔒 nel markup.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, textOf, findAll, dialogPassThroughMock } from './render-helper'
import { groupImportRows, type ImportScanRow } from '../lib/mcp-import-groups'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())

const { ImportList } = await import('../components/McpWindow')

const rows: ImportScanRow[] = [
  { source: 'cursor', name: 'mattermost', transport: 'stdio', envNames: [], secretNames: ['MATTERMOST_TOKEN'], commandLine: 'npx -y @donach/mattermost-mcp', sourcePath: '/Users/prova/.cursor/mcp.json' },
  { source: 'cursor', name: 'ufficio', transport: 'http', envNames: [], secretNames: [], url: 'https://ufficio.example/mcp', sourcePath: '/Users/prova/.cursor/mcp.json' },
  { source: 'zcode', name: 'mattermost', transport: 'stdio', envNames: [], secretNames: ['MATTERMOST_TOKEN'], commandLine: 'npx -y @donach/mattermost-mcp', sourcePath: '/Users/prova/.zcode/cli/config.json' },
  { source: 'zcode', name: 'orion-moon', transport: 'http', envNames: [], secretNames: ['Authorization', 'X-Key'], url: 'https://orion-moon.pinkfloyd.competitoor.com/mcp', sourcePath: '/Users/prova/.zcode/cli/config.json' },
  { source: 'claude', name: 'filesystem', transport: 'stdio', envNames: [], secretNames: [], commandLine: 'npx -y @modelcontextprotocol/server-filesystem /tmp', sourcePath: '/Users/prova/Library/Application Support/Claude/claude_desktop_config.json' }
]

const html = () => renderHtml(createElement(ImportList, {
  groups: groupImportRows(rows, ['filesystem']),
  picks: { 'cursor:mattermost': true },
  onPicks: () => {},
  onImport: () => {},
  onCancel: () => {}
}))

describe('U2: il render dell\'elenco import — raggruppato per origine, curato', () => {
  it('intestazione per gruppo: nome dell\'app e percorso del file in piccolo grigio, gruppi nell\'ordine fisso', () => {
    const h = html()
    // l'ordine lo dicono i gruppi nel markup (il testo ripete «ZCode» in «anche in ZCode»)
    const iCursor = h.indexOf('data-testid="mcp-import-group-cursor"')
    const iClaude = h.indexOf('data-testid="mcp-import-group-claude"')
    const iZcode = h.indexOf('data-testid="mcp-import-group-zcode"')
    expect(iCursor).toBeGreaterThanOrEqual(0)
    expect(iClaude).toBeGreaterThan(iCursor)
    expect(iZcode).toBeGreaterThan(iClaude)
    const texts = findAll(parseHtml(h), () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('Cursor')
    expect(texts).toContain('Claude Desktop')
    expect(texts).toContain('ZCode')
    expect(texts).toContain('/Users/prova/.cursor/mcp.json')
    expect(texts).toContain('/Users/prova/Library/Application Support/Claude/claude_desktop_config.json')
  })

  it('il DOPPIONE ESATTO (mattermost in Cursor e ZCode) compare UNA volta, con «anche in ZCode»', () => {
    const h = html()
    const root = parseHtml(h)
    // UNA riga sola per nome (la riga, non le ripetizioni del testo annidato)
    const rowsWithMattermost = findAll(root, (n) => (n.attrs['data-testid'] ?? '') === 'mcp-import-row')
      .filter((n) => textOf(n).includes('mattermost'))
    expect(rowsWithMattermost).toHaveLength(1)
    expect(h).toContain('anche in ZCode')
    // il gruppo ZCode esiste lo stesso (per orion-moon), senza la sua materia
    const zcodeRows = findAll(root, (n) => (n.attrs['data-testid'] ?? '') === 'mcp-import-row' && textOf(n).includes('orion-moon'))
    expect(zcodeRows).toHaveLength(1)
  })

  it('le righe portano il COMANDO o l\'HOST come sottotitolo (npx … / orion-moon.pinkfloyd…)', () => {
    const texts = findAll(parseHtml(html()), () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('npx -y @donach/mattermost-mcp')
    expect(texts).toContain('orion-moon.pinkfloyd.competitoor.com')
  })

  it('i SEGRETI con l\'icona lucide e il CONTEGGIO al singolare e al plurale — NESSUNA emoji 🔒', () => {
    const h = html()
    expect(h).not.toContain('🔒')
    const texts = findAll(parseHtml(h), () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('1 segreto')
    expect(texts).toContain('2 segreti')
    // l'icona lucide c'è (svg con la classe dell'icona KeyRound — il nome finisce nel path)
    expect(h).toMatch(/lucide-key-round|KeyRound/)
  })

  it('già collegato: riga spenta con la casella DISATTIVATA', () => {
    const h = html()
    expect(h).toContain('già collegato')
    // la casella della riga filesystem è disabled
    const root = parseHtml(h)
    const boxes = findAll(root, (n) => n.tag === 'input')
    const fsBox = boxes.find((b) => (b.attrs['data-testid'] ?? '') === 'mcp-import-check' && b.attrs.disabled !== undefined)
    expect(fsBox).toBeTruthy()
  })

  it('in fondo: «N selezionati», «Annulla» e «Importa N» con N corretto (1)', () => {
    const texts = findAll(parseHtml(html()), () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('1 selezionato')
    expect(texts).toContain('Annulla')
    expect(texts).toContain('Importa 1')
  })
})

// la guardia sulle classi di spaziatura sta qui: leggere il sorgente
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const WIN_SRC = readFileSync(fileURLToPath(new URL('../components/McpWindow.tsx', import.meta.url)), 'utf8')
describe('U2: le classi di impaginazione dell\'elenco import (guardia sul sorgente)', () => {
  it('padding 16–20 nel riquadro (p-4), 12 px tra i gruppi (space-y-3 / gap-3), righe ~44 px (min-h-11)', () => {
    const start = WIN_SRC.indexOf('export function ImportList(')
    const block = WIN_SRC.slice(start, WIN_SRC.indexOf('\nfunction ', start + 10))
    expect(block).toMatch(/p-4/)            // 16 px nel riquadro
    expect(block).toMatch(/space-y-3|gap-3/) // 12 px tra i gruppi
    expect(block).toMatch(/min-h-11/)       // ~44 px la riga
    expect(block).toMatch(/space-y-2/)      // spazio tra le righe
  })
})
