// Fase 17a (L2): la lingua dell'interfaccia si sceglie col setting
// 'ui.language' ('system' | 'it' | 'en', predefinito 'system'). Funzione
// pura, senza DOM né Electron: la usano il renderer (navigator.languages)
// e il main (app.getPreferredSystemLanguages()).

/** Il setting 'ui.language' come salvato nelle impostazioni. */
export type UiLanguageSetting = 'system' | 'it' | 'en'

/** La lingua attiva dell'interfaccia (l'italiano è la lingua sorgente). */
export type UiLanguage = 'it' | 'en'

/**
 * Risolve la lingua attiva: un setting esplicito vince; con 'system' la
 * prima lingua di sistema che inizia con 'it' dà 'it', quella che inizia
 * con 'en' dà 'en' (le altre si saltano); se non c'è nessuna delle due,
 * 'en' (lingua internazionale). Un setting sconosciuto vale 'system'.
 */
export function resolveUiLanguage(
  setting: string | null | undefined,
  systemLanguages: readonly string[]
): UiLanguage {
  if (setting === 'it' || setting === 'en') return setting
  for (const lang of systemLanguages) {
    if (typeof lang !== 'string') continue
    if (lang.toLowerCase().startsWith('it')) return 'it'
    if (lang.toLowerCase().startsWith('en')) return 'en'
  }
  return 'en'
}

/**
 * Fase 17a (K1): la lingua del main ALL'AVVIO — il setting 'ui.language'
 * appena letto dal daemon più le lingue preferite di sistema. Un setting
 * esplicito vince (tray compreso, anche con la finestra chiusa); 'system',
 * un setting non stringa o una lettura fallita (null) lasciano decidere le
 * lingue di sistema. Pura, senza Electron: il main la chiama appena il
 * client del daemon è pronto.
 */
export function startupMainLanguage(
  setting: string | null | undefined,
  systemLanguages: readonly string[]
): UiLanguage {
  return resolveUiLanguage(typeof setting === 'string' ? setting : null, systemLanguages)
}
