// Fase 17a (L2): il runtime i18n del renderer, sul modello di Rakazo.
// Il catalogo della lingua si carica con import() dinamico (nessuna rete:
// sta nel bundle); activateUiLanguage fa load+activate e imposta
// document.documentElement.lang. Se due attivazioni si sovrappongono vince
// l'ultima (contatore di generazione); se un catalogo non si carica si
// ripiega su 'it'. Date e numeri passano dalla lingua attiva.
import { i18n } from '@lingui/core'
import type { Messages } from '@lingui/core'
import type { UiLanguage } from '../../../shared/ui-language'

/** Le generazioni crescono a ogni attivazione: vince l'ultima chiamata. */
let generation = 0

async function loadCatalog(lang: UiLanguage): Promise<Messages> {
  const { messages } = await import(`../locales/${lang}/messages.po`)
  return messages
}

/** Carica e attiva il catalogo della lingua dell'interfaccia. */
export async function activateUiLanguage(lang: UiLanguage): Promise<void> {
  const gen = ++generation
  let target = lang
  let messages: Messages
  try {
    messages = await loadCatalog(lang)
  } catch {
    // catalogo non caricabile (bundle incompleto): ripiego sulla lingua sorgente
    target = 'it'
    try {
      messages = await loadCatalog(target)
    } catch {
      messages = {}
    }
  }
  // un'altra attivazione è partita dopo di noi: la sua lingua vince
  if (gen !== generation) return
  i18n.load(target, messages)
  i18n.activate(target)
  if (typeof document !== 'undefined') document.documentElement.lang = target
}

/** Il locale Intl della lingua attiva (le date di oggi usano 'it-IT'). */
export function activeLocale(): string {
  return i18n.locale === 'en' ? 'en-GB' : 'it-IT'
}

/**
 * Data/ora nel formato della lingua attiva. Senza opzioni è equivalente a
 * toLocaleString('it-IT') di prima (identico in italiano).
 */
export function formatDate(at: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(activeLocale(), options).format(at)
}

/** Ora (default HH:MM) nel formato della lingua attiva. */
export function formatTime(
  at: number | Date,
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
): string {
  return new Intl.DateTimeFormat(activeLocale(), options).format(at)
}

/** Numero nel formato della lingua attiva. */
export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(activeLocale(), options).format(n)
}

export { i18n }
