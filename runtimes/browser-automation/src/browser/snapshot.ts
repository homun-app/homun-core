import type { Frame, Locator, Page } from "playwright-core";

export type BrowserRef = {
  ref: string;
  role: string;
  name: string;
  refsMode?: "aria" | "locator";
};

export type BrowserSnapshot = {
  targetId: string;
  url: string;
  snapshot: string;
  refs: BrowserRef[];
  refLocators: Map<string, Locator>;
  refsMode: "aria" | "locator";
  snapshotFormat: "ai" | "legacy";
  stats: {
    lines: number;
    chars: number;
    refs: number;
  };
  generation: number;
  fingerprint: string;
  observationMode: BrowserObservationMode;
  // Machine-derived floor refs (ADR: browser payment floors). A ref present here
  // can only RAISE the gateway's effective action_class for that action, never
  // lower it. Populated by computePaymentFloorRefs from DOM/frame contracts only.
  paymentFloorRefs: string[];
  // Machine-only: is document.activeElement currently inside a cc-autocomplete
  // form, or a PSP-origin frame? Enter/Return submits the *focused* form, so a
  // ref-less committing action needs this rather than paymentFloorRefs (which
  // is keyed on explicit refs). Never derived from label/text.
  focusPaymentContext: boolean;
};

export type BrowserObservationMode = "interact" | "delta" | "extract";

export type BrowserSnapshotOptions = {
  snapshotFormat?: "ai" | "legacy";
  refsMode?: "aria" | "locator";
  mode?: "efficient";
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  timeoutMs?: number;
  maxChars?: number;
  urls?: boolean;
  observationMode?: BrowserObservationMode;
  previousSnapshot?: string;
  generation?: number;
};

const OBSERVATION_LIMITS: Record<BrowserObservationMode, number> = {
  interact: 6_000,
  delta: 8_000,
  extract: 16_000,
};

// Role grouping follows the OpenClaw browser snapshot contract (MIT) so our
// model-facing snapshots stay compatible with the same observe/act loop.
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const STRUCTURAL_ROLES = new Set([
  "application",
  "directory",
  "document",
  "generic",
  "grid",
  "group",
  "ignored",
  "list",
  "menu",
  "menubar",
  "none",
  "presentation",
  "row",
  "rowgroup",
  "table",
  "tablist",
  "toolbar",
  "tree",
  "treegrid",
]);

const INTERACTIVE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "[role='button']",
  "[contenteditable='true']",
].join(", ");

// Exact PSP host-suffix list (global constraint) — no substring/fuzzy matching,
// only exact host or "*.<suffix>" match against the element's own document origin.
const PSP_HOST_SUFFIXES = [
  "stripe.com",
  "js.stripe.com",
  "checkout.stripe.com",
  "adyen.com",
  "paypal.com",
  "braintreegateway.com",
  "checkout.com",
  "klarna.com",
  "nexi.it",
  "worldline.com",
  "satispay.com",
];

// Roles that can carry a committing action (a plain click/submit, or a
// type-and-submit on a field) and are therefore eligible for the payment
// floor. Deliberately narrower than INTERACTIVE_ROLES: e.g. "checkbox" or
// "slider" cannot themselves submit a payment form.
const FLOOR_ELIGIBLE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "searchbox",
  "spinbutton",
]);

// Per-ref evaluate timeout (ms). Short and explicit: a ref that detached
// between snapshot and evaluation (or a slow/hung frame) must fail fast
// rather than ride Playwright's 30s default, which would blow the gateway's
// per-call sidecar deadline (10s snapshot / 15s act) and kill the warm
// browser session. A timed-out/erroring ref is simply not floored — the
// model's declared class + approval-card gate is the pre-existing fallback.
const PAYMENT_FLOOR_EVAL_TIMEOUT_MS = 1_500;

