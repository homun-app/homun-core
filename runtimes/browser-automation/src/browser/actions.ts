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
      } else if (explicit !== "none") {
        const outcome = await confirmAutocomplete(page, locator, action.text, timeout);
        committedOption = outcome.committed;
        suggestions = outcome.options.length ? outcome.options : undefined;
      }
      await page.waitForTimeout(800);
      return { ok: true, url: page.url(), committedOption, suggestions };
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

/// Selects `best` among the open suggestions, robust to BOTH mouse-driven and
/// keyboard-only widgets:
///   A. click the option element (fires the site's onSelect) — verify;
///   B. keyboard-navigate to the option's position then Enter — verify;
///   C. last resort: a single ArrowDown+Enter (the top suggestion).
/// Verification after each step means we don't double-act when the first works,
/// and we don't give up when a keyboard-only list ignored the click.
async function selectSuggestion(
  page: Page,
  input: Locator,
  optionLocator: Locator,
  best: { text: string; index: number; locator: Locator },
  optionCount: number,
  timeout: number,
): Promise<boolean> {
  try {
    await best.locator.click({ timeout });
    await page.waitForTimeout(120);
    if (await selectionConfirmed(input, optionLocator, best.text)) return true;
  } catch {
    /* keyboard-only widget or stale — try the keyboard */
  }
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
async function trySelectFromOpenList(
  page: Page,
  input: Locator,
  optionLocator: Locator,
  target: string,
  timeout: number,
): Promise<{ committed?: string; options: string[]; appeared: boolean }> {
  try {
    await optionLocator.first().waitFor({ state: "visible", timeout: Math.min(timeout, 1800) });
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
  if (best.score >= 1 || options.length === 1) {
    const confirmed = await selectSuggestion(page, input, optionLocator, best, options.length, timeout);
    return { committed: confirmed ? best.text : undefined, options: optionTexts, appeared: true };
  }
  // Dropdown shown, but nothing relates to the target → ambiguous, don't guess.
  return { options: optionTexts, appeared: true };
}

/// Owns the autocomplete protocol so the MODEL doesn't have to: the caller types
/// the full value once; here we (1) try to select a matching suggestion; (2) if
/// no dropdown opened for the full value, retype a PREFIX to coax the typeahead
/// and match the full value against it; (3) otherwise leave the full value (plain
/// field). Scoped to genuine combobox inputs so plain fields pay no popup-wait.
async function confirmAutocomplete(
  page: Page,
  input: Locator,
  typed: string,
  timeout: number,
): Promise<{ committed?: string; options: string[] }> {
  const { isCombobox, listboxId } = await inputComboboxInfo(input);
  if (!isCombobox) {
    return { options: [] }; // plain field — leave the text as-is, no wait
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
