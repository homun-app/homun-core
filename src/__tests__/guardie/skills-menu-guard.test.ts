// Fase skill · Sfoglia (B1): «Skill» sta nel MENU DELL'ACCOUNT in fondo alla
// barra (quello con Collega app, Impostazioni e Tema), subito sotto «Collega
// app» — e NON è più un bottone nella barra accanto ad App, né nella rotaia
// stretta. Il collegamento del pannello del bot (RightPanel) e la riga della
// finestra App RESTANO. Senza DOM (niente jsdom): si legge il sorgente, come
// le altre guardie del renderer.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SIDEBAR = fileURLToPath(new URL('../../renderer/src/components/Sidebar.tsx', import.meta.url))

/** Il blocco DropdownMenuContent dell'AccountMenu (il menu in fondo). */
function accountMenuContent(): string {
  const src = readFileSync(SIDEBAR, 'utf8')
  const m = /function AccountMenu\([\s\S]*?<DropdownMenuContent([^>]*)>([\s\S]*?)<\/DropdownMenuContent>/.exec(src)
  if (!m) throw new Error('AccountMenu non trovata in Sidebar.tsx')
  return m[2]!
}

describe("B1 → PL1: «Skill» non sta più nel menu: la casa è la pagina Plugin", () => {
  it('il menu dell\'account non ha più «Skill» (né «Collega app»): aprono la pagina Plugin', () => {
    const menu = accountMenuContent()
    expect(menu).not.toContain('<Trans>Skill</Trans>')
    expect(menu).not.toContain('<Trans>Collega app</Trans>')
    expect(menu).not.toContain('data-testid="menu-skills"')
    expect(menu).not.toContain('setSkillsOpen')
  })

  it('la pagina Plugin ha il segmento Skill e riusa l\'editor delle skill (plugin/)', () => {
    const panel = readFileSync(fileURLToPath(new URL('../../renderer/src/components/PluginPanel.tsx', import.meta.url)), 'utf8')
    expect(panel).toMatch(/seg === 'skills'/)
    expect(panel).toMatch(/import \{ SkillEditor \} from '\.\/plugin\/skill-editor'/)
    // il rimando del pannello del bot filtra sul bot (skillsFilterAgent)
    const right = readFileSync(fileURLToPath(new URL('../../renderer/src/components/RightPanel.tsx', import.meta.url)), 'utf8')
    expect(right).toMatch(/setSkillsFilterAgent\(activeId\); openPlugin\(\{ kind: 'segment', seg: 'skills'/)
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
    expect(src).toMatch(/<AccountMenu\s+rail\b/)
  })
})