// Machine-only floor: a committing-capable ref (button/link/textbox/combobox/
// searchbox/spinbutton) is a payment control when its element sits in a
// <form> containing a cc-autocomplete input, OR inside a frame/document whose
// origin is a known PSP host. This NEVER reads visible label/text content —
// only DOM structure, the `autocomplete` attribute contract, and frame/
// document origin. Raise-only: callers use this set to raise an action's
// effective payment class, never to lower it.
//
// Per-ref checks run concurrently (Promise.all) and are individually
// timeboxed — see PAYMENT_FLOOR_EVAL_TIMEOUT_MS — since this runs on every
// observation and sequential awaits here are a hot-path latency cost.
// Output order is the original ref order, not completion order, so callers
// see a deterministic paymentFloorRefs list.
export async function computePaymentFloorRefs(
  refs: BrowserRef[],
  refLocators: Map<string, Locator>,
): Promise<string[]> {
  const eligible = refs.filter((ref) => FLOOR_ELIGIBLE_ROLES.has(ref.role));
  const checks = await Promise.all(
    eligible.map(async (ref) => {
      const locator = refLocators.get(ref.ref);
      if (!locator) {
        return false;
      }
      return locator
        .evaluate(
          (el, pspSuffixes) => {
            const form = el.closest("form");
            const inCcForm = !!form && !!form.querySelector('input[autocomplete^="cc-"]');
            let origin = "";
            try {
              origin = el.ownerDocument.defaultView?.location.origin ?? "";
            } catch {
              origin = "";
            }
            let host = "";
            try {
              host = new URL(origin).hostname;
            } catch {
              host = "";
            }
            const inPspFrame = (pspSuffixes as string[]).some(
              (suffix) => host === suffix || host.endsWith(`.${suffix}`),
            );
            return inCcForm || inPspFrame;
          },
          PSP_HOST_SUFFIXES,
          { timeout: PAYMENT_FLOOR_EVAL_TIMEOUT_MS },
        )
        .catch(() => false);
    }),
  );
  const floored: string[] = [];
  for (let i = 0; i < eligible.length; i++) {
    if (checks[i]) {
      floored.push(eligible[i].ref);
    }
  }
  return floored;
}

