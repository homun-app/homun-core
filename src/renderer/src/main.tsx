import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '@lingui/react'
import { i18n, activateUiLanguage } from './lib/i18n'
import { resolveUiLanguage, type UiLanguageSetting } from '../../shared/ui-language'
import { App } from './App'
import './styles.css'

// Fase 17a (L2): l'app si monta SOLO dopo la prima attivazione della lingua
// (niente testo non tradotto che lampeggia), avvolta in I18nProvider — così
// un cambio lingua a caldo ri-renderizza tutta l'interfaccia.
// Fase 17a (K1): dopo la prima attivazione il renderer comunica al main la
// lingua attiva UNA volta — main e renderer coincidono anche con 'system',
// quando navigator.languages e le lingue di sistema differiscono.
async function boot(): Promise<void> {
  const api = (window as unknown as {
    sandbot: {
      settingsGet<T>(key: string, fallback: T): Promise<T>
      uiLanguageChanged(lang: 'it' | 'en'): Promise<void>
    }
  }).sandbot
  let setting: UiLanguageSetting = 'system'
  try {
    setting = await api.settingsGet<UiLanguageSetting>('ui.language', 'system')
  } catch {
    // niente setting: resta 'system'
  }
  const lang = resolveUiLanguage(setting, navigator.languages)
  await activateUiLanguage(lang)
  void api.uiLanguageChanged(lang).catch(() => undefined)
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nProvider i18n={i18n}>
        <App />
      </I18nProvider>
    </React.StrictMode>
  )
}

void boot()
