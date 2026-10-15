/** Re-renders the component when the interface language changes. */
import { useEffect, useState } from "react";
import { getLanguage, subscribeLanguage, type SupportedLanguage } from "@/lib/i18n";

export function useLanguage(): SupportedLanguage {
  const [language, setLanguageState] = useState<SupportedLanguage>(getLanguage);
  useEffect(() => subscribeLanguage(setLanguageState), []);
  return language;
}
