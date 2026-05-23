export type BrowserMethod =
  | "browser.health"
  | "browser.profiles"
  | "browser.start"
  | "browser.stop"
  | "browser.tabs"
  | "browser.open"
  | "browser.focus"
  | "browser.close_tab"
  | "browser.navigate"
  | "browser.snapshot"
  | "browser.screenshot"
  | "browser.act"
  | "browser.arm_file_chooser"
  | "browser.respond_dialog"
  | "browser.wait_download"
  | "browser.console"
  | "browser.pdf";

export type BrowserRequest = {
  id: string;
  method: BrowserMethod;
  params?: Record<string, unknown>;
};

export type BrowserErrorPayload = {
  code: string;
  message: string;
  retryable: boolean;
  manual_action_required: boolean;
};

export type BrowserResponse =
  | {
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      id: string;
      ok: false;
      error: BrowserErrorPayload;
    };

const METHODS = new Set<BrowserMethod>([
  "browser.health",
  "browser.profiles",
  "browser.start",
  "browser.stop",
  "browser.tabs",
  "browser.open",
  "browser.focus",
  "browser.close_tab",
  "browser.navigate",
  "browser.snapshot",
  "browser.screenshot",
  "browser.act",
  "browser.arm_file_chooser",
  "browser.respond_dialog",
  "browser.wait_download",
  "browser.console",
  "browser.pdf",
]);

export class BrowserAutomationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly manualActionRequired: boolean;

  constructor(params: {
    code: string;
    message: string;
    retryable?: boolean;
    manualActionRequired?: boolean;
  }) {
    super(params.message);
    this.name = "BrowserAutomationError";
    this.code = params.code;
    this.retryable = params.retryable ?? false;
    this.manualActionRequired = params.manualActionRequired ?? false;
  }
}

export function parseRequestLine(line: string): BrowserRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new BrowserAutomationError({
      code: "BROWSER_INVALID_JSON",
      message: "request line is not valid JSON",
      retryable: false,
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BrowserAutomationError({
      code: "BROWSER_INVALID_REQUEST",
      message: "request must be an object",
      retryable: false,
    });
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim() === "") {
    throw new BrowserAutomationError({
      code: "BROWSER_INVALID_REQUEST",
      message: "request id is required",
      retryable: false,
    });
  }
  if (typeof record.method !== "string" || !METHODS.has(record.method as BrowserMethod)) {
    throw new BrowserAutomationError({
      code: "BROWSER_UNKNOWN_METHOD",
      message: "browser method is not supported",
      retryable: false,
    });
  }
  if (
    record.params !== undefined &&
    (!record.params || typeof record.params !== "object" || Array.isArray(record.params))
  ) {
    throw new BrowserAutomationError({
      code: "BROWSER_INVALID_REQUEST",
      message: "request params must be an object",
      retryable: false,
    });
  }

  return {
    id: record.id,
    method: record.method as BrowserMethod,
    ...(record.params ? { params: record.params as Record<string, unknown> } : {}),
  };
}

export function makeSuccessResponse(id: string, result: unknown): BrowserResponse {
  return { id, ok: true, result };
}

export function makeErrorResponse(id: string, error: unknown): BrowserResponse {
  const browserError =
    error instanceof BrowserAutomationError
      ? error
      : new BrowserAutomationError({
          code: "BROWSER_INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
  return {
    id,
    ok: false,
    error: {
      code: browserError.code,
      message: browserError.message,
      retryable: browserError.retryable,
      manual_action_required: browserError.manualActionRequired,
    },
  };
}

export function serializeResponseLine(response: BrowserResponse): string {
  return `${JSON.stringify(response)}\n`;
}
