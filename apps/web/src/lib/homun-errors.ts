/**
 * Typed Homun client errors.
 * UI and adapters must surface these; never swallow engine failures into demo data.
 */

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

export class HomunClientError extends Error {
  readonly code: HomunErrorCode;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(
    code: HomunErrorCode,
    message: string,
    options?: { httpStatus?: number; retryable?: boolean; cause?: unknown },
  ) {
    super(message);
    this.name = "HomunClientError";
    this.code = code;
    this.httpStatus = options?.httpStatus ?? null;
    this.retryable = options?.retryable ?? (code === "engine_unavailable" || code === "request_timeout");
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isHomunClientError(value: unknown): value is HomunClientError {
  return value instanceof HomunClientError;
}

/** Map engine HTTP JSON `{ detail: { code, message } }` into a HomunClientError. */
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
      ? (detail as { code?: unknown; message?: unknown })
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

/** Short Italian copy for status strips and inline notices. */
export function homunErrorUserMessage(error: unknown): string {
  if (isHomunClientError(error)) {
    switch (error.code) {
      case "engine_unavailable":
        return "Motore non raggiungibile. Avvialo o riprova.";
      case "request_timeout":
        return "Il motore non ha risposto in tempo. Riprova.";
      case "request_cancelled":
        return "Richiesta annullata.";
      case "engine_capability_missing":
        return "Questa capacità del motore non è ancora disponibile.";
      case "command_in_progress":
        return "Questo messaggio è già in elaborazione. Attendi il risultato prima di riprovare.";
      case "provider_unavailable":
        return "Il modello non è disponibile. Il messaggio resta salvato: puoi riprovare.";
      case "storage_unavailable":
        return "Il salvataggio non è disponibile. Verifica lo stato del motore e riprova.";
      case "version_conflict":
        return "Qualcun altro ha aggiornato lo stesso oggetto. Ricarica e riprova.";
      case "permission_denied":
      case "unauthorized":
        return "Non hai i permessi per questa azione.";
      case "not_found":
        return "Oggetto non trovato sul motore.";
      case "validation_error":
      case "invalid_transition":
        return error.message;
      case "unknown":
        return error.message || "Errore imprevisto.";
      default: {
        const _exhaustive: never = error.code;
        return _exhaustive;
      }
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Errore imprevisto.";
}
