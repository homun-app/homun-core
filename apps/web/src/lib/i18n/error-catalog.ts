/**
 * Catalogo errori condiviso col motore: contracts/i18n/errors.<lang>.json è
 * l'unica fonte (nessuna copia). Il motore lo legge con homun/i18n.py, il
 * client qui; le frasi vivono nel catalogo, non nel codice.
 */
import itCatalog from "../../../../../contracts/i18n/errors.it.json" with { type: "json" };
import enCatalog from "../../../../../contracts/i18n/errors.en.json" with { type: "json" };

export type ErrorCatalog = {
  language: string;
  errors: Record<string, string>;
  labels: Record<string, string>;
  codes: Record<string, string>;
};

const catalogs: Record<string, ErrorCatalog> = {
  it: itCatalog as ErrorCatalog,
  en: enCatalog as ErrorCatalog,
};

const FALLBACK_LANGUAGE = "en";

export function errorCatalog(language: string): ErrorCatalog {
  return catalogs[language] ?? catalogs[FALLBACK_LANGUAGE]!;
}

/** Etichetta tradotta per una chiave della sezione `labels` (fallback inglese). */
export function errorLabelText(key: string, language: string): string {
  return errorCatalog(language).labels[key] ?? errorCatalog(FALLBACK_LANGUAGE).labels[key] ?? key;
}

/**
 * Riempie i segnaposto `{param}`; i mancanti restano visibili come `{param}`.
 * `{param@label}` risolve il valore (chiave della sezione `labels`) nella
 * lingua corrente: stesso meccanismo del motore (format_message), così i
 * valori di enum interni non finiscono mai nella frase.
 */
export function formatErrorPlaceholders(
  template: string,
  params: Readonly<Record<string, string | number>> | null | undefined,
  language: string,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)(?:@(\w+))?\}/g, (whole, key: string, mode?: string) => {
    if (!(key in params)) return whole;
    const value = String(params[key]);
    return mode === "label" ? errorLabelText(value, language) : value;
  });
}

/** Frase per una `reason` stabile; null se assente in lingua e fallback. */
export function errorUserText(
  reason: string,
  params: Readonly<Record<string, string | number>> | null | undefined,
  language: string,
): string | null {
  const entry =
    errorCatalog(language).errors[reason] ?? errorCatalog(FALLBACK_LANGUAGE).errors[reason];
  return entry == null ? null : formatErrorPlaceholders(entry, params, language);
}

/** Frase generica per un `code`; l'ultima spiaggia è `codes.unknown`. */
export function errorCodeText(code: string, language: string): string {
  const entry = errorCatalog(language).codes[code] ?? errorCatalog(FALLBACK_LANGUAGE).codes[code];
  return entry ?? errorCatalog(FALLBACK_LANGUAGE).codes["unknown"]!;
}
