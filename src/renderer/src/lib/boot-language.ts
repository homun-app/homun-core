// W2 (fase avvio-finestra): la lingua del primo mount NON può tenere vuota
// la finestra. Fino a qui main.tsx montava l'app SOLO dopo
// settingsGet('ui.language') — un RPC al daemon — e col daemon in riavvio per
// aggiornamento quella RPC stava appesa secondi: finestra VUOTA, niente
// splash, proprio ciò che W2 vieta. Il setting si aspetta poco (il daemon è
// già su nel caso normale: la lingua giusta al primo frame), poi si monta con
// la lingua di sistema; quando il setting arriva si riattiva a caldo.
import type { UiLanguage, UiLanguageSetting } from '../../../shared/ui-language'
import { resolveUiLanguage } from '../../../shared/ui-language'

/** Quanto si aspetta il setting della lingua prima di montare comunque. */
export const BOOT_LANG_WAIT_MS = 1_500

/**
 * Il setting ui.language per il primo mount: al massimo BOOT_LANG_WAIT_MS.
 * Un errore (o un daemon che non risponde) vale 'system'.
 */
export async function bootLanguageSetting(read: () => Promise<UiLanguageSetting>): Promise<UiLanguageSetting> {
  const fallback: UiLanguageSetting = 'system'
  return Promise.race([
    read().catch(() => fallback),
    new Promise<UiLanguageSetting>((resolve) => setTimeout(() => resolve(fallback), BOOT_LANG_WAIT_MS))
  ])
}

/**
 * Il setting è arrivato DOPO il mount: la lingua da riattivare a caldo, o
 * null se è quella che l'app sta già usando.
 */
export function laterBootLanguage(mounted: UiLanguage, setting: UiLanguageSetting, preferred: readonly string[]): UiLanguage | null {
  const want = resolveUiLanguage(setting, preferred)
  return want !== mounted ? want : null
}