// Exact PSP host-suffix predicate, shared by the Playwright-side frame check
// below (frameMatchesPspHost). The in-page evaluate closures (this file's
// browser-context callbacks) cannot call back into Node, so they carry their
// own inline copy of the same one-liner — this exported copy exists so the
// matching rule itself has a single, directly unit-testable definition.
export function hostMatchesPspSuffix(
  host: string,
  suffixes: readonly string[] = PSP_HOST_SUFFIXES,
): boolean {
  if (!host) {
    return false;
  }
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

type FrameFocusProbe = {
  // True iff THIS frame's own document is the one actually holding focus,
  // i.e. document.hasFocus() is true AND document.activeElement is a real
  // (non-iframe-host) element. document.hasFocus() alone is not enough: it
  // is also true on every ANCESTOR frame of the frame that really holds
  // focus (focus containment propagates up the chain), but an ancestor's
  // activeElement there is just the <iframe>/<frame> host element, not the
  // control the user is actually in.
  isFocusedFrame: boolean;
  inCcForm: boolean;
};

const NO_FOCUS_PROBE: FrameFocusProbe = { isFocusedFrame: false, inCcForm: false };

// Frame-aware per-frame probe (mirrors how computePaymentFloorRefs already
// gets frames right via locator.evaluate — this uses frame.evaluate instead,
// since there is no element ref to anchor a locator on here). Wrapped in a
// Promise.race against PAYMENT_FLOOR_EVAL_TIMEOUT_MS so a frozen/detaching
// frame degrades to "not focused" rather than hanging the whole snapshot.
async function probeFrameFocus(frame: Frame): Promise<FrameFocusProbe> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FrameFocusProbe>((resolve) => {
    timer = setTimeout(() => resolve(NO_FOCUS_PROBE), PAYMENT_FLOOR_EVAL_TIMEOUT_MS);
  });
  const evaluated = frame
    .evaluate(() => {
      if (!document.hasFocus()) {
        return { isFocusedFrame: false, inCcForm: false };
      }
      const el = document.activeElement;
      if (!el) {
        return { isFocusedFrame: false, inCcForm: false };
      }
      const tag = el.tagName.toLowerCase();
      if (tag === "iframe" || tag === "frame") {
        // Focus actually lives in a descendant frame's document; this
        // frame is merely an ancestor of the focused one.
        return { isFocusedFrame: false, inCcForm: false };
      }
      const form = el.closest("form");
      const inCcForm = !!form && !!form.querySelector('input[autocomplete^="cc-"]');
      return { isFocusedFrame: true, inCcForm };
    })
    .catch(() => NO_FOCUS_PROBE);
  try {
    return await Promise.race([evaluated, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Playwright-side (no evaluate needed): does this frame's own document
// origin match a known PSP host? Only meaningful when paired with
// isFocusedFrame — a PSP frame sitting elsewhere on the page, not holding
// focus, must never floor an unrelated Enter.
function frameMatchesPspHost(frame: Frame): boolean {
  let url = "";
  try {
    url = frame.url();
  } catch {
    return false;
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return hostMatchesPspSuffix(host);
}

// Machine-only: is the currently-focused element — in ANY frame, including a
// cross-origin PSP iframe (the standard integration for every PSP in
// PSP_HOST_SUFFIXES: Stripe Elements, PayPal Buttons, Adyen Drop-in,
// Braintree Hosted Fields, ...) — inside a cc-autocomplete form, or is the
// focused frame's own origin a PSP host? Enter/Return submits the focused
// frame's form, so this is the signal that a ref-less submit is a payment.
// Never reads label/text content.
//
// A single page.evaluate() only ever runs in the main frame: when focus is
// inside a nested PSP iframe (the common case), the main frame's
// document.activeElement is just the <iframe> host element, so a main-frame-
// only check fails open. This walks page.frames() instead so every frame —
// main and nested — gets checked for its own focus/payment context.
async function computeFocusPaymentContext(page: Page): Promise<boolean> {
  try {
    const frames = page.frames();
    const checks = await Promise.all(
      frames.map(async (frame) => {
        const probe = await probeFrameFocus(frame).catch(() => NO_FOCUS_PROBE);
        if (!probe.isFocusedFrame) {
          return false;
        }
        return probe.inCcForm || frameMatchesPspHost(frame);
      }),
    );
    return checks.some(Boolean);
  } catch {
    return false;
  }
}

export async function createSnapshot(
  page: Page,
  targetId: string,
  options?: BrowserSnapshotOptions,
): Promise<BrowserSnapshot> {
  const snapshotFormat = options?.snapshotFormat ?? "ai";
  if (snapshotFormat === "ai") {
    const aiSnapshot = await createAiSnapshot(page, targetId, options).catch(() => undefined);
    if (aiSnapshot) {
      return aiSnapshot;
    }
  }
  return await createLegacySnapshot(page, targetId);
}

async function enrichPageAccessibility(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nextButtons = document.querySelectorAll(
      "button.next-month, button.ui-datepicker-next, .next-month button, [class*='next-month']"
    );
    for (const btn of nextButtons) {
      if (!btn.getAttribute("aria-label")) {
        btn.setAttribute("aria-label", "Mese successivo");
      }
    }

    const prevButtons = document.querySelectorAll(
      "button.prev-month, button.ui-datepicker-prev, .prev-month button, [class*='prev-month']"
    );
    for (const btn of prevButtons) {
      if (!btn.getAttribute("aria-label")) {
        btn.setAttribute("aria-label", "Mese precedente");
      }
    }

    const allButtons = document.querySelectorAll("button");
    for (const btn of allButtons) {
      const text = btn.textContent ? btn.textContent.trim() : "";
      const hasAriaLabel = btn.getAttribute("aria-label");

      if (!text && !hasAriaLabel) {
        const className = btn.className || "";
        if (className.includes("close") || className.includes("dismiss")) {
          btn.setAttribute("aria-label", "Chiudi");
        } else if (className.includes("search")) {
          btn.setAttribute("aria-label", "Cerca");
        }
      }
    }
  }).catch(() => undefined);
}

async function createAiSnapshot(
  page: Page,
  targetId: string,
  options?: BrowserSnapshotOptions,
): Promise<BrowserSnapshot> {
  const observedMode = observationMode(options);
  await enrichPageAccessibility(page);
  const timeout = Math.max(500, Math.min(60_000, Math.floor(options?.timeoutMs ?? 5_000)));
  const ariaSnapshot = await page.ariaSnapshot({ mode: "ai", timeout });
  const roleOptions = roleSnapshotOptions(options);
  const builtSnapshot = roleOptions
    ? buildRoleSnapshotFromAiSnapshot(ariaSnapshot, roleOptions)
    : { snapshot: ariaSnapshot, refs: refsFromAiSnapshot(ariaSnapshot) };
  const rawSnapshot = options?.urls
    ? appendSnapshotUrls(builtSnapshot.snapshot, await collectSnapshotUrls(page))
    : builtSnapshot.snapshot;
  const observedSnapshot =
    observedMode === "delta" ? structuralDelta(options?.previousSnapshot, rawSnapshot) : rawSnapshot;
  const limit = limitForObservation(observedMode, options?.maxChars);
  const snapshot =
    observedSnapshot.length > limit
      ? `${observedSnapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`
      : observedSnapshot;
  const refs = roleOptions ? refsFromAiSnapshot(snapshot) : builtSnapshot.refs;
  const refLocators = new Map<string, Locator>();
  for (const ref of refs) {
    refLocators.set(ref.ref, page.locator(`aria-ref=${ref.ref}`));
  }
  const paymentFloorRefs = await computePaymentFloorRefs(refs, refLocators);
  const focusPaymentContext = await computeFocusPaymentContext(page);
  return {
    targetId,
    url: page.url(),
    snapshot,
    refs,
    refLocators,
    refsMode: "aria",
    snapshotFormat: "ai",
    stats: snapshotStats(snapshot, refs.length),
    generation: normalizedGeneration(options?.generation),
    fingerprint: fingerprintSnapshot(snapshot),
    observationMode: observedMode,
    paymentFloorRefs,
    focusPaymentContext,
  };
}

function refsFromAiSnapshot(snapshot: string): BrowserRef[] {
  const refs = new Map<string, BrowserRef>();
  for (const line of snapshot.split("\n")) {
    const match = line.match(/^\s*-\s*([a-zA-Z][\w-]*)(?:\s+"([^"]*)")?.*\[ref=([^\]\s]+)\]/);
    if (!match) {
      continue;
    }
    const [, role, name = "", ref] = match;
    if (!refs.has(ref)) {
      refs.set(ref, {
        ref,
        role: role.toLowerCase(),
        name,
        refsMode: "aria",
      });
    }
  }
  return [...refs.values()];
}

type RoleSnapshotOptions = {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
};

function roleSnapshotOptions(options?: BrowserSnapshotOptions): RoleSnapshotOptions | null {
  const observedMode = observationMode(options);
  if (observedMode === "interact") {
    return {
      interactive: options?.interactive ?? true,
      compact: options?.compact ?? true,
      maxDepth: typeof options?.depth === "number" && Number.isFinite(options.depth) ? options.depth : 12,
    };
  }
  if (
    options?.mode !== "efficient" &&
    options?.interactive !== true &&
    options?.compact !== true &&
    typeof options?.depth !== "number"
  ) {
    return null;
  }
  return {
    interactive: options?.interactive ?? options?.mode === "efficient",
    compact: options?.compact ?? options?.mode === "efficient",
    maxDepth: typeof options?.depth === "number" && Number.isFinite(options.depth) ? options.depth : undefined,
  };
}

function buildRoleSnapshotFromAiSnapshot(
  aiSnapshot: string,
  options: RoleSnapshotOptions,
): { snapshot: string; refs: BrowserRef[] } {
  const refs = new Map<string, BrowserRef>();
  const lines: string[] = [];
  for (const line of aiSnapshot.split("\n")) {
    const parsed = parseSnapshotLine(line);
    if (!parsed) {
      if (!options.interactive) {
        lines.push(line);
      }
      continue;
    }
    if (options.maxDepth !== undefined && parsed.depth > options.maxDepth) {
      continue;
    }
    const role = parsed.role.toLowerCase();
    if (options.interactive && !INTERACTIVE_ROLES.has(role)) {
      continue;
    }
    if (options.compact && STRUCTURAL_ROLES.has(role) && !parsed.name && !parsed.ref) {
      continue;
    }
    if (parsed.ref) {
      refs.set(parsed.ref, {
        ref: parsed.ref,
        role,
        name: parsed.name ?? "",
        refsMode: "aria",
      });
    }
    lines.push(line);
  }
  return {
    snapshot: lines.join("\n") || (options.interactive ? "(no interactive elements)" : "(empty)"),
    refs: [...refs.values()],
  };
}

function parseSnapshotLine(line: string):
  | { depth: number; role: string; name?: string; ref?: string }
  | null {
  const match = line.match(/^(\s*)-\s*([a-zA-Z][\w-]*)(?:\s+"([^"]*)")?(.*)$/);
  if (!match) {
    return null;
  }
  const [, indent, role, name, suffix] = match;
  const ref = suffix.match(/\[ref=([^\]\s]+)\]/)?.[1];
  return {
    depth: Math.floor(indent.length / 2),
    role,
    ...(name ? { name } : {}),
    ...(ref ? { ref } : {}),
  };
}

type SnapshotUrlEntry = {
  text: string;
  url: string;
};

async function collectSnapshotUrls(page: Page): Promise<SnapshotUrlEntry[]> {
  return await page
    .evaluate(() => {
      const seen = new Set<string>();
      const entries: SnapshotUrlEntry[] = [];
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = anchor instanceof HTMLAnchorElement ? anchor.href : "";
        if (!href || seen.has(href)) {
          continue;
        }
        const text =
          (anchor.textContent || anchor.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120) || href;
        seen.add(href);
        entries.push({ text, url: href });
        if (entries.length >= 100) {
          break;
        }
      }
      return entries;
    })
    .catch(() => []);
}

function appendSnapshotUrls(snapshot: string, urls: SnapshotUrlEntry[]): string {
  if (!urls.length) {
    return snapshot;
  }
  const lines = urls.map((entry, index) => `${index + 1}. ${entry.text} -> ${entry.url}`);
  return `${snapshot}\n\nLinks:\n${lines.join("\n")}`;
}

async function createLegacySnapshot(page: Page, targetId: string): Promise<BrowserSnapshot> {
  const refs: BrowserRef[] = [];
  const refLocators = new Map<string, Locator>();
  const lines: string[] = [];
  const title = await page.title().catch(() => "");
  const bodyText = (await page.locator("body").innerText().catch(() => "")).trim();

  if (title) {
    lines.push(`title: ${title}`);
  }
  if (bodyText) {
    lines.push(bodyText);
  }

  const locator = page.locator(INTERACTIVE_SELECTOR);
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) {
      continue;
    }
    const ref = `e${refs.length + 1}`;
    const role = await resolveRole(item);
    const name = await resolveName(item);
    refs.push({ ref, role, name, refsMode: "locator" });
    refLocators.set(ref, item);
    lines.push(`[ref=${ref}] ${role}: ${name}`);
  }

  const snapshot = lines.join("\n");
  return {
    targetId,
    url: page.url(),
    snapshot,
    refs,
    refLocators,
    refsMode: "locator",
    snapshotFormat: "legacy",
    stats: snapshotStats(snapshot, refs.length),
    generation: 0,
    fingerprint: fingerprintSnapshot(snapshot),
    observationMode: "extract",
    // Legacy (non-AI) snapshot path is not covered by the floor computation;
    // an empty floor is correct (raise-only — never fabricate a floor here).
    paymentFloorRefs: [],
    // Same rationale: not computed on the legacy fallback path.
    focusPaymentContext: false,
  };
}

