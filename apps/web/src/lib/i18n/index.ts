/** Lightweight, type-safe i18n system for Homun UI. */
import { it, type TranslationDictionary } from "./locales/it.ts";
import { en } from "./locales/en.ts";

export type SupportedLanguage = "it" | "en";

const dictionaries: Record<SupportedLanguage, TranslationDictionary> = {
  it,
  en,
};

let currentLanguage: SupportedLanguage = "it";

// Initialize from storage in browser environment
if (typeof window !== "undefined" && window.localStorage) {
  const stored = window.localStorage.getItem("homun_language");
  if (stored === "it" || stored === "en") {
    currentLanguage = stored;
  }
}

const listeners = new Set<(lang: SupportedLanguage) => void>();

export function getLanguage(): SupportedLanguage {
  return currentLanguage;
}

export function setLanguage(lang: SupportedLanguage): void {
  if (lang !== "it" && lang !== "en") return;
  currentLanguage = lang;
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.setItem("homun_language", lang);
  }
  for (const listener of listeners) {
    listener(lang);
  }
}

export function subscribeLanguage(listener: (lang: SupportedLanguage) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDictionary(lang: SupportedLanguage = currentLanguage): TranslationDictionary {
  return dictionaries[lang] ?? dictionaries.it;
}

/** Formats a localized string with `{key}` placeholders. */
export function formatString(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    return key in params ? String(params[key]) : `{${key}}`;
  });
}
