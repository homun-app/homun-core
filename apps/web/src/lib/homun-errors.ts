/**
 * Typed Homun client errors.
 * UI and adapters must surface these; never swallow engine failures into demo data.
 *
 * Il testo di prodotto non vive qui: si compone dal catalogo condiviso
 * (contracts/i18n) con `reason` + `params` nella lingua corrente; il `code`
 * resta il fallback. In questo file nessuna frase per l'utente.
 */

import { getLanguage, t } from "./i18n/index.ts";
import { errorCodeText, errorUserText } from "./i18n/error-catalog.ts";

export type HomunErrorCode =
  | "engine_unavailable"
  | "engine_capability_missing"
  | "request_timeout"
  | "request_cancelled"
  | "validation_error"
  | "invalid_transition"
  | "version_conflict"
  | "command_in_progress"
  | "provider_unavailable"
  | "storage_unavailable"
  | "permission_denied"
  | "not_found"
  | "unauthorized"
  | "unknown";

export type HomunErrorParams = Readonly<Record<string, string | number>>;

export class HomunClientError extends Error {
  readonly code: HomunErrorCode;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  /** Codice riportato dal motore prima della mappatura, quando c'era. */
  readonly engineCode: string | null;
  /** Chiave stabile del catalogo condiviso; null per gli errori non migrati. */
  readonly reason: string | null;
  readonly params: HomunErrorParams | null;
  override readonly cause?: unknown;

  constructor(
    code: HomunErrorCode,
    message: string,
    options?: {
      httpStatus?: number;
      retryable?: boolean;
      cause?: unknown;
      engineCode?: string | undefined;
      reason?: string | undefined;
      params?: HomunErrorParams | undefined;
    },
  ) {
    super(message);
    this.name = "HomunClientError";
    this.code = code;
    this.httpStatus = options?.httpStatus ?? null;
    this.retryable =
      options?.retryable ?? (code === "engine_unavailable" || code === "request_timeout");
    this.engineCode = options?.engineCode ?? null;
    this.reason = options?.reason ?? null;
    this.params = options?.params ?? null;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isHomunClientError(value: unknown): value is HomunClientError {
  return value instanceof HomunClientError;
}

function parseParams(raw: unknown): HomunErrorParams | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number") {
      params[key] = value;
    }
  }
  return Object.keys(params).length ? params : undefined;
}

/** Map engine HTTP JSON `{ detail: { code, reason?, params?, message } }` into a HomunClientError. */
export function homunErrorFromHttp(
  status: number,
  body: unknown,
  fallbackMessage: string,
): HomunClientError {
  const detail =
    body && typeof body === "object" && "detail" in body
      ? (body as { detail?: unknown }).detail
      : null;
  const payload =
    detail && typeof detail === "object"
      ? (detail as { code?: unknown; message?: unknown; reason?: unknown; params?: unknown })
      : null;
  const rawCode = typeof payload?.code === "string" ? payload.code : null;
  const message =
    typeof payload?.message === "string" && payload.message.trim()
      ? payload.message
      : fallbackMessage;

  const code = mapEngineCode(rawCode, status);
  return new HomunClientError(code, message, {
    httpStatus: status,
    retryable: status === 503 || status === 429 || code === "request_timeout",
    engineCode: rawCode ?? undefined,
    reason: typeof payload?.reason === "string" ? payload.reason : undefined,
    params: parseParams(payload?.params),
  });
}

/**
 * Map an engine event pair `{ code, message, reason?, params? }` (e.g. an SSE
 * `error` event) into a HomunClientError, keeping the engine code and reason
 * so `homunErrorUserMessage` can translate them: the raw message never
 * reaches the UI on its own.
 */
export function homunErrorFromEngineEvent(
  code: string | null,
  message: string,
  fallbackMessage: string,
  reason?: string | null,
  params?: HomunErrorParams | null,
): HomunClientError {
  const mapped = mapEngineCode(code, 0);
  return new HomunClientError(mapped, message.trim() || fallbackMessage, {
    retryable: code === "provider_unavailable" || mapped === "engine_unavailable",
    engineCode: code ?? undefined,
    reason: typeof reason === "string" && reason ? reason : undefined,
    params: params ?? undefined,
  });
}

function mapEngineCode(raw: string | null, status: number): HomunErrorCode {
  switch (raw) {
    case "engine_unavailable":
    case "engine_capability_missing":
    case "request_timeout":
    case "request_cancelled":
    case "provider_unavailable":
    case "command_in_progress":
    case "storage_unavailable":
    case "validation_error":
    case "invalid_transition":
    case "version_conflict":
    case "permission_denied":
    case "not_found":
    case "unauthorized":
      return raw;
    default:
      break;
  }
  if (status === 401) return "unauthorized";
  if (status === 403) return "permission_denied";
  if (status === 404) return "not_found";
  if (status === 409) return "version_conflict";
  if (status === 400) return "validation_error";
  if (status === 503) return "engine_unavailable";
  return "unknown";
}

