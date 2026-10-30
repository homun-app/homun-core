// Fase 17c (C1/C3): la lingua dell'interfaccia per i testi del daemon/main —
// il setting 'ui.activeLanguage' che il main dell'app pubblica a ogni cambio
// (applyStartupLanguage / publishActiveLanguage, fase 17b A2). Se non è
// valido vale 'en', come resolveUiLanguage. Qui vive anche l'helper degli
// errori RPC: il testo si risolve SUBITO nella lingua dell'interfaccia.
import { getSetting } from './store/db'
import { formatUi, ui } from '../shared/ui-text'
import { UI } from '../shared/ui-messages'
import type { UiText } from '../shared/types'
import type { UiLanguage } from '../shared/ui-language'
import type { UiMessageDescriptor } from '../shared/ui-text'

/** La lingua attiva dell'interfaccia (ui.activeLanguage se valido, altrimenti 'en'). */
export function uiLanguage(): UiLanguage {
  const v = getSetting<unknown>('ui.activeLanguage', null)
  return v === 'it' || v === 'en' ? v : 'en'
}

/**
 * Fase 17c (C3): un messaggio del catalogo UI già formato nella lingua
 * dell'interfaccia (per i testi risolti subito: notifiche, pagine OAuth,
 * errori RPC solo-UI).
 */
export function uiText(m: UiMessageDescriptor, values?: Record<string, string | number>): string {
  return formatUi(ui(m, values), uiLanguage())
}

/**
 * Fase 17c (C3): l'errore RPC per la UI — il messaggio è già nella lingua
 * dell'interfaccia. Per gli errori che raggiungono ANCHE il modello come
 * result di un tool si usa invece UiError (testo inglese + UiText) da
 * src/shared/ui-text.ts.
 */
export function uiError(m: UiMessageDescriptor, values?: Record<string, string | number>): Error {
  return new Error(formatUi(ui(m, values), uiLanguage()))
}

/** Il UiText di un messaggio del catalogo (per meta.ui), qui per comodità di import. */
export { ui, formatUi, UI }
export type { UiText, UiMessageDescriptor }