function snapshotStats(snapshot: string, refs: number): BrowserSnapshot["stats"] {
  return {
    lines: snapshot ? snapshot.split("\n").length : 0,
    chars: snapshot.length,
    refs,
  };
}

function observationMode(options?: BrowserSnapshotOptions): BrowserObservationMode {
  const mode = options?.observationMode;
  return mode === "delta" || mode === "extract" || mode === "interact" ? mode : "extract";
}

function limitForObservation(mode: BrowserObservationMode, maxChars?: number): number {
  const cap = OBSERVATION_LIMITS[mode];
  if (typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0) {
    return Math.min(Math.floor(maxChars), cap);
  }
  return cap;
}

function normalizedGeneration(generation?: number): number {
  return typeof generation === "number" && Number.isFinite(generation) && generation > 0 ? Math.floor(generation) : 0;
}

function fingerprintSnapshot(snapshot: string): string {
  let hash = 5381;
  for (let index = 0; index < snapshot.length; index += 1) {
    hash = ((hash << 5) + hash) ^ snapshot.charCodeAt(index);
  }
  return `snap_${(hash >>> 0).toString(16)}`;
}

// Guards the O(oldLen*newLen) LCS table below. This diff runs inline in the
// sidecar's per-call deadline (interact 10s / act 15s in main.rs), so a
// pathological previous+current pair (e.g. spanning a full-page navigation)
// must not spend unbounded time/memory on the table; an oversized pair is
// itself evidence the delta would be ~the whole page anyway, so it goes
// straight to the same full-snapshot fallback as ref churn.
const MAX_DIFF_CELLS = 4_000_000;