/**
 * Riconosce il testo che sembra un'eccezione grezza del motore (Python o
 * interno), invece di una frase scritta per l'utente. Gli errori non ancora
 * migrati (senza `reason`) riportano ancora il messaggio del motore: quando al
 * suo posto arriva un'eccezione, la copia di prodotto vince e il testo grezzo
 * resta nei dettagli tecnici.
 */
export function looksLikeRawException(message: string): boolean {
  if (!message) return false;
  return (
    // ValueError, KeyError, ValidationError, … (ma non «Errore», che continua
    // con lettere e non chiude il confine di parola dopo «Error»)
    /[A-Za-z]+Error\b/.test(message) ||
    /\bException\b/.test(message) ||
    /\bTraceback\b/.test(message) ||
    /\[Errno \d+\]/.test(message) ||
    // percorsi puntati dei soli moduli che il motore può riportare in
    // un'eccezione (`homun.`, `pydantic.`, `sqlite3.`, `httpx.`, verificati in
    // `engine/src`), con almeno due segmenti dopo il prefisso: nomi di file e
    // domini hanno un solo punto (`report.pdf`, `homun.app`) e passano.
    /\b(?:homun|pydantic|sqlite3|httpx)\.[a-z_][a-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/.test(
      message,
    )
  );
}

/**
 * Short product copy for status strips and inline notices, composed from the
 * shared catalog in the current language:
 * 1. `reason` nel catalogo → la sua frase con i `params`;
 * 2. errore non migrato `validation_error`/`invalid_transition` → il messaggio
 *    del motore passa, a meno che non sembri un'eccezione grezza;
 * 3. frase generica del `code` («Dettagli tecnici» restano sempre disponibili).
 */
export function homunErrorUserMessage(error: unknown): string {
  const language = getLanguage();
  if (isHomunClientError(error)) {
    if (error.reason != null) {
      const text = errorUserText(error.reason, error.params, language);
      if (text != null) return text;
    }
    if (error.code === "validation_error" || error.code === "invalid_transition") {
      const message = error.message.trim();
      if (error.reason == null && message && !looksLikeRawException(message)) {
        return message;
      }
    }
    return errorCodeText(error.code, language);
  }
  // Gli errori non tipizzati non hanno mapping: resta la copia generica, mai
  // il messaggio interno (trace, [Errno …], nomi di modulo).
  return errorCodeText("unknown", language);
}

/** Il dettaglio tecnico di un errore: disponibile, ma solo su richiesta. */
export type HomunErrorTechnicalDetails = {
  /** Codice mappato del client; `unknown` per gli errori non tipizzati. */
  code: HomunErrorCode;
  /** Messaggio originale; null quando coincide col testo di prodotto. */
  message: string | null;
  /** Codice riportato dal motore prima della mappatura, se diverso dal nostro. */
  engineCode: string | null;
  /** Chiave stabile del catalogo, quando l'errore è migrato. */
  reason: string | null;
};

/**
 * Il blocco «Dettagli tecnici» di `HomunErrorNotice`, deciso qui per essere
 * testato senza DOM: codice, messaggio originale, codice del motore e reason.
 * Il messaggio non si ripete quando è già il testo principale mostrato.
 */
export function homunErrorTechnicalDetails(error: unknown): HomunErrorTechnicalDetails | null {
  if (error == null) {
    return null;
  }
  const code = isHomunClientError(error) ? error.code : "unknown";
  const engineCode =
    isHomunClientError(error) && error.engineCode && error.engineCode !== code
      ? error.engineCode
      : null;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage && rawMessage !== homunErrorUserMessage(error) ? rawMessage : null;
  const reason = isHomunClientError(error) ? error.reason : null;
  return { code, message, engineCode, reason };
}

/** I dettagli tecnici come testo semplice, per il pulsante «Copia». */
export function homunErrorDetailsText(details: HomunErrorTechnicalDetails): string {
  const lines = [`${t("errorDetails.code")}: ${details.code}`];
  if (details.reason) {
    lines.push(`${t("errorDetails.reason")}: ${details.reason}`);
  }
  if (details.message) {
    lines.push(`${t("errorDetails.message")}: ${details.message}`);
  }
  if (details.engineCode) {
    lines.push(`${t("errorDetails.engineCode")}: ${details.engineCode}`);
  }
  return lines.join("\n");
}
