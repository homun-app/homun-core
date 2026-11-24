// T4 (fase web-strategia): i menu a tendina dei campi di ricerca (combobox)
// — browser_type su un elemento combobox NON fa submit: scrive, aspetta che
// compaiano le opzioni della listbox (≤ 3 s) e le include nello snapshot del
// result, così il modello sceglie con browser_click sull'opzione. Dal caso
// vero: il campo «From» di Trainline col submit che non sceglieva niente e
// il clic dopo in timeout. Server MCP browser FINTO (nessuna rete).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { TEST_TMP_BASE } from '../../../test-tmp'
import { join, resolve } from 'node:path'

const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-t4-combo-'))
const { setDataDir } = await import('../../store/db')
setDataDir(TMP)

// il server MCP finto del repo, con la pagina treni (combobox «From»)
process.env.SANDBOT_TEST_FAKE_BROWSER_MCP = resolve('scripts/fake-browser-mcp.mjs')

const { callBrowserTool, resetBrowserForTests, comboboxOptionsOf, COMBOBOX_CHOOSE_LINE } = await import('../browser')

const AGENT = 'agent_t4'

beforeAll(async () => {
  await resetBrowserForTests()
})
afterAll(async () => {
  await resetBrowserForTests()
  delete process.env.SANDBOT_TEST_FAKE_BROWSER_MCP
  rmSync(TMP, { recursive: true, force: true })
})

describe('T4: comboboxOptionsOf (puro) — le opzioni della listbox nello snapshot', () => {
  it('estrae le righe option CON i ref (il modello ci clicca sopra)', () => {
    const snap = [
      '- Page URL: https://spa.example/treni',
      '- combobox "From" [ref=e4]: Milano',
      '- listbox "Stazioni" [ref=e9]',
      '  - option "Milano Centrale" [ref=e10]',
      '  - option "Milano Porta Garibaldi" [ref=e11]',
      '  - option "Milano Lambrate" [ref=e12]',
      '- button "Cerca treni" [ref=e8]'
    ].join('\n')
    const opts = comboboxOptionsOf(snap)
    expect(opts).toHaveLength(3)
    expect(opts[0]).toContain('option "Milano Centrale"')
    expect(opts[0]).toContain('[ref=e10]')
    expect(opts.join('\n')).toContain('Porta Garibaldi')
  })

  it('senza listbox/option → vuoto', () => {
    expect(comboboxOptionsOf('- textbox "Nome" [ref=e4]\n- button "Ok" [ref=e5]')).toEqual([])
    expect(comboboxOptionsOf('')).toEqual([])
    expect(comboboxOptionsOf(null as unknown as string)).toEqual([])
  })
})

describe('T4: browser_type su una combobox — niente submit, le opzioni nel result', () => {
  it('scrive, ASPETTA la listbox (≤ 3 s), include le opzioni e dice di sceglierne una col click', async () => {
    await callBrowserTool(AGENT, 'browser_open', { url: 'https://spa.example/treni' })
    const r = await callBrowserTool(AGENT, 'browser_type', { ref: 'e4', text: 'Milano', submit: true })
    // il testo scritto resta nel campo
    expect(r.output).toContain('Milano')
    // le OPZIONI compaiono nel result, coi ref per il click (il finto le mostra
    // solo al SECONDO snapshot: il daemon le ha ASPETTATE)
    expect(r.output).toContain('option "Milano Centrale"')
    expect(r.output).toContain('[ref=e10]')
    expect(r.output).toContain('option "Milano Porta Garibaldi"')
    // la riga che dice la mossa giusta
    expect(r.output).toContain(COMBOBOX_CHOOSE_LINE)
    // NESSUN submit: la pagina della ricerca inviata non esiste
    expect(r.output).not.toContain('Ricerca inviata')
    expect(r.output).not.toContain('inviato')
  })

  it('su un campo di TESTO normale il submit di oggi resta (la combobox è l\'unica eccezione)', async () => {
    await callBrowserTool(AGENT, 'browser_open', { url: 'https://spa.example/prenota' })
    // dalla SECONDA navigazione i ref del finto prendono il prefisso f1
    const r = await callBrowserTool(AGENT, 'browser_type', { ref: 'f1e4', text: 'Fabio', submit: true })
    expect(r.output).toContain('Fabio')
    // nessuna attesa di listbox su un textbox: la riga della combobox non c'è
    expect(r.output).not.toContain(COMBOBOX_CHOOSE_LINE)
  })
})
