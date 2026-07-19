import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import it from "./locales/it.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";

// Read the persisted language from the SAME localStorage key the settingsStore
// uses (lfpa.settings.language). Fall back to "en" (the app default) when unset.
function readPersistedLanguage(): string {
  try {
    const value = window.localStorage.getItem("lfpa.settings.language");
    if (value && value.trim().length > 0) return value.trim();
  } catch {
    // localStorage unavailable (SSR / sandboxed) — fall through.
  }
  return "en";
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    it: { translation: it },
    es: { translation: es },
    fr: { translation: fr },
    de: { translation: de },
  },
  lng: readPersistedLanguage(),
  fallbackLng: "en",
  interpolation: {
    // React already escapes by default, so no need for i18next's escaping.
    escapeValue: false,
  },
  returnNull: false,
});

export default i18n;
