import type { Locator, Page } from "playwright-core";
import { BrowserAutomationError } from "../contracts.js";

type SnapshotAfterAction = {
  snapshotAfter?: boolean;
  snapshot_after?: boolean;
};

const MIN_TIMEOUT_MS = 500;
const DEFAULT_ACTION_TIMEOUT_MS = 8_000;
const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
const MAX_ACTION_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 120_000;
const MAX_WAIT_TIME_MS = 30_000;
const MAX_CLICK_DELAY_MS = 5_000;
const MAX_BATCH_ACTIONS = 100;
const MAX_BATCH_DEPTH = 3;

export type BrowserActionResult = {
  ok: true;
  url: string;
  targetId?: string;
  snapshot?: string;
  refs?: Array<{ ref: string; role: string; name: string; refsMode?: "aria" | "locator" }>;
  refsMode?: "aria" | "locator";
  snapshotFormat?: "ai" | "legacy";
  stats?: {
    lines: number;
    chars: number;
    refs: number;
  };
  filledRefs?: string[];
  failedRefs?: Array<{ ref: string; error: string }>;
  batchResults?: Array<BrowserActionResult | { ok: false; error: string }>;
  result?: unknown;
};

export type BrowserActRequest = BrowserActRequestInner & SnapshotAfterAction;

export type BrowserFormField = {
  ref: string;
  type?: string;
  value?: string | number | boolean;
};

type BrowserActRequestInner =
  | {
      kind: "click";
      targetId: string;
      ref?: string;
      selector?: string;
      doubleClick?: boolean;
      button?: "left" | "right" | "middle";
      modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
      delayMs?: number;
      timeoutMs?: number;
    }
  | {
      kind: "clickCoords";
      targetId: string;
      x: number;
      y: number;
      doubleClick?: boolean;
      button?: "left" | "right" | "middle";
      delayMs?: number;
    }
  | {
      kind: "fill";
      targetId: string;
      fields: BrowserFormField[];
      timeoutMs?: number;
    }
  | {
      kind: "fill_form";
      targetId: string;
      fields: BrowserFormField[];
      timeoutMs?: number;
    }
  | {
      kind: "type";
      targetId: string;
      ref?: string;
      selector?: string;
      text: string;
      submit?: boolean;
      slowly?: boolean;
      timeoutMs?: number;
      // How to confirm an autocomplete/combobox after typing. "arrow_enter"
      // presses ArrowDown+Enter (the keyboard pattern most station/date
      // autocompletes require); "enter" just presses Enter; "none" disables.
      // When unset, autocomplete comboboxes are auto-confirmed with arrow_enter.
      commit?: "arrow_enter" | "enter" | "none";
    }
  | {
      kind: "press";
      targetId: string;
      key: string;
      delayMs?: number;
    }
  | {
      kind: "press_key";
      targetId: string;
      text: string;
      delayMs?: number;
    }
  | {
      kind: "select";
      targetId: string;
      ref?: string;
      selector?: string;
      values: string[];
      timeoutMs?: number;
    }
  | {
      kind: "select_option";
      targetId: string;
      ref: string;
      value: string | string[];
      timeoutMs?: number;
    }
  | {
      kind: "hover";
      targetId: string;
      ref?: string;
      selector?: string;
      timeoutMs?: number;
    }
  | {
      kind: "scrollIntoView";
      targetId: string;
      ref?: string;
      selector?: string;
      timeoutMs?: number;
    }
  | {
      kind: "scroll_into_view";
      targetId: string;
      ref: string;
      timeoutMs?: number;
    }
  | {
      kind: "scroll";
      targetId: string;
      direction?: "up" | "down" | "left" | "right";
      amount?: number;
      ref?: string;
    }
  | {
      kind: "wait";
      targetId: string;
      text?: string;
      textGone?: string;
      selector?: string;
      url?: string;
      loadState?: "load" | "domcontentloaded" | "networkidle";
      timeMs?: number;
      timeoutMs?: number;
    }
  | {
      kind: "navigate";
      targetId: string;
      url: string;
      loadState?: "load" | "domcontentloaded" | "networkidle";
      timeoutMs?: number;
    }
  | {
      kind: "evaluate";
      targetId: string;
      fn: string;
      ref?: string;
      timeoutMs?: number;
    }
  | {
      kind: "resize";
      targetId: string;
      width: number;
      height: number;
    }
  | {
      kind: "close";
      targetId: string;
    }
  | {
      kind: "batch";
      targetId: string;
      actions: BrowserActRequest[];
      stopOnError?: boolean;
    };

