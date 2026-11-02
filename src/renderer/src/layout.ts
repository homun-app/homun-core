// Fase 16b — correzioni 2 (Q1): il layout a tre colonne come FUNZIONE PURA.
// Lo schema delle app desktop (Slack, Linear, Claude desktop): la colonna
// centrale non scende mai sotto CHAT_MIN; prima cede il pannello (si stringe
// sulla scheda Computer fino a PANEL_WIDE_MIN, poi galleggia in overlay sopra
// la chat), poi la barra (sotto AUTO_RAIL_BELOW diventa rotaia da sola, senza
// sovrascrivere la preferenza dell'utente). App, Sidebar e RightPanel leggono
// il risultato di layoutFor: nessuno si calcola la propria larghezza.
export const CHAT_MIN = 520
export const RAIL = 76
export const PANEL = 340
export const PANEL_WIDE = 560
export const PANEL_WIDE_MIN = 420
export const AUTO_RAIL_BELOW = 1000
/** Limiti del trascinamento della barra (come oggi: 220–420). */
export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 420

/** La scheda del pannello destro: larga solo «computer»; «members» = squadra. */
export type PanelTabId = 'profile' | 'computer' | 'routines' | 'advanced' | 'members'

export interface LayoutInput {
  windowWidth: number
  /** l'utente ha chiuso la barra (⌘\ o trascinamento sotto i 200 px) */
  sidebarCollapsedByUser: boolean
  /** la larghezza scelta trascinando il bordo (220–420) */
  sidebarWidthPref: number
  panelOpen: boolean
  panelTab: PanelTabId | null
}

export interface LayoutResult {
  sidebar: 'full' | 'rail'
  sidebarWidth: number
  panel: 'docked' | 'overlay' | 'hidden'
  panelWidth: number
}

/**
 * Le regole, in ordine. 1) Barra: rotaia se l'utente l'ha chiusa o se la
 * finestra scende sotto AUTO_RAIL_BELOW (la preferenza NON si tocca: ri-
 * allargando la finestra la barra torna com'era). 2) Pannello: largo quanto
 * vuole se la chat resta ≥ CHAT_MIN; sulla scheda Computer prova a stringerlo
 * fino a PANEL_WIDE_MIN; altrimenti overlay (galleggia sopra la chat, largo
 * min(voluta, finestra − barra − 24), non spinge la chat). Per costruzione
 * barra + pannello docked + CHAT_MIN non superano mai la finestra.
 */
export function layoutFor({ windowWidth, sidebarCollapsedByUser, sidebarWidthPref, panelOpen, panelTab }: LayoutInput): LayoutResult {
  const rail = sidebarCollapsedByUser || windowWidth < AUTO_RAIL_BELOW
  const sidebarWidth = rail ? RAIL : Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, sidebarWidthPref))
  const sidebar: LayoutResult['sidebar'] = rail ? 'rail' : 'full'
  if (!panelOpen) return { sidebar, sidebarWidth, panel: 'hidden', panelWidth: 0 }
  const wanted = panelTab === 'computer' ? PANEL_WIDE : PANEL
  if (windowWidth - sidebarWidth - wanted >= CHAT_MIN) {
    return { sidebar, sidebarWidth, panel: 'docked', panelWidth: wanted }
  }
  if (panelTab === 'computer' && windowWidth - sidebarWidth - PANEL_WIDE_MIN >= CHAT_MIN) {
    return { sidebar, sidebarWidth, panel: 'docked', panelWidth: windowWidth - sidebarWidth - CHAT_MIN }
  }
  return { sidebar, sidebarWidth, panel: 'overlay', panelWidth: Math.max(0, Math.min(wanted, windowWidth - sidebarWidth - 24)) }
}

/**
 * Q1 regola 3: il massimo a cui l'utente può trascinare la barra, perché non
 * succeda MAI che barra + pannello docked + CHAT_MIN superino la finestra. Il
 * pannello docked conta per il minimo a cui può stringersi restando al fianco
 * della chat (PANEL_WIDE_MIN su Computer, PANEL altrove); se non può stare
 * docked nemmeno con la barra al minimo, galleggia e vale solo barra + CHAT_MIN.
 */
export function sidebarMaxFor(windowWidth: number, panelOpen: boolean, panelTab: PanelTabId | null): number {
  const dockedMin = !panelOpen ? 0 : panelTab === 'computer' ? PANEL_WIDE_MIN : PANEL
  const canDock = windowWidth - SIDEBAR_MIN - dockedMin >= CHAT_MIN
  const cap = windowWidth - CHAT_MIN - (canDock ? dockedMin : 0)
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, cap))
}
