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
  /** Codice riportato dal motore prima della mappatura, quando c'era. */
  readonly engineCode: string | null;
  override readonly cause?: unknown;

  constructor(
    code: HomunErrorCode,
    message: string,
    options?: {
      httpStatus?: number;
      retryable?: boolean;
      cause?: unknown;
      engineCode?: string | undefined;
    },
  ) {
    super(message);
    this.name = "HomunClientError";
    this.code = code;
    this.httpStatus = options?.httpStatus ?? null;
    this.retryable =
      options?.retryable ?? (code === "engine_unavailable" || code === "request_timeout");
    this.engineCode = options?.engineCode ?? null;
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
    detail && typeof detail === "object" ? (detail as { code?: unknown; message?: unknown }) : null;
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
  });
}

/**
 * Map an engine event pair `{ code, message }` (e.g. an SSE `error` event)
 * into a HomunClientError, keeping the engine code so `homunErrorUserMessage`
 * can translate it: the raw message never reaches the UI on its own.
 */
export function homunErrorFromEngineEvent(
  code: string | null,
  message: string,
  fallbackMessage: string,
): HomunClientError {
  const mapped = mapEngineCode(code, 0);
  return new HomunClientError(mapped, message.trim() || fallbackMessage, {
    retryable: code === "provider_unavailable" || mapped === "engine_unavailable",
    engineCode: code ?? undefined,
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
 * interno), invece di una frase scritta per l'utente. Il motore scrive in
 * italiano i messaggi di `validation_error`/`invalid_transition`; quando al
 * loro posto arriva un'eccezione, la copia di prodotto deve vincere e il
 * testo grezzo restare nei dettagli tecnici.
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
    // percorsi di modulo puntati: homun.core.interpret, pydantic.v1
    /\b[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+/.test(message)
  );
}

/** Copia di prodotto quando il messaggio del motore non è una frase per l'utente. */
const VALIDATION_FALLBACK = "La richiesta non è valida. Verifica i dati e riprova.";
const TRANSITION_FALLBACK = "L'azione non è possibile nello stato attuale. Ricarica e riprova.";

/** Short Italian copy for status strips and inline notices. */
export function homunErrorUserMessage(error: unknown): string {
  if (isHomunClientError(error)) {
    switch (error.code) {
      case "engine_unavailable":
        return "App locale non raggiungibile. Avviala o riprova.";
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
        return "I dati sono cambiati mentre agivi (per esempio è arrivato un nuovo messaggio o un'altra finestra ha aggiornato il lavoro). Ricarica e riprova.";
      case "permission_denied":
      case "unauthorized":
        return "Non hai i permessi per questa azione.";
      case "not_found":
        return "Oggetto non trovato sul motore.";
      case "validation_error":
      case "invalid_transition": {
        // Il motore scrive queste frasi in italiano per l'utente: passano.
        // Un'eccezione grezza al posto della frase vince la copia di prodotto.
        const message = error.message.trim();
        if (message && !looksLikeRawException(message)) {
          return message;
        }
        return error.code === "validation_error" ? VALIDATION_FALLBACK : TRANSITION_FALLBACK;
      }
      case "unknown":
        // Nessun testo grezzo di eccezione all'utente: il codice senza copia
        // di prodotto parla con la sola copia generica.
        return "Errore imprevisto.";
      default: {
        const _exhaustive: never = error.code;
        return _exhaustive;
      }
    }
  }
  // Gli errori non tipizzati non hanno mapping: resta la copia generica, mai
  // il messaggio interno (trace, [Errno …], nomi di modulo).
  return "Errore imprevisto.";
}

/** Il dettaglio tecnico di un errore: disponibile, ma solo su richiesta. */
export type HomunErrorTechnicalDetails = {
  /** Codice mappato del client; `unknown` per gli errori non tipizzati. */
  code: HomunErrorCode;
  /** Messaggio originale; null quando coincide col testo di prodotto. */
  message: string | null;
  /** Codice riportato dal motore prima della mappatura, se diverso dal nostro. */
  engineCode: string | null;
};

/**
 * Il blocco «Dettagli tecnici» di `HomunErrorNotice`, deciso qui per essere
 * testato senza DOM: codice, messaggio originale e codice del motore. Il
 * messaggio non si ripete quando è già il testo principale mostrato.
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
  return { code, message, engineCode };
}

/** I dettagli tecnici come testo semplice, per il pulsante «Copia». */
export function homunErrorDetailsText(details: HomunErrorTechnicalDetails): string {
  const lines = [`codice: ${details.code}`];
  if (details.message) {
    lines.push(`messaggio: ${details.message}`);
  }
  if (details.engineCode) {
    lines.push(`codice motore: ${details.engineCode}`);
  }
  return lines.join("\n");
}
