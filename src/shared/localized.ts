// Fase 17c (C5): i campi bilingui dei dati statici (catalogo connettori,
// template). pickLang sceglie la forma della lingua richiesta; la stringa
// semplice resta valida (nomi propri, dati preesistenti) e passa dritta.
import type { Localized } from './types'
import type { UiLanguage } from './ui-language'

/** Il valore nella lingua richiesta (la forma stringa passa invariata). */
export function pickLang(v: Localized, lang: UiLanguage): string {
  return typeof v === 'string' ? v : v[lang]
}

/** Guardia: il valore è un campo Localized ben formato? (per le validazioni) */
export function isLocalized(v: unknown): v is Localized {
  if (typeof v === 'string') return !!v.trim()
  if (!v || typeof v !== 'object') return false
  const c = v as { it?: unknown; en?: unknown }
  return typeof c.it === 'string' && !!c.it.trim() && typeof c.en === 'string' && !!c.en.trim()
}