// Ratio of added lines over total current lines above which Playwright ref
// reassignment (aria-ref renumbering on re-render/navigation) has defeated
// line-identity diffing: because every line embeds `[ref=eN]`, a bare
// renumbering makes nearly every line read as "added" even though nothing
// structurally changed. Falling back to the full snapshot is both more
// honest and no larger than a "delta" that is already ~the whole page.
const REF_CHURN_FALLBACK_RATIO = 0.6;

function nonBlankLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Backward LCS-length table: lengths[i * (newLen+1) + j] = length of the
// longest common subsequence of oldLines[i:] and newLines[j:]. Flattened
// into a single Int32Array (row-major) rather than nested arrays — cheap
// enough for the few-hundred-line snapshots this runs on, and avoids the
// per-row allocation overhead of an array-of-arrays.
function lcsLengths(oldLines: string[], newLines: string[]): Int32Array {
  const oldLen = oldLines.length;
  const newLen = newLines.length;
  const width = newLen + 1;
  const table = new Int32Array((oldLen + 1) * width);
  for (let i = oldLen - 1; i >= 0; i--) {
    for (let j = newLen - 1; j >= 0; j--) {
      const idx = i * width + j;
      if (oldLines[i] === newLines[j]) {
        table[idx] = table[(i + 1) * width + (j + 1)] + 1;
      } else {
        const down = table[(i + 1) * width + j];
        const right = table[i * width + (j + 1)];
        table[idx] = down >= right ? down : right;
      }
    }
  }
  return table;
}

