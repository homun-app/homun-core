// Test del layout a tre colonne (fase 16b, correzioni 2 — Q1): la chat ha un
// minimo garantito (CHAT_MIN), il pannello cede prima della barra (docked
// stretto su Computer, poi overlay) e sotto AUTO_RAIL_BELOW la barra diventa
// rotaia da sola. La matrice riproduce le misure prese dal vivo in Electron
// (1440, 1280, 1200, 1100, 960, 900 × Profilo/Computer × barra 256/420).
import { describe, expect, it } from 'vitest'
import {
  layoutFor, sidebarMaxFor,
  CHAT_MIN, RAIL, PANEL, PANEL_WIDE, PANEL_WIDE_MIN, AUTO_RAIL_BELOW, SIDEBAR_MIN, SIDEBAR_MAX,
  type LayoutResult, type PanelTabId
} from '../layout'

const lay = (windowWidth: number, panelTab: PanelTabId, sidebarWidthPref: number, panelOpen = true): LayoutResult =>
  layoutFor({ windowWidth, sidebarCollapsedByUser: false, sidebarWidthPref, panelOpen, panelTab })

/** La larghezza della chat: tutto lo spazio meno le colonne docked. */
const chatOf = (r: LayoutResult, windowWidth: number): number =>
  windowWidth - r.sidebarWidth - (r.panel === 'docked' ? r.panelWidth : 0)

const WIDTHS = [1440, 1280, 1200, 1100, 960, 900] as const
const TABS: PanelTabId[] = ['profile', 'computer']
const PREFS = [256, 420] as const

describe('fase 16b correzioni 2 (Q1): invarianti su tutta la matrice delle misure', () => {
  for (const windowWidth of WIDTHS) {
    for (const panelTab of TABS) {
      for (const sidebarWidthPref of PREFS) {
        it(`${windowWidth} · ${panelTab} · barra ${sidebarWidthPref}`, () => {
          const r = lay(windowWidth, panelTab, sidebarWidthPref)
          // la chat resta sempre ≥ CHAT_MIN, oppure il pannello galleggia
          if (r.panel !== 'overlay') expect(chatOf(r, windowWidth)).toBeGreaterThanOrEqual(CHAT_MIN)
          else expect(chatOf(r, windowWidth)).toBe(windowWidth - r.sidebarWidth)
          // la somma delle colonne docked non supera mai la finestra
          expect(r.sidebarWidth + (r.panel === 'docked' ? r.panelWidth : 0)).toBeLessThanOrEqual(windowWidth)
          // sotto AUTO_RAIL_BELOW la barra è rotaia, sopra resta larga
          if (windowWidth < AUTO_RAIL_BELOW) expect(r.sidebar).toBe('rail')
          else expect(r.sidebar).toBe('full')
        })
      }
    }
  }
})

describe('Q1: la tabella delle misure prese dal vivo', () => {
  it("1440 · Computer · 256: com'era, tutto docked (chat 624)", () => {
    const r = lay(1440, 'computer', 256)
    expect(r).toEqual({ sidebar: 'full', sidebarWidth: 256, panel: 'docked', panelWidth: PANEL_WIDE })
    expect(chatOf(r, 1440)).toBe(624)
  })
  it('1280 · Computer · 256: il pannello si stringe a 504, la chat a 520', () => {
    const r = lay(1280, 'computer', 256)
    expect(r.panel).toBe('docked')
    expect(r.panelWidth).toBe(504)
    expect(chatOf(r, 1280)).toBe(CHAT_MIN)
  })
  it('1200 (avvio) · Computer · 256: docked 424, chat 520 — non più 384', () => {
    const r = lay(1200, 'computer', 256)
    expect(r).toEqual({ sidebar: 'full', sidebarWidth: 256, panel: 'docked', panelWidth: 424 })
    expect(chatOf(r, 1200)).toBe(CHAT_MIN)
  })
  it('1100 · Computer · 256: nemmeno PANEL_WIDE_MIN basta → overlay, chat larga tutto lo spazio', () => {
    const r = lay(1100, 'computer', 256)
    expect(r.panel).toBe('overlay')
    expect(r.panelWidth).toBe(Math.min(PANEL_WIDE, 1100 - 256 - 24))
    expect(chatOf(r, 1100)).toBe(1100 - 256)
  })
  it('960 · Computer · 256: barra in rotaia (sotto 1000) e pannello in overlay', () => {
    const r = lay(960, 'computer', 256)
    expect(r).toEqual({ sidebar: 'rail', sidebarWidth: RAIL, panel: 'overlay', panelWidth: PANEL_WIDE })
    expect(chatOf(r, 960)).toBe(960 - RAIL)
  })
  it('900 · Profilo · 256: rotaia + overlay 340 (chat 824)', () => {
    const r = lay(900, 'profile', 256)
    expect(r).toEqual({ sidebar: 'rail', sidebarWidth: RAIL, panel: 'overlay', panelWidth: PANEL })
  })
  it('1280 · Profilo · 420: docked 340 per un soffio (chat esattamente 520)', () => {
    const r = lay(1280, 'profile', 420)
    expect(r).toEqual({ sidebar: 'full', sidebarWidth: 420, panel: 'docked', panelWidth: PANEL })
    expect(chatOf(r, 1280)).toBe(CHAT_MIN)
  })
  it('1200 · Profilo · 420: overlay 340, la chat resta larga 780', () => {
    const r = lay(1200, 'profile', 420)
    expect(r).toEqual({ sidebar: 'full', sidebarWidth: 420, panel: 'overlay', panelWidth: PANEL })
    expect(chatOf(r, 1200)).toBe(780)
  })
  it('1440 · Computer · 420: il pannello si stringe a 500, la chat a 520', () => {
    const r = lay(1440, 'computer', 420)
    expect(r.panel).toBe('docked')
    expect(r.panelWidth).toBe(500)
    expect(chatOf(r, 1440)).toBe(CHAT_MIN)
  })
  it('1280 · Computer · 420: sotto PANEL_WIDE_MIN non si va → overlay', () => {
    const r = lay(1280, 'computer', 420)
    expect(r.panel).toBe('overlay')
    expect(r.panelWidth).toBe(PANEL_WIDE)
  })
  it('il pannello docked non scende mai sotto PANEL_WIDE_MIN', () => {
    for (const w of WIDTHS) {
      for (const pref of PREFS) {
        const r = lay(w, 'computer', pref)
        if (r.panel === 'docked') expect(r.panelWidth).toBeGreaterThanOrEqual(PANEL_WIDE_MIN)
      }
    }
  })
})

