// U1 (fase mcp-ui): le azioni per riga nella finestra «Server MCP» diventano
// BOTTONI ICONA lucide (test → PlugZap, modifica → Pencil, elimina → Trash2),
// grigi (elimina rosso al passaggio), con aria-label e title tradotti e
// NESSUN testo visibile. Fase design (DS4): sono Button ghost solo-icona —
// tondi, 32 px, la misura dei controlli piccoli (prima 28×28 con un raggio
// loro, scritti qui: la misura e il colore ora li dà la variante di Button).
// Il risultato del test è un PALLINO
// nella riga (verde «connesso»/rosso «errore») col messaggio nel suggerimento:
// niente testo che allarga la riga. Stessa regola nel resto della finestra:
// l'azione ripetuta per riga (togliere una variabile) è un'icona col suo
// suggerimento. Guardie sul sorgente; i nomi dei server e i clic li prova la
// sonda sul DOM vero.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WIN_SRC = readFileSync(fileURLToPath(new URL('../components/plugin/manual-servers.tsx', import.meta.url)), 'utf8')

/** Il blocco di ManualServers (l'elenco dei server col form), non il resto del file. */
function manualServersBlock(): string {
  const start = WIN_SRC.indexOf('function ManualServers(')
  if (start < 0) throw new Error('ManualServers non trovata')
  return WIN_SRC.slice(start, WIN_SRC.indexOf('\nfunction ', start + 10) > 0 ? WIN_SRC.indexOf('\nfunction ', start + 10) : undefined)
}

describe('U1: le azioni della riga di un server sono BOTTONI ICONA lucide', () => {
  it('PlugZap per il test, Pencil per modifica, Trash2 per elimina (lucide-react, già nelle dipendenze)', () => {
    expect(WIN_SRC).toMatch(/import \{[^}]*PlugZap[^}]*\} from 'lucide-react'/)
    expect(WIN_SRC).toMatch(/import \{[^}]*(Pencil|Trash2)[^}]*\} from 'lucide-react'/)
    const block = manualServersBlock()
    expect(block).toMatch(/<PlugZap/)
    expect(block).toMatch(/<Pencil/)
    expect(block).toMatch(/<Trash2/)
  })

  it('la riga NON contiene le parole visibili «test», «modifica», «elimina»', () => {
    const block = manualServersBlock()
    expect(block).not.toContain('<Trans>test</Trans>')
    expect(block).not.toContain('<Trans>modifica</Trans>')
    expect(block).not.toContain('<Trans>elimina</Trans>')
    expect(block).not.toMatch(/>\s*test\s*</)
    expect(block).not.toMatch(/>\s*modifica\s*</)
    expect(block).not.toMatch(/>\s*elimina\s*</)
  })

  it('i bottoni icona hanno aria-label E title tradotti e sono Button ghost solo-icona (32 px, tondi, grigi: misura e colore della variante); elimina rosso al passaggio', () => {
    const btn = WIN_SRC.slice(WIN_SRC.indexOf('function IconButton('), WIN_SRC.indexOf('\nfunction ', WIN_SRC.indexOf('function IconButton(')))
    expect(btn).not.toBe('')
    expect(btn).toMatch(/aria-label=\{label\}/)
    expect(btn).toMatch(/title=\{label\}/)
    // fase design (DS4): più niente misure scritte qui (size-7, rounded-lg, text-muted-foreground) —
    // le dà Button: ghost (grigio), sm (32 px), icon (quadrato; per il ghost tondo)
    expect(btn).toMatch(/<Button\b/)
    expect(btn).toMatch(/variant="ghost"/)
    expect(btn).toMatch(/size="sm"/)
    expect(btn).toMatch(/\bicon\b/)
    expect(btn).not.toMatch(/className="[^"]*(size-7|rounded-(?!control))/)
    expect(btn).toMatch(/hover:text-destructive/)
    // i TRE bottoni della riga passano l'etichetta tradotta (t`…`)
    const block = manualServersBlock()
    expect((block.match(/<IconButton/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(block).toMatch(/<IconButton label=\{t`/)
  })

  it('il risultato del test è un PALLINO nella riga, col messaggio nel SUGGERIMENTO (niente righe di testo che allargano)', () => {
    const block = manualServersBlock()
    // il testo di oggi («✓ N tool: …» / «✕ errore») sparisce
    expect(block).not.toMatch(/✓/)
    expect(block).not.toMatch(/✕ \$\{/)
    // il pallino: RowTestStatus sta nel file (verde/rosso/in corso, title col messaggio)
    const status = WIN_SRC.slice(WIN_SRC.indexOf('function RowTestStatus('), WIN_SRC.indexOf('\nfunction ', WIN_SRC.indexOf('function RowTestStatus(')))
    expect(status).not.toBe('')
    expect(status).toMatch(/rounded-full/)
    expect(status).toMatch(/bg-chart-2/)
    expect(status).toMatch(/bg-destructive/)
    expect(status).toMatch(/title=\{tip\}/)
    expect(status).toMatch(/data-testid="mcp-row-status"/)
    // nella riga: il pallino al posto del vecchio blocco di testo sotto la riga
    expect(block).toMatch(/<RowTestStatus/)
    expect(block).not.toMatch(/mt-2 text-xs/)
  })

  it('stessa regola nel resto della finestra: togliere una variabile è un\'ICONA (X di lucide) col suggerimento, non un glifo ✕', () => {
    const block = manualServersBlock()
    expect(block).toMatch(/<X\b/)
    expect(block).not.toContain('>\n                        ✕\n                      </button>')
    expect(block).not.toMatch(/>\s*✕\s*<\/button>/)
  })
})
