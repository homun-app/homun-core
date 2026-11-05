// Fase skill · Sfoglia (B1): «Skill» sta nel MENU DELL'ACCOUNT in fondo alla
// barra (quello con Collega app, Impostazioni e Tema), subito sotto «Collega
// app» — e NON è più un bottone nella barra accanto ad App, né nella rotaia
// stretta. Il collegamento del pannello del bot (RightPanel) e la riga della
// finestra App RESTANO. Senza DOM (niente jsdom): si legge il sorgente, come
// le altre guardie del renderer.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SIDEBAR = fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url))

/** Il blocco DropdownMenuContent dell'AccountMenu (il menu in fondo). */
function accountMenuContent(): string {
  const src = readFileSync(SIDEBAR, 'utf8')
  const m = /function AccountMenu\([\s\S]*?<DropdownMenuContent([^>]*)>([\s\S]*?)<\/DropdownMenuContent>/.exec(src)
  if (!m) throw new Error('AccountMenu non trovata in Sidebar.tsx')
  return m[2]!
}

describe("B1: «Skill» nel menu in fondo, non più nella barra", () => {
  it('«Skill» sta nel menu subito sotto «Collega app» e prima di «Impostazioni»', () => {
    const menu = accountMenuContent()
    const at = menu.indexOf('<Trans>Collega app</Trans>')
    const skill = menu.indexOf('<Trans>Skill</Trans>')
    const settings = menu.indexOf('<Trans>Impostazioni</Trans>')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(skill).toBeGreaterThan(at)
    if (settings >= 0) expect(skill).toBeLessThan(settings)
  })

  it('la voce del menu apre la finestra Skill (setSkillsOpen) ed è cliccabile dalle sonde', () => {
    const menu = accountMenuContent()
    const item = /<DropdownMenuItem[^>]*onClick=\{\(\) => setSkillsOpen\(true\)\}[^>]*>/.exec(menu)
    expect(item).not.toBeNull()
    expect(item![0]).toContain('data-testid="menu-skills"')
  })

  it("nella barra (larga e rotaia) non c'è più il bottone Skill", () => {
    const src = readFileSync(SIDEBAR, 'utf8')
    // il testid dei bottoni rimossi (barra larga e rotaia lo condividevano)
    expect(src).not.toContain('sidebar-skills')
    // e non resta nessun <Sparkles /> fuori dal menu: l'icona del bottone
    expect(src).not.toMatch(/<Sparkles\b/)
  })

  it('il menu in fondo è UNO solo: la rotaia usa lo stesso AccountMenu (la voce vale per entrambe)', () => {
    const src = readFileSync(SIDEBAR, 'utf8')
    expect((src.match(/function AccountMenu\(/g) ?? []).length).toBe(1)
    // la rotaia pende dal bottone in fondo, che è l'AccountMenu con props rail
    expect(src).toMatch(/<AccountMenu\s+rail=/)
  })
})