export async function executeAction(
  page: Page,
  refs: Map<string, Locator>,
  action: BrowserActRequest,
): Promise<BrowserActionResult> {
  try {
    return await executeActionUnchecked(page, refs, action, 0);
  } catch (error) {
    throw normalizeActionError(error, action.kind);
  }
}

async function executeActionUnchecked(
  page: Page,
  refs: Map<string, Locator>,
  action: BrowserActRequest,
  depth: number,
): Promise<BrowserActionResult> {
  switch (action.kind) {
    case "click": {
      const locator = requireRefOrSelector(page, refs, action.ref, action.selector, "click");
      const delayMs = nonNegativeDelay(action.delayMs, MAX_CLICK_DELAY_MS);
      if (delayMs > 0) {
        await locator.hover({ timeout: actionTimeout(action.timeoutMs) });
        await page.waitForTimeout(delayMs);
      }
      const options = {
        timeout: actionTimeout(action.timeoutMs),
        button: action.button,
        modifiers: action.modifiers,
      };
      if (action.doubleClick) {
        await locator.dblclick(options);
      } else {
        await locator.click(options);
      }
      return { ok: true, url: page.url() };
    }
    case "clickCoords": {
      await page.mouse.click(action.x, action.y, {
        button: action.button,
        clickCount: action.doubleClick ? 2 : 1,
        delay: nonNegativeDelay(action.delayMs, MAX_CLICK_DELAY_MS),
      });
      return { ok: true, url: page.url() };
    }
    case "fill":
    case "fill_form": {
      const filledRefs: string[] = [];
      const failedRefs: Array<{ ref: string; error: string }> = [];
      for (const field of action.fields) {
        const ref = field.ref?.trim();
        if (!ref) {
          continue;
        }
        try {
          await fillFormField(requireRef(refs, ref), field, actionTimeout(action.timeoutMs));
          filledRefs.push(ref);
        } catch (error) {
          failedRefs.push({ ref, error: errorMessage(error) });
        }
      }
      if (!filledRefs.length) {
        throw new BrowserAutomationError({
          code: "BROWSER_FORM_FILL_FAILED",
          message: failedRefs.map((failure) => `${failure.ref}: ${failure.error}`).join("; "),
          retryable: true,
        });
      }
      return { ok: true, url: page.url(), filledRefs, failedRefs };
    }
    case "type": {
      const locator = requireRefOrSelector(page, refs, action.ref, action.selector, "type");
      const timeout = actionTimeout(action.timeoutMs);
      await locator.click({ timeout });
      await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout });
      await locator.type(action.text, { delay: action.slowly ? 75 : 20 });
      // Resolve the confirmation strategy: explicit `commit`, else `submit`
      // (legacy Enter), else auto-confirm autocomplete comboboxes by keyboard
      // so weak local models that cannot click a non-ref suggestion still
      // select an option deterministically.
      const commit =
        action.commit ?? (action.submit ? "enter" : await autocompleteCommitMode(locator));
      if (commit === "arrow_enter") {
        await page.waitForTimeout(500); // let the suggestion list render
        await locator.press("ArrowDown", { timeout });
        await page.waitForTimeout(150);
        await locator.press("Enter", { timeout });
      } else if (commit === "enter") {
        await locator.press("Enter", { timeout });
      }
      await page.waitForTimeout(1000);
      return { ok: true, url: page.url() };
    }
    case "press": {
      await page.keyboard.press(action.key, { delay: nonNegativeDelay(action.delayMs) });
      return { ok: true, url: page.url() };
    }
    case "press_key": {
      await page.keyboard.press(action.text, { delay: nonNegativeDelay(action.delayMs) });
      return { ok: true, url: page.url() };
    }
    case "select": {
      await requireRefOrSelector(page, refs, action.ref, action.selector, "select").selectOption(action.values, {
        timeout: actionTimeout(action.timeoutMs),
      });
      return { ok: true, url: page.url() };
    }
    case "select_option": {
      await requireRef(refs, action.ref).selectOption(action.value, {
        timeout: actionTimeout(action.timeoutMs),
      });
      return { ok: true, url: page.url() };
    }
    case "hover": {
      await requireRefOrSelector(page, refs, action.ref, action.selector, "hover").hover({
        timeout: actionTimeout(action.timeoutMs),
      });
      return { ok: true, url: page.url() };
    }
    case "scrollIntoView": {
      await requireRefOrSelector(page, refs, action.ref, action.selector, "scrollIntoView").scrollIntoViewIfNeeded({
        timeout: actionTimeout(action.timeoutMs),
      });
      return { ok: true, url: page.url() };
    }
    case "scroll_into_view": {
      await requireRef(refs, action.ref).scrollIntoViewIfNeeded({
        timeout: actionTimeout(action.timeoutMs),
      });
      return { ok: true, url: page.url() };
    }
    case "scroll": {
      if (action.ref) {
        await requireRef(refs, action.ref).click().catch(() => undefined);
      }
      const direction = action.direction ?? "down";
      const amount = Math.max(1, Math.min(Math.abs(action.amount ?? 3), 10));
      const key =
        direction === "up"
          ? "PageUp"
          : direction === "left"
            ? "ArrowLeft"
            : direction === "right"
              ? "ArrowRight"
              : "PageDown";
      for (let index = 0; index < amount; index += 1) {
        await page.keyboard.press(key);
      }
      return { ok: true, url: page.url() };
    }
    case "wait": {
      if (action.text) {
        await page.getByText(action.text).first().waitFor({ timeout: waitTimeout(action.timeoutMs) });
      } else if (action.textGone) {
        await page.getByText(action.textGone).first().waitFor({
          state: "hidden",
          timeout: waitTimeout(action.timeoutMs),
        });
      } else if (action.selector) {
        await page.locator(action.selector).first().waitFor({ timeout: waitTimeout(action.timeoutMs) });
      } else if (action.url) {
        await page.waitForURL(action.url, { timeout: waitTimeout(action.timeoutMs) });
      } else if (action.loadState) {
        await page.waitForLoadState(action.loadState, { timeout: waitTimeout(action.timeoutMs) });
      } else {
        await page.waitForTimeout(waitDelay(action.timeMs ?? action.timeoutMs ?? 500));
      }
      return { ok: true, url: page.url() };
    }
    case "navigate": {
      // Direct navigation to a chosen source / deliberate per-source fallback.
      // The observe-act loop otherwise can only click refs on the current page,
      // which makes "move to the next source" impossible.
      const timeout = action.timeoutMs ?? 30_000;
      await page.goto(action.url, {
        waitUntil: action.loadState ?? "domcontentloaded",
        timeout,
      });
      // Best-effort settle so the next snapshot reflects loaded results, not a
      // skeleton (heavy SPA sites may never go fully idle — cap it).
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      return { ok: true, url: page.url() };
    }
    case "evaluate": {
      const timeoutMs = actionTimeout(action.timeoutMs);
      const result = action.ref
        ? await requireRef(refs, action.ref).evaluate(buildElementEvaluator(action.fn), {
            fnBody: action.fn,
            timeoutMs,
          })
        : await page.evaluate(buildPageEvaluator(action.fn), {
            fnBody: action.fn,
            timeoutMs,
          });
      return { ok: true, url: page.url(), result };
    }
    case "resize": {
      await page.setViewportSize({
        width: Math.max(1, Math.floor(action.width)),
        height: Math.max(1, Math.floor(action.height)),
      });
      return { ok: true, url: page.url() };
    }
    case "close": {
      const url = page.url();
      await page.close();
      return { ok: true, url };
    }
    case "batch": {
      if (depth >= MAX_BATCH_DEPTH) {
        throw new BrowserAutomationError({
          code: "BROWSER_BATCH_TOO_DEEP",
          message: `batch depth exceeds ${MAX_BATCH_DEPTH}`,
          retryable: false,
        });
      }
      if (!Array.isArray(action.actions) || action.actions.length === 0) {
        throw new BrowserAutomationError({
          code: "BROWSER_INVALID_REQUEST",
          message: "batch actions must be a non-empty array",
          retryable: false,
        });
      }
      if (countBatchActions(action.actions) > MAX_BATCH_ACTIONS) {
        throw new BrowserAutomationError({
          code: "BROWSER_BATCH_TOO_LARGE",
          message: `batch exceeds ${MAX_BATCH_ACTIONS} actions`,
          retryable: false,
        });
      }
      const batchResults: BrowserActionResult["batchResults"] = [];
      for (const nested of action.actions) {
        try {
          batchResults.push(await executeActionUnchecked(page, refs, withTarget(action.targetId, nested), depth + 1));
        } catch (error) {
          const normalized = normalizeActionError(error, nested.kind);
          batchResults.push({ ok: false, error: `${normalized.code}: ${normalized.message}` });
          if (action.stopOnError !== false) {
            throw normalized;
          }
        }
      }
      return { ok: true, url: page.url(), batchResults };
    }
    default: {
      // An unrecognized action shape (e.g. a planner that emitted
      // `{actions:[...]}` without `kind:"batch"`, or a typo'd kind) previously
      // fell through the switch and returned `undefined` — a silent no-op
      // reported as success. Fail loudly so the caller sees the contract error.
      throw new BrowserAutomationError({
        code: "BROWSER_INVALID_REQUEST",
        message: `unknown action kind: ${JSON.stringify((action as { kind?: unknown }).kind)}`,
        retryable: false,
      });
    }
  }
}

