// Fase 17a (L2): la lingua dell'interfaccia si sceglie col setting
// 'ui.language' ('system' | 'it' | 'en', predefinito 'system'). Funzione
// pura, senza DOM né Electron: la usano il renderer (navigator.languages)
// e il main (app.getPreferredSystemLanguages()).
//
// RV3 (fase beta.2): le lingue supportate vivono in UN SOLO posto —
// SUPPORTED_UI_LANGUAGES — e da lì derivano il tipo UiLanguage, la
// risoluzione di sistema e la select delle Impostazioni. Aggiungere una
// lingua deve voler dire una riga qui più il catalogo Lingui (it + en),
// niente altro. Gli ENDONIMI non si traducono: chi ha sbagliato lingua deve
// riconoscere la sua («Italiano», «English», non «Italian»).

/** L'elenco unico delle lingue dell'interfaccia: codice + endonimo. */
export const SUPPORTED_UI_LANGUAGES = [
  { code: 'it', endonym: 'Italiano' },
  { code: 'en', endonym: 'English' }
] as const

/** La lingua attiva dell'interfaccia (l'italiano è la lingua sorgente). */
export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number]['code']

/** Il setting 'ui.language' come salvato nelle impostazioni. */
export type UiLanguageSetting = 'system' | UiLanguage

/** La lingua internazionale quando il sistema non ne dice nessuna delle nostre. */
export const FALLBACK_UI_LANGUAGE: UiLanguage = 'en'

/** È un valore salvabile nel setting 'ui.language'? ('system' o un codice dell'elenco). */
export function isUiLanguageSetting(v: unknown): v is UiLanguageSetting {
  return v === 'system' || SUPPORTED_UI_LANGUAGES.some((l) => l.code === v)
}

/**
 * Risolve la lingua attiva: un setting esplicito vince; con 'system' la
 * prima lingua di sistema che inizia col codice di una lingua dell'elenco
 * decide (le altre si saltano); se non c'è nessuna delle nostre, la lingua
 * internazionale. Un setting sconosciuto vale 'system'.
 */
export function resolveUiLanguage(
  setting: string | null | undefined,
  systemLanguages: readonly string[]
): UiLanguage {
  const explicit = SUPPORTED_UI_LANGUAGES.find((l) => l.code === setting)
  if (explicit) return explicit.code
  for (const lang of systemLanguages) {
    if (typeof lang !== 'string') continue
    const lower = lang.toLowerCase()
    const hit = SUPPORTED_UI_LANGUAGES.find((l) => lower.startsWith(l.code))
    if (hit) return hit.code
  }
  return FALLBACK_UI_LANGUAGE
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
