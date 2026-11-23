import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '@lingui/react'
import { i18n, activateUiLanguage } from './lib/i18n'
import { resolveUiLanguage, type UiLanguageSetting } from '../../shared/ui-language'
// W2 (fase avvio-finestra): il setting della lingua NON può tenere vuota la
// finestra (col daemon in riavvio l'RPC stava appesa secondi)
import { bootLanguageSetting, laterBootLanguage } from './lib/boot-language'
import { App } from './App'
import { PipView } from './components/PipView'
// P1 (fase primo-avvio): il primo segnale dal renderer al main (renderer-ready nel registro)
import { FirstPaintSignal } from './components/FirstPaintSignal'
// B5 (fase b20-bug): il marcatore data-focus-from su <html> che styles.css
// legge per l'anello del fuoco (regola unica e variante focus-visible)
import { installFocusFrom } from './lib/focus-from'
import './styles.css'

// B5: subito, prima di montare — così vale dal primo clic
installFocusFrom(document)

// Fase 17a (L2): l'app si monta SOLO dopo la prima attivazione della lingua
// (niente testo non tradotto che lampeggia), avvolta in I18nProvider — così
// un cambio lingua a caldo ri-renderizza tutta l'interfaccia.
// Fase 17a (K1): dopo la prima attivazione il renderer comunica al main la
// lingua attiva UNA volta — main e renderer coincidono anche con 'system',
// quando navigator.languages e le lingue di sistema differiscono.
// W2 (fase avvio-finestra): il setting si aspetta al massimo BOOT_LANG_WAIT_MS
// — oltre, si monta con la lingua di sistema e il setting arrivato DOPO si
// riattiva a caldo. Mai una finestra vuota mentre il daemon si riavvia.
async function boot(): Promise<void> {
  const api = (window as unknown as {
    sandbot: {
      settingsGet<T>(key: string, fallback: T): Promise<T>
      uiLanguageChanged(lang: 'it' | 'en'): Promise<void>
    }
  }).sandbot
  const setting = await bootLanguageSetting(() => api.settingsGet<UiLanguageSetting>('ui.language', 'system'))
  const lang = resolveUiLanguage(setting, navigator.languages)
  await activateUiLanguage(lang)
  void api.uiLanguageChanged(lang).catch(() => undefined)
  // SV4 (fase schermo-vivo): la finestra PiP carica la STESSA pagina con la
  // rotta #/pip/<agentId> — si rende SOLO quella vista (nessuna shell)
  const pipMatch = location.hash.match(/^#\/pip\/([A-Za-z0-9_-]+)$/)
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nProvider i18n={i18n}>
        {pipMatch ? <PipView agentId={pipMatch[1]!} /> : <App />}
        {/* P1: accanto alla finestra vera (App o PiP): il primo paint lo dice al main */}
        <FirstPaintSignal />
      </I18nProvider>
    </React.StrictMode>
  )
  // W2 (fase avvio-finestra): il setting VERO arriva quando il daemon
  // risponde — se nel frattempo si è montati con la lingua di sistema e
  // quella salvata è diversa, si riattiva a caldo (come dall'utente)
  if (!pipMatch) {
    void api.settingsGet<UiLanguageSetting>('ui.language', 'system')
      .then((s) => {
        const want = laterBootLanguage(lang, s, navigator.languages)
        if (want) {
          void activateUiLanguage(want)
          void api.uiLanguageChanged(want).catch(() => undefined)
        }
      })
      .catch(() => undefined)
  }
}

void boot()