function withTarget(targetId: string, action: BrowserActRequest): BrowserActRequest {
  return { ...action, targetId } as BrowserActRequest;
}

function countBatchActions(actions: BrowserActRequest[]): number {
  let count = 0;
  for (const action of actions) {
    count += 1;
    if (action.kind === "batch") {
      count += countBatchActions(action.actions);
    }
  }
  return count;
}

async function fillFormField(locator: Locator, field: BrowserFormField, timeout: number): Promise<void> {
  const type = (field.type ?? "text").trim().toLowerCase() || "text";
  const rawValue = field.value;
  const value =
    typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean"
      ? String(rawValue)
      : "";
  if (type === "checkbox" || type === "radio" || typeof rawValue === "boolean") {
    await locator.setChecked(rawValue === true || value === "true" || value === "1", { timeout });
    return;
  }
  await locator.fill(value, { timeout });
}

function actionTimeout(value: number | undefined): number {
  return boundedTimeout(value, DEFAULT_ACTION_TIMEOUT_MS, MAX_ACTION_TIMEOUT_MS);
}

function waitTimeout(value: number | undefined): number {
  return boundedTimeout(value, DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
}

function boundedTimeout(value: number | undefined, fallback: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value ?? fallback) : fallback;
  return Math.max(MIN_TIMEOUT_MS, Math.min(normalized, max));
}