describe('Q1 regola 1: la rotaia automatica non tocca la preferenza', () => {
  it("sotto 1000 la barra è rotaia anche se l'utente non l'ha chiusa", () => {
    expect(lay(999, 'profile', 256).sidebar).toBe('rail')
    expect(lay(999, 'profile', 256).sidebarWidth).toBe(RAIL)
  })
  it("a 1000 e sopra la barra torna full con la preferenza dell'utente", () => {
    expect(lay(1000, 'profile', 256).sidebar).toBe('full')
    expect(lay(1000, 'profile', 256).sidebarWidth).toBe(256)
    expect(lay(1440, 'profile', 420).sidebarWidth).toBe(420)
  })
  it("la rotaia CHIESTA dall'utente vale anche a finestra larga", () => {
    const r = layoutFor({ windowWidth: 1440, sidebarCollapsedByUser: true, sidebarWidthPref: 256, panelOpen: true, panelTab: 'profile' })
    expect(r).toEqual({ sidebar: 'rail', sidebarWidth: RAIL, panel: 'docked', panelWidth: PANEL })
  })
  it("la preferenza passa intatta (funzione pura: l'input non cambia)", () => {
    const input = { windowWidth: 960, sidebarCollapsedByUser: false, sidebarWidthPref: 420, panelOpen: true, panelTab: 'computer' as PanelTabId }
    layoutFor(input)
    expect(input).toEqual({ windowWidth: 960, sidebarCollapsedByUser: false, sidebarWidthPref: 420, panelOpen: true, panelTab: 'computer' })
  })
})

describe('Q1 regola 2: pannello chiuso e squadre', () => {
  it('pannello chiuso → hidden, la chat prende tutto lo spazio', () => {
    const r = lay(1280, 'profile', 256, false)
    expect(r).toEqual({ sidebar: 'full', sidebarWidth: 256, panel: 'hidden', panelWidth: 0 })
    expect(chatOf(r, 1280)).toBe(1280 - 256)
  })
  it('la scheda della squadra non è wide: pannello 340 come il Profilo', () => {
    const r = lay(1280, 'members', 256)
    expect(r.panelWidth).toBe(PANEL)
    expect(r.panel).toBe('docked')
  })
  it('overlay mai più largo di finestra − barra − 24', () => {
    const r = lay(1100, 'computer', 420)
    expect(r.panel).toBe('overlay')
    expect(r.panelWidth).toBe(Math.min(PANEL_WIDE, 1100 - 420 - 24))
  })
})

describe('Q1 regola 3: il massimo del trascinamento della barra', () => {
  it('finestra larga: resta 420', () => {
    expect(sidebarMaxFor(1440, true, 'profile')).toBe(SIDEBAR_MAX)
    expect(sidebarMaxFor(1440, false, 'profile')).toBe(SIDEBAR_MAX)
  })
  it('il pannello Computer docked si prende il suo minimo: 1200 → 260', () => {
    expect(sidebarMaxFor(1200, true, 'computer')).toBe(1200 - CHAT_MIN - PANEL_WIDE_MIN)
  })
  it('pannello normale docked: 1280 → 420 (340 + 520 + 420 = 1280)', () => {
    expect(sidebarMaxFor(1280, true, 'profile')).toBe(SIDEBAR_MAX)
  })
  it('se il pannello galleggia comunque, vale solo barra + CHAT_MIN', () => {
    // 1100 · Computer: 1100 − 220 − 420 = 460 < 520 → overlay anche al minimo
    expect(sidebarMaxFor(1100, true, 'computer')).toBe(SIDEBAR_MAX)
  })
  it('al minimo della finestra (900) la barra non può rubare spazio alla chat', () => {
    expect(sidebarMaxFor(900, true, 'profile')).toBe(900 - CHAT_MIN)
    expect(sidebarMaxFor(900, false, 'profile')).toBe(900 - CHAT_MIN)
  })
  it('non scende mai sotto SIDEBAR_MIN', () => {
    expect(sidebarMaxFor(1000, true, 'computer')).toBeGreaterThanOrEqual(SIDEBAR_MIN)
  })
  it('trascinando fino al massimo, barra + docked + CHAT_MIN non superano la finestra', () => {
    for (const w of WIDTHS) {
      for (const tab of TABS) {
        const max = sidebarMaxFor(w, true, tab)
        const r = layoutFor({ windowWidth: w, sidebarCollapsedByUser: false, sidebarWidthPref: max, panelOpen: true, panelTab: tab })
        expect(r.sidebarWidth + (r.panel === 'docked' ? r.panelWidth : 0) + CHAT_MIN).toBeLessThanOrEqual(w)
      }
    }
  })
})