type DiffOp = { type: "add" | "remove"; line: string };

// Walks the LCS table front-to-back to emit a positional sequence diff:
// equal lines are consumed silently, add/remove ops are emitted in the
// order they occur. This is what makes a genuinely-new duplicate line
// (same trimmed text as an existing line, different position) show up as
// an addition instead of being dropped by set-membership, and what lets a
// removal be reported instead of being invisible.
function walkDiff(oldLines: string[], newLines: string[], table: Int32Array): DiffOp[] {
  const oldLen = oldLines.length;
  const newLen = newLines.length;
  const width = newLen + 1;
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLen && j < newLen) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const down = table[(i + 1) * width + j];
    const right = table[i * width + (j + 1)];
    if (down >= right) {
      ops.push({ type: "remove", line: oldLines[i] });
      i += 1;
    } else {
      ops.push({ type: "add", line: newLines[j] });
      j += 1;
    }
  }
  while (i < oldLen) {
    ops.push({ type: "remove", line: oldLines[i] });
    i += 1;
  }
  while (j < newLen) {
    ops.push({ type: "add", line: newLines[j] });
    j += 1;
  }
  return ops;
}

// Sequence-aware structural delta between two AI snapshots (IMPORTANT 4).
//
// The naive predecessor did set-membership on trimmed lines: it only ever
// reported ADDED lines, so a removal (an error banner clearing, a
// "sold out" row disappearing, a spinner resolving) was invisible — the
// model was told "[no structural changes]" and acted on stale assumptions.
// A genuinely-new line whose trimmed text happened to equal an existing
// line (repeated "In stock", identical labels) was silently dropped as if
// unchanged. And because every line embeds `[ref=eN]`, a Playwright ref
// reassignment made every line differ from the previous snapshot, so the
// "delta" became the whole page and blew the delta observation char cap
// under silent truncation — the opposite of the intended savings.
//
// This does a real line-SEQUENCE diff (an LCS/Myers-equivalent longest
// common subsequence over non-blank trimmed lines): duplicates are
// preserved by position rather than deduplicated by a Set, and both
// additions (`+ `) and removals (`- `) are reported so the model sees when
// content disappeared, not just what appeared. When ref churn defeats
// line-identity (added lines make up most of the current page), this
// falls back to the full current snapshot instead of a misleadingly
// bloated or empty delta — the caller's existing char-cap truncation still
// applies to that fallback exactly as it would to a non-delta observation.
// Machine-only: a pure text-sequence diff, no label/text semantics.
export function structuralDelta(previous: string | undefined, current: string): string {
  if (!previous) {
    return current;
  }
  const oldLines = nonBlankLines(previous);
  const newLines = nonBlankLines(current);

  if (oldLines.length === 0 && newLines.length === 0) {
    return "[no structural changes detected]";
  }

  if ((oldLines.length + 1) * (newLines.length + 1) > MAX_DIFF_CELLS) {
    return current;
  }

  const table = lcsLengths(oldLines, newLines);
  const ops = walkDiff(oldLines, newLines, table);

  if (ops.length === 0) {
    return "[no structural changes detected]";
  }

  const addedCount = ops.reduce((count, op) => count + (op.type === "add" ? 1 : 0), 0);
  const addedRatio = newLines.length > 0 ? addedCount / newLines.length : 0;
  if (addedRatio > REF_CHURN_FALLBACK_RATIO) {
    return current;
  }

  return ops.map((op) => (op.type === "add" ? `+ ${op.line}` : `- ${op.line}`)).join("\n");
}