function waitDelay(value: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value) : 500;
  return Math.max(0, Math.min(normalized, MAX_WAIT_TIME_MS));
}

function nonNegativeDelay(value: number | undefined, max = 5_000): number {
  const normalized = Number.isFinite(value) ? Math.floor(value ?? 0) : 0;
  return Math.max(0, Math.min(normalized, max));
}

function normalizeActionError(error: unknown, kind: string): BrowserAutomationError {
  if (error instanceof BrowserAutomationError) {
    return error;
  }
  const message = errorMessage(error);
  if (/timeout|timed out/i.test(message)) {
    return new BrowserAutomationError({
      code: "BROWSER_ACTION_TIMEOUT",
      message: `${kind} timed out: ${message}`,
      retryable: true,
    });
  }
  if (/dialog/i.test(message)) {
    return new BrowserAutomationError({
      code: "BROWSER_DIALOG_BLOCKED",
      message: `${kind} blocked by dialog: ${message}`,
      retryable: true,
      manualActionRequired: true,
    });
  }
  return new BrowserAutomationError({
    code: "BROWSER_ACTION_FAILED",
    message: `${kind} failed: ${message}`,
    retryable: true,
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function requireRef(refs: Map<string, Locator>, ref: string): Locator {
  const locator = refs.get(ref);
  if (!locator) {
    throw new BrowserAutomationError({
      code: "BROWSER_STALE_REF",
      message: "ref is stale; take a fresh snapshot",
      retryable: true,
    });
  }
  return locator;
}

/// Detects whether a just-typed field is an autocomplete combobox (ARIA
/// `role=combobox` or `aria-autocomplete=list|both`). Such fields commonly
/// expose suggestions only as a transient listbox with no stable ref, so the
/// reliable way to pick a suggestion is the keyboard (ArrowDown+Enter).
async function autocompleteCommitMode(locator: Locator): Promise<"arrow_enter" | "none"> {
  try {
    const isAutocomplete = await locator.evaluate((element) => {
      const role = (element.getAttribute("role") ?? "").toLowerCase();
      const autocomplete = (element.getAttribute("aria-autocomplete") ?? "").toLowerCase();
      return role === "combobox" || autocomplete === "list" || autocomplete === "both";
    });
    return isAutocomplete ? "arrow_enter" : "none";
  } catch {
    return "none";
  }
}

function requireRefOrSelector(
  page: Page,
  refs: Map<string, Locator>,
  ref: string | undefined,
  selector: string | undefined,
  kind: string,
): Locator {
  if (ref?.trim()) {
    return requireRef(refs, ref.trim());
  }
  if (selector?.trim()) {
    return page.locator(selector.trim()).first();
  }
  throw new BrowserAutomationError({
    code: "BROWSER_INVALID_REQUEST",
    message: `${kind} requires ref or selector`,
    retryable: false,
  });
}

function buildPageEvaluator(_fnText: string): (args: { fnBody: string; timeoutMs: number }) => unknown {
  return new Function(
    "args",
    `
      "use strict";
      var fnBody = args.fnBody, timeoutMs = args.timeoutMs;
      var candidate = eval("(" + fnBody + ")");
      var result = typeof candidate === "function" ? candidate() : candidate;
      if (result && typeof result.then === "function") {
        return Promise.race([
          result,
          new Promise(function(_, reject) {
            setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);
          })
        ]);
      }
      return result;
    `,
  ) as never;
}

function buildElementEvaluator(
  _fnText: string,
): (element: Element, args: { fnBody: string; timeoutMs: number }) => unknown {
  return new Function(
    "element",
    "args",
    `
      "use strict";
      var fnBody = args.fnBody, timeoutMs = args.timeoutMs;
      var candidate = eval("(" + fnBody + ")");
      var result = typeof candidate === "function" ? candidate(element) : candidate;
      if (result && typeof result.then === "function") {
        return Promise.race([
          result,
          new Promise(function(_, reject) {
            setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);
          })
        ]);
      }
      return result;
    `,
  ) as never;
}
