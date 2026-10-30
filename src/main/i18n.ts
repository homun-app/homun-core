// Fase 17a (L5): i testi del processo main (tray, notifiche native, dialoghi).
// Qui non c'è React né macro: un piccolo dizionario tipato per lingua. La
// lingua iniziale viene da resolveUiLanguage con le lingue preferite di
// sistema e, appena il client del daemon è pronto, dal setting 'ui.language'
// (K1: il tray esiste anche con la finestra chiusa, quindi non può essere il
// renderer a dirlo all'avvio); quando l'utente cambia il setting il renderer
// lo comunica con l'IPC 'ui:language-changed'. Le notifiche che portano
// titolo e testo dal daemon restano invariate (17b).
import { app } from 'electron'
import { resolveUiLanguage, startupMainLanguage, type UiLanguage } from '../shared/ui-language'

/** I testi del main, per lingua. Homun è un nome proprio e non si traduce. */
export interface MainStrings {
  tray: { open: string; quit: string }
  tooltip: string
  notifyTest: { title: string; body: string }
  dialogs: { images: string; imageTooLarge: string }
}

const STRINGS: Record<UiLanguage, MainStrings> = {
  it: {
    tray: {
      open: 'Apri Homun',
      quit: 'Esci'
    },
    tooltip: 'Homun',
    notifyTest: {
      title: 'Homun',
      body: 'Test notifica — se la vedi, i permessi sono ok.'
    },
    dialogs: {
      images: 'Immagini',
      imageTooLarge: 'Immagine troppo grande (max 5MB)'
    }
  },
  en: {
    tray: {
      open: 'Open Homun',
      quit: 'Quit'
    },
    tooltip: 'Homun',
    notifyTest: {
      title: 'Homun',
      body: 'Notification test — if you can see this, permissions are ok.'
    },
    dialogs: {
      images: 'Images',
      imageTooLarge: 'Image too large (max 5MB)'
    }
  }
}

/** La lingua attiva del main; parte dalle lingue preferite di sistema. */
let language: UiLanguage = 'it'

export function initMainLanguage(): void {
  language = resolveUiLanguage(null, app.getPreferredSystemLanguages())
}

/**
 * Fase 17a (K1): applica all'avvio il setting 'ui.language' salvato. Il
 * setting si legge per la stessa strada dell'handler IPC settings:get (il
 * daemon tramite il client), appena il client è pronto; se il daemon non
 * risponde si resta sulla lingua di sistema, senza errori visibili. Il
 * chiamante ricostruisce poi il tray.
 */
export async function applyStartupLanguage(getSetting: () => Promise<unknown>): Promise<UiLanguage> {
  let setting: unknown = null
  try {
    setting = await getSetting()
  } catch {
    // daemon non raggiungibile: vale la lingua di sistema
  }
  language = startupMainLanguage(typeof setting === 'string' ? setting : null, app.getPreferredSystemLanguages())
  return language
}

/** Il renderer avvisa quando l'utente cambia il setting 'ui.language'. */
export function setMainLanguage(lang: UiLanguage): void {
  language = lang
}

/** I testi del main nella lingua attiva. */
export function mainStrings(): MainStrings {
  return STRINGS[language]
}
