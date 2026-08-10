import type { Locator, Page } from "playwright-core";
import { BrowserAutomationError } from "../contracts.js";
import type { BrowserObservationMode } from "./snapshot.js";

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
const MAX_CHAT_BUNDLE_ACTIONS = 4;
const DEFAULT_HOLD_MS = 3_000;
const MAX_HOLD_MS = 20_000;

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
  generation?: number;
  fingerprint?: string;
  observationMode?: BrowserObservationMode;
  // Machine-derived payment floor refs from the embedded post-action snapshot
  // (present whenever the action requested a fresh snapshot). Raise-only.
  paymentFloorRefs?: string[];
  // Machine-only focus-context signal from the embedded post-action snapshot
  // (present whenever the action requested a fresh snapshot). See
  // computeFocusPaymentContext in snapshot.ts.
  focusPaymentContext?: boolean;
  filledRefs?: string[];
  failedRefs?: Array<{ ref: string; error: string }>;
  batchResults?: Array<BrowserActionResult | { ok: false; error: string }>;
  completedActions?: number;
  unexecutedActions?: BrowserActRequest[];
  result?: unknown;
  /** For "type": the autocomplete suggestion that was selected, if any. */
  committedOption?: string;
  /** For "type": the visible suggestion options observed (for disambiguation). */
  suggestions?: string[];
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
      // When false (the default), skip the automatic confirmAutocomplete() call
      // after typing. The dropdown (if any) stays open so the model can inspect
      // it in the post-action snapshot and click the desired option itself.
      // Set true to enable auto-confirmation (rarely reliable — prefer manual click).
      autoComplete?: boolean;
      auto_complete?: boolean;
    }
  | {
      // Higher-level "widget work in the system" (vs the model driving a calendar click-by-click):
      // open the date control's calendar and set it to `date`, deterministically, in ONE action —
      // the sidecar reads the month heading, navigates prev/next to the target month, and clicks the
      // day cell. Collapses ~4 model round-trips (open → navigate month → click day) into one.
      kind: "set_date";
      targetId: string;
      ref?: string;
      selector?: string;
      // Target date as ISO `YYYY-MM-DD` (the model has already resolved it via resolve_datetime).
      date: string;
      timeoutMs?: number;
    }
  | {
      // Higher-level "widget work in the system": open a time control and pick `time` (HH:MM) — the
      // sidecar clicks the control, then the matching time option/button (closest available if the
      // exact minute isn't offered). One action instead of the model hunting the time list.
      kind: "set_time";
      targetId: string;
      ref?: string;
      selector?: string;
      // Target time as 24h `HH:MM` (e.g. "08:00").
      time: string;
      timeoutMs?: number;
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
      kind: "hold";
      targetId: string;
      ref?: string;
      selector?: string;
      // How long to keep the pointer pressed (ms). Press-and-hold human
      // challenges ("tieni premuto") need a sustained press; default ~3s.
      durationMs?: number;
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
      timeoutMs?: number;
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
  assertChatBundle(action);
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
      // The chat browser_act schema is FLAT ({kind, ref, text/value}) — one micro-action —
      // while the sidecar fill contract is an array of {ref, value} fields. A flat fill used
      // to dead-end here (action.fields undefined → "cannot iterate undefined" → silent
      // BROWSER_ACTION_FAILED), so kind=fill never worked from the chat loop. Coerce the flat
      // shape into a single field so both forms execute. `text` is the chat schema's value slot.
      const fields = resolveFillFields(action as unknown as { fields?: BrowserFormField[] } & Record<string, unknown>);
      for (const field of fields) {
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
      // Clear robustly BEFORE typing — relying on select-all+overwrite let weak
      // widgets append (the "Roma TerminiRoma Termini" bug). clear() focuses,
      // selects, deletes and fires input events; we fall back to select-all+Delete.
      await clearField(locator, timeout);
      await locator.type(action.text, { delay: action.slowly ? 75 : 20 });

      // Confirmation strategy. Explicit `commit`/`submit` win; otherwise OBSERVE
      // the page: if typing opened a suggestion popup, pick the matching option.
      // This is the part naive flows miss — they decide up-front from the input's
      // ARIA attributes (which most sites omit) and so never select, then keep
      // typing. We instead look at the suggestions that actually appeared.
      const explicit = action.commit ?? (action.submit ? "enter" : undefined);
      let committedOption: string | undefined;
      let suggestions: string[] | undefined;
      if (explicit === "enter") {
        await locator.press("Enter", { timeout });
      } else if (explicit === "arrow_enter") {
        await page.waitForTimeout(400); // let the suggestion list render
        await locator.press("ArrowDown", { timeout });
        await page.waitForTimeout(120);
        await locator.press("Enter", { timeout });
      } else if (explicit !== "none" && resolveAutoComplete(action)) {
        const outcome = await confirmAutocomplete(page, locator, action.text, timeout);
        committedOption = outcome.committed;
        suggestions = outcome.options.length ? outcome.options : undefined;
      }
      await page.waitForTimeout(800);
      return { ok: true, url: page.url(), committedOption, suggestions };
    }
    case "set_date": {
      const locator = requireRefOrSelector(page, refs, action.ref, action.selector, "set_date");
      const outcome = await driveDatePicker(page, locator, action.date, actionTimeout(action.timeoutMs));
      if (!outcome.ok) {
        // Throw a clear, actionable error (consistent with other action failures): the gateway turns
        // it into "Action failed: …" so the model can fall back to driving the calendar by hand.
        throw new Error(
          `set_date failed: ${outcome.error ?? "could not set the date"}. Fall back to manual clicks: ` +
            `click the date field, use the next/previous-month arrows to reach the month, then click the day.`,
        );
      }
      await page.waitForTimeout(400);
      return { ok: true, url: page.url(), committedOption: outcome.committed };
    }
    case "set_time": {
      const locator = requireRefOrSelector(page, refs, action.ref, action.selector, "set_time");
      const outcome = await driveTimePicker(page, locator, action.time, actionTimeout(action.timeoutMs));
      if (!outcome.ok) {
        throw new Error(
          `set_time failed: ${outcome.error ?? "could not set the time"}. Fall back to manual clicks: ` +
            `click the time field, then click the time option closest to what you want.`,
        );
      }
      await page.waitForTimeout(300);
      return { ok: true, url: page.url(), committedOption: outcome.committed };
    }
    case "press": {
      await page.keyboard.press(normalizeKeyName(action.key), { delay: nonNegativeDelay(action.delayMs) });
      return { ok: true, url: page.url() };
    }
    case "press_key": {
      await page.keyboard.press(normalizeKeyName(action.text), { delay: nonNegativeDelay(action.delayMs) });
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
    case "hold": {
      // Press-and-hold ("tieni premuto") human challenge: move the real pointer
      // onto the element, press, keep it down for a sustained (slightly jittered)
      // duration, then release. Uses page.mouse so the down/up are genuine pointer
      // events held over time — locator.click() only taps and never satisfies these.
      const locator = requireRefOrSelector(page, refs, action.ref, action.selector, "hold");
      const timeout = actionTimeout(action.timeoutMs);
      await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => undefined);
      const box = await locator.boundingBox({ timeout });
      if (!box) {
        throw new BrowserAutomationError({
          code: "BROWSER_HOLD_NO_TARGET",
          message: "hold target has no visible bounding box",
          retryable: true,
        });
      }
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      try {
        await page.waitForTimeout(holdDuration(action.durationMs));
      } finally {
        await page.mouse.up();
      }
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
        // A scroll must NEVER click a control — this used to `.click()` the ref,
        // which let a "scroll" on a floored Pay button submit ungated (Critical B).
        // Bring the element into view only, exactly like scrollIntoView/scroll_into_view.
        await requireRef(refs, action.ref)
          .scrollIntoViewIfNeeded({ timeout: actionTimeout(action.timeoutMs) })
          .catch(() => undefined);
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
      const unexecutedActions: BrowserActRequest[] = [];
      let completedActions = 0;
      for (const [index, nested] of action.actions.entries()) {
        try {
          batchResults.push(await executeActionUnchecked(page, refs, withTarget(action.targetId, nested), depth + 1));
          completedActions += 1;
        } catch (error) {
          const normalized = normalizeActionError(error, nested.kind);
          batchResults.push({ ok: false, error: `${normalized.code}: ${normalized.message}` });
          unexecutedActions.push(...action.actions.slice(index + 1));
          if (action.stopOnError !== false) {
            break;
          }
        }
      }
      return { ok: true, url: page.url(), batchResults, completedActions, unexecutedActions };
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

function isChatBundle(action: BrowserActRequest): boolean {
  const raw = action as Record<string, unknown>;
  return Boolean(raw.chatBundle ?? raw.chat_bundle);
}

function assertChatBundle(action: BrowserActRequest): void {
  if (action.kind !== "batch" || !isChatBundle(action)) {
    return;
  }
  if (action.actions.length > MAX_CHAT_BUNDLE_ACTIONS) {
    throw new BrowserAutomationError({
      code: "BROWSER_CHAT_BUNDLE_TOO_LARGE",
      message: "chat browser bundles may contain at most 4 actions",
      retryable: false,
    });
  }
  if (action.actions.some((nested) => nested.kind === "batch")) {
    throw new BrowserAutomationError({
      code: "BROWSER_NESTED_BATCH_REJECTED",
      message: "chat browser bundles must be flat",
      retryable: false,
    });
  }
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

/// Resolve the fields to fill from either contract shape: the canonical array
/// (`fields:[{ref,value}]`) OR the flat chat micro-action (`{ref, text|value, type}`).
/// The flat form is what the chat browser_act schema produces; without this the flat
/// fill silently failed. Throws a clear contract error when neither shape is present,
/// instead of the opaque "cannot iterate undefined" the bare `for…of` raised before.
function resolveFillFields(action: { fields?: BrowserFormField[] } & Record<string, unknown>): BrowserFormField[] {
  if (Array.isArray(action.fields) && action.fields.length > 0) {
    return action.fields;
  }
  const ref = typeof action.ref === "string" ? action.ref.trim() : "";
  if (ref) {
    const raw = action.value ?? action.text;
    const value =
      typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? raw : "";
    const type = typeof action.type === "string" ? action.type : undefined;
    return [{ ref, value, type }];
  }
  throw new BrowserAutomationError({
    code: "BROWSER_INVALID_REQUEST",
    message: "fill requires either 'fields' (array of {ref,value}) or a flat 'ref' with 'text'/'value'",
    retryable: false,
  });
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

/// Resolves the autoComplete flag from either camelCase (autoComplete) or
/// snake_case (auto_complete), matching the SnapshotAfterAction dual-name
/// convention. Default false: autocomplete is NOT confirmed automatically;
/// the dropdown stays open so the model can inspect it and click the desired
/// option from the post-action snapshot. Set auto_complete=true to enable
/// auto-confirmation (rarely reliable — prefer the manual click).
export function resolveAutoComplete(action: { autoComplete?: boolean; auto_complete?: boolean }): boolean {
  if (action.autoComplete === true || action.auto_complete === true) return true;
  return false;
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

function holdDuration(value: number | undefined): number {
  const base = Number.isFinite(value) ? Math.floor(value ?? DEFAULT_HOLD_MS) : DEFAULT_HOLD_MS;
  const bounded = Math.max(500, Math.min(base, MAX_HOLD_MS));
  // Small jitter so the hold isn't suspiciously exact (human presses vary).
  return bounded + Math.floor(Math.random() * 400);
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
  // Fase 2.2: the model may include a trailing `*` on new refs (e.g. `e3*`);
  // strip it before the lookup — locator maps are keyed on bare IDs.
  const bare = ref.replace(/\*$/, "");
  const locator = refs.get(bare);
  if (!locator) {
    throw new BrowserAutomationError({
      code: "BROWSER_STALE_REF",
      message: "ref is stale; take a fresh snapshot",
      retryable: true,
    });
  }
  return locator;
}

const MAX_SUGGESTIONS = 8;

/// Normalizes text for matching: strip diacritics, lowercase, collapse spaces.
/// "Milano Centrale" and "MILANO  CENTRALE" and "milàno centrale" all align.
function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/// True only on RELIABLE combobox signals tied to the typed field. We gate the
/// auto-select on this so plain text fields never pay a popup-wait, and so we
/// never misfire on a real page's unrelated list items. Suggestion lists that
/// are plain clickable buttons (no ARIA) are handled by the model clicking the
/// visible ref instead — they already appear in the snapshot.
async function inputComboboxInfo(
  input: Locator,
): Promise<{ isCombobox: boolean; listboxId: string | null }> {
  try {
    return await input.evaluate((element) => {
      const role = (element.getAttribute("role") ?? "").toLowerCase();
      const ac = (element.getAttribute("aria-autocomplete") ?? "").toLowerCase();
      const expanded = element.getAttribute("aria-expanded");
      const controls = element.getAttribute("aria-controls") || element.getAttribute("aria-owns");
      const isCombobox =
        role === "combobox" ||
        ac === "list" ||
        ac === "both" ||
        expanded === "true" ||
        expanded === "false" || // present-but-collapsed still signals a combobox
        Boolean(controls) ||
        element.hasAttribute("list");
      const listboxId = (controls ?? "").split(/\s+/).find(Boolean) ?? null;
      return { isCombobox, listboxId };
    });
  } catch {
    return { isCombobox: false, listboxId: null };
  }
}

/// Has the suggestion actually been applied? A real autocomplete sets the input
/// to the canonical value and/or closes the popup; either is a success signal.
async function selectionConfirmed(
  input: Locator,
  optionLocator: Locator,
  targetText: string,
): Promise<boolean> {
  try {
    const value = normalizeForMatch(await input.inputValue());
    if (value && value === normalizeForMatch(targetText)) return true;
  } catch {
    /* not an <input> (e.g. contenteditable) — fall back to popup-closed check */
  }
  try {
    return !(await optionLocator.first().isVisible());
  } catch {
    return true; // detached/closed
  }
}

/// When an option element (typically a <li>) contains a nested interactive
/// element (button, anchor), the click handler is often on that INNER element.
/// Clicking the outer <li> does nothing — e.g. Trenitalia's station picker
/// renders `<li role="option"><button class="el-choice">…</button></li>`.
/// Returns the nested clickable locator when present, the original otherwise.
async function resolveClickTarget(locator: Locator): Promise<Locator> {
  try {
    const inner = locator.locator('button, a[href], [role="button"]');
    if (await inner.first().isVisible({ timeout: 200 })) {
      return inner.first();
    }
  } catch {
    /* no nested interactive — fall through to the original locator */
  }
  return locator;
}

/// Selects `best` among the open suggestions, robust to BOTH mouse-driven and
/// keyboard-only widgets:
///   A. click the option element (fires the site's onSelect) — verify;
///   B. keyboard-navigate to the option's position then Enter — verify;
///   C. last resort: a single ArrowDown+Enter (the top suggestion).
/// Verification after each step means we don't double-act when the first works,
/// and we don't give up when a keyboard-only list ignored the click.
//
// Some real-world dropdowns (Trenitalia's station picker) render
//   <li role="option"><button class="el-choice">Milano Centrale</button></li>
// where the click handler is on the INNER <button>, not on the <li>. Clicking
// the <li> does nothing. `resolveClickTarget` detects this and redirects the
// click to the nested interactive element.
async function selectSuggestion(
  page: Page,
  input: Locator,
  optionLocator: Locator,
  best: { text: string; index: number; locator: Locator },
  optionCount: number,
  timeout: number,
  // ARIA comboboxes swallow Enter (they select the highlighted option, no form submit), so the
  // keyboard fallback is safe there. On a NON-ARIA input Enter submits the enclosing form — a
  // committing action the model never requested and the payment gate never judged — so the
  // non-ARIA fallback passes `false` and we click-only: a mis-scored row is left unselected rather
  // than risking a submit.
  allowKeyboardCommit = true,
): Promise<boolean> {
  try {
    const clickTarget = await resolveClickTarget(best.locator);
    await clickTarget.click({ timeout });
    await page.waitForTimeout(120);
    if (await selectionConfirmed(input, optionLocator, best.text)) return true;
  } catch {
    /* keyboard-only widget or stale — try the keyboard (only when Enter can't submit a form) */
  }
  if (!allowKeyboardCommit) return false;
  try {
    await input.click({ timeout }).catch(() => undefined);
    const steps = Math.min(best.index + 1, optionCount);
    for (let i = 0; i < steps; i += 1) {
      await input.press("ArrowDown", { timeout });
      await page.waitForTimeout(40);
    }
    await input.press("Enter", { timeout });
    await page.waitForTimeout(120);
    if (await selectionConfirmed(input, optionLocator, best.text)) return true;
  } catch {
    /* ignore — try the final fallback */
  }
  try {
    await input.press("ArrowDown", { timeout });
    await page.waitForTimeout(60);
    await input.press("Enter", { timeout });
    await page.waitForTimeout(120);
    return await selectionConfirmed(input, optionLocator, best.text);
  } catch {
    return false;
  }
}

/// Clears an editable field reliably. select-all+overwrite is not enough on some
/// custom widgets (they append) — clear() focuses, selects, deletes and fires
/// input events; we fall back to select-all+Delete only if clear() is unsupported.
async function clearField(input: Locator, timeout: number): Promise<void> {
  try {
    await input.clear({ timeout });
  } catch {
    try {
      await input.click({ timeout });
      await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout });
      await input.press("Delete", { timeout });
    } catch {
      /* best effort — leave whatever is there */
    }
  }
}

/// A short prefix that reliably triggers a typeahead: the FIRST WORD for a
/// multi-word value ("Roma Termini" -> "Roma"), else the first few letters for a
/// single word. null when the value is already too short to shorten.
function autocompletePrefix(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const firstWord = v.split(/\s+/)[0];
  if (firstWord.length < v.length) return firstWord;
  if (v.length > 4) return v.slice(0, 4);
  return null;
}

/// With a suggestion dropdown possibly open for the field's CURRENT content,
/// wait briefly, read the visible options, and select the one best matching
/// `target` (the FULL intended value — even when we only typed a prefix to open
/// the list). `appeared` distinguishes "no dropdown at all" from "dropdown shown
/// but nothing matched", which the caller uses to decide whether to retry.
///
/// `minScore` gates how confident the best match must be before we commit it.
/// Default 1 keeps the ARIA combobox path's original behavior (any relation at
/// all, or a single visible option regardless of relation — a real ARIA
/// combobox is itself a strong enough signal). The non-ARIA fallback passes 3
/// (exact or option-startsWith-target) because there is no such reliable
/// signal there — we must not guess on unrelated page chrome. In both cases a
/// single visible option only auto-commits if it actually relates to the
/// target (score >= 1); at minScore<=1 that's implied unconditionally (any
/// single option, matching the old behavior byte-for-byte), otherwise it's an
/// explicit floor so the single-option shortcut can't bypass the confidence bar.
///
/// `waitMs` caps how long we wait for a suggestion row to render before giving
/// up. Default = `min(timeout, 1800)` (the ARIA path, where a combobox has
/// promised a list). The non-ARIA fallback passes a SHORT wait (~500ms): it
/// runs on EVERY `type` into a plain field, most of which have no typeahead at
/// all, so it must not add a ~1.8s stall to ordinary form typing.
async function trySelectFromOpenList(
  page: Page,
  input: Locator,
  optionLocator: Locator,
  target: string,
  timeout: number,
  minScore = 1,
  waitMs?: number,
  allowKeyboardCommit = true,
): Promise<{ committed?: string; options: string[]; appeared: boolean }> {
  try {
    await optionLocator.first().waitFor({ state: "visible", timeout: waitMs ?? Math.min(timeout, 1800) });
  } catch {
    return { options: [], appeared: false };
  }
  const handles = await optionLocator.all();
  const options: Array<{ text: string; locator: Locator }> = [];
  for (const handle of handles) {
    if (options.length >= MAX_SUGGESTIONS) break;
    try {
      if (!(await handle.isVisible())) continue;
      const text = (await handle.innerText()).replace(/\s+/g, " ").trim();
      if (text) options.push({ text, locator: handle });
    } catch {
      /* stale handle — skip */
    }
  }
  if (options.length === 0) {
    return { options: [], appeared: false };
  }

  const want = normalizeForMatch(target);
  const scored = options
    .map((option, index) => {
      const normalized = normalizeForMatch(option.text);
      let score = 0;
      if (normalized === want) score = 4;
      else if (normalized.startsWith(want)) score = 3;
      else if (want.startsWith(normalized)) score = 2; // option is the canonical short form
      else if (normalized.includes(want)) score = 1;
      return { ...option, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const optionTexts = options.map((option) => option.text);
  const best = scored[0];
  const singleOptionOk = options.length === 1 && (minScore <= 1 || best.score >= 1);
  if (best.score >= minScore || singleOptionOk) {
    const confirmed = await selectSuggestion(page, input, optionLocator, best, options.length, timeout, allowKeyboardCommit);
    return { committed: confirmed ? best.text : undefined, options: optionTexts, appeared: true };
  }
  // Dropdown shown, but nothing relates to the target → ambiguous, don't guess.
  return { options: optionTexts, appeared: true };
}

// Bounded, visible-only set of plausible suggestion rows for the non-ARIA fallback below.
// Deliberately narrow — explicit option roles, or the FULL-word class-name conventions real
// typeahead widgets use (`suggestion`/`autocomplete`/`typeahead`) as `li` children. Notably it
// does NOT use `[class*="auto"]` (which matches Tailwind utility classes like `mx-auto`,
// `overflow-auto` on any `ul`) nor a bare `[role="listbox"] *` (which would match any descendant of
// any listbox on the page) — both would let it click unrelated page chrome.
//
// Trenitalia-style dropdowns render `<li role="option"><button class="el-choice">…</button></li>`
// where the click handler lives on the INNER button, not on the <li>. Including bare
// `[role="option"]` would match the <li> and clicking it would NOT trigger the station selection.
// The button-targeting selectors below ensure we find and click the actual interactive element.
const NON_ARIA_OPTION_SELECTOR = [
  '[role="option"]',                         // li[role=option] — legacy / plain option
  '[role="listbox"] li',                     // li inside a listbox
  'ul[class*="suggestion" i] li',            // suggestion-list convention
  'ul[class*="autocomplete" i] li',          // autocomplete-list convention
  'ul[class*="typeahead" i] li',             // typeahead-list convention
  '[class*="suggestion" i] li',              // loose suggestion container
  '[class*="typeahead" i] li',               // loose typeahead container
  // Nested clickable elements inside options (Trenitalia et al.)
  '[role="option"] button',                  // button inside li[role=option]
  'button.el-choice',                        // Trenitalia-specific choice button
  '[role="listbox"] button',                 // generic button inside a listbox
  '[class*="option" i] button',              // button inside an option-like container
  "li[role='option'] > *",                   // any direct child of an option li
].join(', ');

/// Owns the autocomplete protocol so the MODEL doesn't have to: the caller types
/// the full value once; here we (1) try to select a matching suggestion; (2) if
/// no dropdown opened for the full value, retype a PREFIX to coax the typeahead
/// and match the full value against it; (3) otherwise leave the full value (plain
/// field). Scoped to genuine combobox inputs so plain fields pay no popup-wait.
// Playwright's keyboard vocabulary is exact ("Enter", "Escape", "ArrowDown"), but models write the
// equally valid everyday names ("Return", "Esc", "Down"). Passing those straight through threw
// `Unknown key: "Return"` — and because it happened on the SUBMIT of a filled search form, the search
// never ran and the model kept clicking around trying to make results appear. Canonicalize the common
// aliases (per segment, so "Control+Return" works too) and leave anything unknown untouched so
// Playwright still reports a genuine bad key.
const KEY_ALIASES = new Map<string, string>([
  ["return", "Enter"],
  ["enter", "Enter"],
  ["esc", "Escape"],
  ["escape", "Escape"],
  ["del", "Delete"],
  ["delete", "Delete"],
  ["ins", "Insert"],
  ["space", "Space"],
  ["spacebar", "Space"],
  ["up", "ArrowUp"],
  ["down", "ArrowDown"],
  ["left", "ArrowLeft"],
  ["right", "ArrowRight"],
  ["arrowup", "ArrowUp"],
  ["arrowdown", "ArrowDown"],
  ["arrowleft", "ArrowLeft"],
  ["arrowright", "ArrowRight"],
  ["ctrl", "Control"],
  ["control", "Control"],
  ["cmd", "Meta"],
  ["command", "Meta"],
  ["meta", "Meta"],
  ["alt", "Alt"],
  ["option", "Alt"],
  ["shift", "Shift"],
  ["tab", "Tab"],
  ["backspace", "Backspace"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
]);

export function normalizeKeyName(key: string): string {
  const raw = (key ?? "").trim();
  if (!raw) {
    return raw;
  }
  return raw
    .split("+")
    .map((segment) => {
      const token = segment.trim();
      if (!token) {
        return token;
      }
      return KEY_ALIASES.get(token.toLowerCase()) ?? token;
    })
    .join("+");
}

async function confirmAutocomplete(
  page: Page,
  input: Locator,
  typed: string,
  timeout: number,
): Promise<{ committed?: string; options: string[] }> {
  const { isCombobox, listboxId } = await inputComboboxInfo(input);
  if (!isCombobox) {
    // Non-ARIA fallback: real-world typeaheads (e.g. Trenitalia's station
    // picker) often render a suggestion list with zero ARIA wiring at all, so
    // inputComboboxInfo's signals never fire. We still must not GUESS — reuse
    // the same open-list scanning machinery as the ARIA path, but gated by a
    // much stricter match (minScore=3) so we only ever click a visible row
    // that plainly relates to what was just typed, never unrelated page
    // chrome. No prefix-retry here (unlike the ARIA path below): if nothing
    // strong enough shows up in response to the full typed value, we simply
    // leave the field holding the full text — current, safe behavior.
    const nonAriaOptionLocator = page.locator(NON_ARIA_OPTION_SELECTOR).locator("visible=true");
    // Wait up to 1500ms for the suggestion list: this probe runs on every non-ARIA `type`, but
    // real-world typeaheads (e.g. Trenitalia's station picker) render asynchronously and 500ms was
    // too short — the list appeared just after the probe gave up, so the auto-select missed its
    // window and the dropdown auto-closed before the model could act. 1500ms is long enough for
    // even slow AJAX suggestion endpoints without noticeably stalling ordinary form typing.
    // `allowKeyboardCommit=false`: a non-ARIA input's Enter submits the enclosing form, so we
    // click-only — never risk a submit the model didn't ask for (and the payment gate never
    // judged) on a mis-scored row.
    const fallback = await trySelectFromOpenList(page, input, nonAriaOptionLocator, typed, timeout, 3, 1500, false);
    if (fallback.committed) return { committed: fallback.committed, options: fallback.options };
    return { options: fallback.options };
  }

  const optionLocator = listboxId
    ? page.locator(`[id="${listboxId.replace(/["\\]/g, "\\$&")}"]`).locator('[role="option"], li')
    : page.locator('[role="listbox"] [role="option"], [role="option"]');

  // 1) Full value already typed by the caller — try to select from its dropdown.
  let result = await trySelectFromOpenList(page, input, optionLocator, typed, timeout);
  if (result.committed) return { committed: result.committed, options: result.options };
  if (result.appeared) return { options: result.options }; // shown but ambiguous

  // 2) No dropdown for the full value: some widgets only suggest on a PARTIAL
  //    query. Type a prefix to open the list, then match the FULL value.
  const prefix = autocompletePrefix(typed);
  if (prefix) {
    await clearField(input, timeout);
    await input.type(prefix, { delay: 40 });
    result = await trySelectFromOpenList(page, input, optionLocator, typed, timeout);
    if (result.committed) return { committed: result.committed, options: result.options };
    if (result.appeared) {
      // Suggestions appeared but none matched: restore the full typed value so we
      // don't leave just the prefix in the field.
      await clearField(input, timeout);
      await input.type(typed, { delay: 20 });
      return { options: result.options };
    }
  }

  // 3) Genuinely no suggestions (or the prefix attempt left only the prefix):
  //    ensure the field holds the FULL value, with a keyboard last-resort for a
  //    combobox that selects only via the keyboard.
  await clearField(input, timeout);
  await input.type(typed, { delay: 20 });
  try {
    await optionLocator.first().waitFor({ state: "visible", timeout: 800 });
    await input.press("ArrowDown", { timeout });
    await page.waitForTimeout(120);
    await input.press("Enter", { timeout });
  } catch {
    /* leave the full typed value as-is */
  }
  return { options: [] };
}

// Month-name aliases (IT + EN, full + common abbreviations) for reading a calendar's month heading.
const CAL_MONTHS: readonly (readonly string[])[] = [
  ["gennaio", "january", "gen", "jan"],
  ["febbraio", "february", "feb"],
  ["marzo", "march", "mar"],
  ["aprile", "april", "apr"],
  ["maggio", "may", "mag"],
  ["giugno", "june", "giu", "jun"],
  ["luglio", "july", "lug", "jul"],
  ["agosto", "august", "ago", "aug"],
  ["settembre", "september", "set", "sep"],
  ["ottobre", "october", "ott", "oct"],
  ["novembre", "november", "nov"],
  ["dicembre", "december", "dic", "dec"],
];

/// Parse "<MonthName> <Year>" (e.g. "Agosto 2026", "August 2026") → {month:0-11, year}. This is
/// calendar-widget structure, not user-intent interpretation: we read the month the widget is
/// showing to navigate it deterministically.
function parseMonthYear(text: string): { month: number; year: number } | null {
  const t = (text || "").toLowerCase();
  const yearMatch = t.match(/(20\d\d)/);
  if (!yearMatch) return null;
  const year = Number(yearMatch[1]);
  for (let i = 0; i < 12; i += 1) {
    if (CAL_MONTHS[i].some((name) => new RegExp(`\\b${name}`).test(t))) {
      return { month: i, year };
    }
  }
  return null;
}

/// Deterministically drive a calendar date picker to `isoDate` (YYYY-MM-DD): open it via `control`,
/// read the displayed month/year heading, click prev/next until the target month, then click the day
/// cell. Generic over the common pattern (a `[role=grid]`/table of day cells + a month heading +
/// prev/next buttons). Returns `ok:false` (never throws) when the structure isn't recognizable, so
/// the caller can fall back to the model driving the calendar with plain clicks. This is the
/// "widget work in the system": one action replaces ~4 model round-trips (open, navigate, click day).
async function driveDatePicker(
  page: Page,
  control: Locator,
  isoDate: string,
  timeout: number,
): Promise<{ ok: boolean; committed?: string; error?: string }> {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec((isoDate || "").trim());
  if (!iso) return { ok: false, error: `set_date needs an ISO date YYYY-MM-DD, got "${isoDate}"` };
  const targetYear = Number(iso[1]);
  const targetMonth = Number(iso[2]) - 1; // 0-11
  const targetDay = Number(iso[3]);
  const targetIndex = targetYear * 12 + targetMonth;

  const controlText = async () =>
    ((await control.innerText().catch(() => "")) || (await control.getAttribute("value").catch(() => "")) || "")
      .replace(/\s+/g, " ")
      .trim();
  const before = await controlText();

  await control.click({ timeout });
  const grid = page
    .locator('[role="grid"], [class*="calendar" i] table, [class*="datepicker" i], .DayPicker, [class*="react-datepicker" i]')
    .first();
  try {
    await grid.waitFor({ state: "visible", timeout: Math.min(timeout, 2500) });
  } catch {
    return { ok: false, error: "no calendar appeared after clicking the date control" };
  }

  // Read the month/year the calendar is currently showing (heading first, then the grid's own name).
  const currentMonthYear = async (): Promise<{ month: number; year: number } | null> => {
    const headings = grid.locator("xpath=..").locator('h1,h2,h3,[role="heading"],[class*="caption" i],[class*="title" i]');
    const n = await headings.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 6); i += 1) {
      const parsed = parseMonthYear(await headings.nth(i).innerText().catch(() => ""));
      if (parsed) return parsed;
    }
    const gridName = (await grid.getAttribute("aria-label").catch(() => null)) || "";
    return parseMonthYear(gridName) ?? parseMonthYear(await grid.locator("xpath=..").innerText().catch(() => ""));
  };

  // Navigate to the target month — bounded so an unreadable widget can't loop forever.
  for (let step = 0; step <= 24; step += 1) {
    const cur = await currentMonthYear();
    if (!cur) return { ok: false, error: "could not read the calendar's month/year" };
    const delta = targetIndex - (cur.year * 12 + cur.month);
    if (delta === 0) break;
    if (step === 24) return { ok: false, error: "target month not reached within 24 steps" };
    const wantNext = delta > 0;
    const navBtn = page
      .locator(
        wantNext
          ? '[aria-label*="successiv" i], [aria-label*="next" i], [aria-label*="avanti" i], [class*="next" i][role="button"], button[class*="next" i]'
          : '[aria-label*="precedent" i], [aria-label*="previous" i], [aria-label*="prev" i], [aria-label*="indietro" i], [class*="prev" i][role="button"], button[class*="prev" i]',
      )
      .first();
    if (!(await navBtn.isVisible().catch(() => false))) {
      return { ok: false, error: `no month-${wantNext ? "next" : "prev"} button on the calendar` };
    }
    await navBtn.click({ timeout });
    await page.waitForTimeout(250);
  }

  // Click the day cell for `targetDay` in the current month. Match by accessible NAME (exact) — the
  // robust Playwright way — across the roles calendars use for day cells (gridcell/button/link/cell),
  // scoped to the grid so adjacent-month overflow cells of other months aren't picked. Overflow cells
  // of THIS view are usually disabled/empty; prefer an enabled one.
  const day = String(targetDay);
  const cell = grid
    .getByRole("gridcell", { name: day, exact: true })
    .or(grid.getByRole("button", { name: day, exact: true }))
    .or(grid.getByRole("link", { name: day, exact: true }))
    .first();
  try {
    await cell.click({ timeout });
  } catch {
    return { ok: false, error: `could not click day ${targetDay} in the target month` };
  }
  await page.waitForTimeout(300);

  const after = await controlText();
  return { ok: true, committed: after && after !== before ? after : undefined };
}

/// Deterministically set a time picker to `hhmm` (24h HH:MM): open it via `control`, then click the
/// matching time option/button — or the CLOSEST available time when the exact minute isn't offered
/// (many pickers list only 30-/60-minute slots). Returns `ok:false` (never throws) so the caller can
/// fall back to manual clicks. One action instead of the model hunting the time list.
async function driveTimePicker(
  page: Page,
  control: Locator,
  hhmm: string,
  timeout: number,
): Promise<{ ok: boolean; committed?: string; error?: string }> {
  const parsed = /^(\d{1,2}):(\d{2})$/.exec((hhmm || "").trim());
  if (!parsed) return { ok: false, error: `set_time needs a 24h time HH:MM, got "${hhmm}"` };
  const targetMinutes = Number(parsed[1]) * 60 + Number(parsed[2]);
  const target = `${parsed[1].padStart(2, "0")}:${parsed[2]}`;

  await control.click({ timeout });
  await page.waitForTimeout(500);

  // Exact match first.
  const exact = page
    .getByRole("button", { name: target, exact: true })
    .or(page.getByRole("option", { name: target, exact: true }))
    .first();
  if ((await exact.count().catch(() => 0)) > 0 && (await exact.isVisible().catch(() => false))) {
    await exact.click({ timeout });
    return { ok: true, committed: target };
  }

  // Otherwise pick the CLOSEST offered time (visible option/button whose label is `HH:MM`).
  const opts = page
    .getByRole("button")
    .or(page.getByRole("option"))
    .filter({ hasText: /^\s*\d{1,2}:\d{2}\s*$/ });
  const count = Math.min(await opts.count().catch(() => 0), 200);
  let best: { loc: Locator; diff: number; label: string } | null = null;
  for (let i = 0; i < count; i += 1) {
    const el = opts.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const label = (await el.innerText().catch(() => "")).trim();
    const mm = /^(\d{1,2}):(\d{2})$/.exec(label);
    if (!mm) continue;
    const diff = Math.abs(Number(mm[1]) * 60 + Number(mm[2]) - targetMinutes);
    if (!best || diff < best.diff) best = { loc: el, diff, label };
  }
  if (!best) return { ok: false, error: "no time options appeared in the opened time picker" };
  await best.loc.click({ timeout });
  return { ok: true, committed: best.label };
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