async function resolveRole(locator: Locator): Promise<string> {
  const tag = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
  if (tag === "input" || tag === "textarea") {
    const inputType = await locator
      .getAttribute("type")
      .then((value) => value?.toLowerCase() ?? "text")
      .catch(() => "text");
    if (["button", "submit", "reset", "checkbox", "radio"].includes(inputType)) {
      return inputType === "checkbox" || inputType === "radio" ? inputType : "button";
    }
    return "textbox";
  }
  if (tag === "select") {
    return "combobox";
  }
  if (tag === "a") {
    return "link";
  }
  return "button";
}

async function resolveName(locator: Locator): Promise<string> {
  const explicitName =
    (await locator.getAttribute("aria-label").catch(() => null)) ??
    (await locator.getAttribute("name").catch(() => null)) ??
    (await locator.getAttribute("placeholder").catch(() => null)) ??
    (await locator.getAttribute("value").catch(() => null)) ??
    (await locator.textContent().catch(() => null)) ??
    (await locator.getAttribute("id").catch(() => null)) ??
    (await locator.getAttribute("data-testid").catch(() => null)) ??
    (await locator.getAttribute("autocomplete").catch(() => null)) ??
    (await locator.getAttribute("title").catch(() => null));
  if (explicitName?.trim()) {
    return explicitName.trim();
  }

  return (
    (await associatedLabel(locator).catch(() => null)) ??
    (await nearbyFieldText(locator).catch(() => null)) ??
    ""
  ).trim();
}

async function associatedLabel(locator: Locator): Promise<string | null> {
  return await locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return null;
    }
    const labels = "labels" in element ? Array.from((element as HTMLInputElement).labels ?? []) : [];
    const direct = labels.map((label) => label.textContent?.trim()).find(Boolean);
    if (direct) {
      return direct;
    }
    const id = element.getAttribute("id");
    if (id) {
      const escaped = id.replace(/["\\]/g, "\\$&");
      const label = document.querySelector(`label[for="${escaped}"]`);
      if (label?.textContent?.trim()) {
        return label.textContent.trim();
      }
    }
    return null;
  });
}

async function nearbyFieldText(locator: Locator): Promise<string | null> {
  return await locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return null;
    }
    const container = element.closest("label, [role='group'], .form-group, .field, div");
    const text = container?.textContent?.trim().replace(/\s+/g, " ");
    if (!text || text.length > 120) {
      return null;
    }
    return text;
  });
}
