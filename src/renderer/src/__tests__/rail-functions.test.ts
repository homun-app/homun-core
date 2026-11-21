// Fase 16c correzioni (R7): sotto i 1000 px la rotaia deve restare USABILE —
// Crea (stesso menu), Cerca e il menu ACCOUNT (Impostazioni e tema) non
// spariscono. I test di vitest girano in node (niente DOM): il percorso
// interattivo si verifica con una GUARDA SUL CODICE (come daemon-text-guard)
// più la parte PURA (layoutFor: a 900 px la rotaia è FORZATA). La verifica
// dal vivo con la sonda Electron resta quella del REPORT.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { layoutFor, AUTO_RAIL_BELOW } from '../layout'

const SIDEBAR = readFileSync(fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url)), 'utf8')
const APP = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8')

describe('R7 — sotto AUTO_RAIL_BELOW la rotaia è forzata (parte pura)', () => {
  it('a 900 px la barra è rotaia anche con la preferenza APERTA', () => {
    const r = layoutFor({ windowWidth: 900, sidebarCollapsedByUser: false, sidebarWidthPref: 300, panelOpen: false, panelTab: null })
    expect(r.sidebar).toBe('rail')
    expect(AUTO_RAIL_BELOW).toBe(1000)
  })
})

describe('R7 — la rotaia ha Crea, Cerca e menu account (guarda sul codice)', () => {
  it('B2 (fase beta.4): il bottone «+» della rotaia apre SUBITO il dialogo «Nuovo» (niente menu bot/squadra)', () => {
    // dentro CollapsedColumn: il + apre il dialogo direttamente, come la barra larga
    const collapsed = SIDEBAR.slice(
      SIDEBAR.indexOf('function CollapsedColumn'),
      SIDEBAR.indexOf('export function Sidebar({ layout')
    )
    expect(collapsed).toContain('aria-label={i18n.t(msg`Crea`)}')
    expect(collapsed).toContain('onClick={onNewBot}')
    expect(collapsed).not.toContain('DropdownMenuItem')
    expect(collapsed).not.toContain('Nuova squadra')
  })

  it('la lente di Cerca c\'è, e la ricerca sospesa vive nella Sidebar (fuori dalla rotaia)', () => {
    const collapsed = SIDEBAR.slice(
      SIDEBAR.indexOf('function CollapsedColumn'),
      SIDEBAR.indexOf('export function Sidebar({ layout')
    )
    expect(collapsed).toContain('aria-label={i18n.t(msg`Cerca`)}')
    // l'input sospeso è nel render della Sidebar, non dentro la colonna
    expect(SIDEBAR).toContain("{collapsed && searchOpen && (")
    expect(SIDEBAR).toContain('placeholder={t`Cerca bot e team`}')
  })

  it('il bottone in fondo apre il menu ACCOUNT; U2: la voce che allargava la barra è USCITA dal menu', () => {
    expect(SIDEBAR).toContain('<AccountMenu')
    // allargare ha il suo bottone fisso accanto ai semafori (SidebarToggleButton),
    // la voce del menu non esiste più in nessuno stato
    expect(SIDEBAR).not.toContain('Allarga la barra')
    expect(SIDEBAR).toContain('export function SidebarToggleButton')
    expect(APP).toContain('<SidebarToggleButton layout={layout} />')
  })

  it('la finestra «Nuovo» si apre ANCHE in rotaia (render fuori dal ramo); la squadra non nasce più da un dialogo', () => {
    // il dialogo è nel render della Sidebar, dopo il ternary collapsed
    const tail = SIDEBAR.slice(SIDEBAR.indexOf('export function Sidebar({ layout'))
    expect(tail).toContain('{newBotOpen && <NewBotDialog')
    expect(tail).not.toContain('NewTeamDialog')
  })

  it('⌘, apre le Impostazioni (standard macOS; nessun menu Electron: scorciatoia nel renderer)', () => {
    expect(APP).toContain("e.metaKey && e.key === ','")
    expect(APP).toContain('setSettingsOpen(true)')
  })
})
