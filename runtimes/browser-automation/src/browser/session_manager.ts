import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Dialog, Locator, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { BrowserAutomationError } from "../contracts.js";
import { executeAction, requireRef, resolveAutoComplete, type BrowserActRequest, type BrowserActionResult } from "./actions.js";
import { BrowserArtifactRoot } from "./artifacts.js";
import { assertNavigationAllowed } from "./navigation_guard.js";
import {
  profileSummaries,
  resolveAssistantProfile,
  type BrowserProfileConfig,
  type BrowserProfileSummary,
} from "./profiles.js";
import { createSnapshot, type BrowserRef, type BrowserSnapshotOptions } from "./snapshot.js";

export type BrowserSessionOptions = {
  headless?: boolean;
  allowPrivateNetwork?: boolean;
  executablePath?: string;
  profileRoot?: string;
  artifactRoot?: string;
  uploadRoots?: string[];
  userCdpEndpoint?: string;
  // When attaching over CDP, create a fresh isolated BrowserContext instead of
  // reusing the shared default context. This is what lets multiple parallel
  // workers drive the same contained Chromium without colliding on tabs/state.
  isolatedContext?: boolean;
  browserEpoch?: string;
};

export type BrowserDraftControl = {
  draftRef: string;
  tag: "input" | "textarea" | "select";
  type: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  label?: string;
  formId?: string;
  value: string | boolean | string[];
};

export type BrowserCheckpoint = {
  schemaVersion: 1;
  targetId: string;
  url: string;
  origin: string;
  browserEpoch: string;
  cdpTargetId?: string;
  generation: number;
  controls: BrowserDraftControl[];
  omittedSensitiveCount: number;
  omittedBoundedCount: number;
};

export type BrowserRestoreRequest = {
  targetId: string;
  url: string;
  origin: string;
  browserEpoch: string;
  cdpTargetId?: string;
  generation: number;
};

export type BrowserRehydrateField = {
  ref: string;
  value: string | boolean | string[];
  descriptor: Omit<BrowserDraftControl, "draftRef" | "value">;
};

const MAX_DRAFT_CONTROLS = 32;
const MAX_DRAFT_VALUE_CHARS = 2_000;
const MAX_DRAFT_BYTES = 16 * 1024;

export type BrowserTab = {
  targetId: string;
  url: string;
  label?: string;
  profile?: "assistant" | "user";
  headless?: boolean;
  fallbackFromHeadless?: boolean;
};

type PageState = {
  page: Page;
  label?: string;
  refs: Map<string, Locator>;
  generation: number;
  // The last FULL raw accessibility snapshot (pre-role-filter, pre-delta —
  // see BrowserSnapshot.rawSnapshot), independent of whatever was actually
  // displayed to the model. This, not the displayed snapshot, is the basis
  // fed to the NEXT delta call: diffing full-raw against a previously
  // *displayed* (role-filtered "interact" view, or already diff-marked)
  // snapshot made nearly every line read as "added" and spuriously tripped
  // structuralDelta's ref-churn fallback on ordinary interact->delta and
  // delta->delta sequences, collapsing delta mode into a full-page dump.
  lastFullSnapshot?: string;
  lastSnapshotFingerprint?: string;
  // Fase 2.2: ref IDs from the previous observation so new refs can be
  // marked with a `*` suffix in the next snapshot display text.
  previousRefs?: Set<string>;
  consoleMessages: ConsoleEntry[];
  pendingDialog?: Dialog;
  dialogWaiters: Array<(dialog: Dialog) => void>;
  armedFileChooser?: string[];
};

type ConsoleEntry = {
  type: string;
  text: string;
  timestamp: string;
};

type ArtifactMetadata = {
  kind: "screenshots" | "downloads" | "pdf";
  path: string;
  bytes: number;
};

// Set-of-marks legend entry: one numbered badge -> the ref the model can act on.
type ScreenshotMark = {
  mark: number;
  ref: string;
  role: string;
  name: string;
};

export class BrowserSessionManager {
  private readonly options: BrowserSessionOptions;
  private context?: BrowserContext;
  private attachedBrowser?: Browser;
  private activeProfile: "assistant" | "user" = "assistant";
  private profile?: BrowserProfileConfig;
  private artifactRoot?: BrowserArtifactRoot;
  private pages = new Map<string, PageState>();
  // Persistent per-target metadata that survives context restarts and page
  // crashes, so a lost target can be re-materialized instead of failing hard
  // with BROWSER_TAB_NOT_FOUND mid-loop.
  private targetMeta = new Map<string, { url?: string; label?: string }>();
  private nextTargetId = 1;

  constructor(options?: BrowserSessionOptions) {
    this.options = options ?? {};
  }

  async start(params?: { profile?: "assistant" | "user" }): Promise<{ status: "started"; profile: string }> {
    if (this.context) {
      return { status: "started", profile: this.activeProfile };
    }
    // When a CDP endpoint is configured (contained-computer mode, ADR 0010),
    // attach to that real browser by default instead of launching a host
    // Chromium — the endpoint is the single switch. An explicit profile param
    // still wins (e.g. force "assistant" for the legacy on-host path).
    const profile =
      params?.profile ??
      (this.options.userCdpEndpoint ? "user" : "assistant");
    if (profile === "user") {
      return await this.startUserProfile();
    }
    return await this.startAssistantProfile(this.options.headless ?? true);
  }

  async stop(): Promise<void> {
    if (this.options.isolatedContext) {
      // We own this context -> tear it down fully (closes our tabs + frees it).
      await this.closeContext();
    } else {
      // Shared default context: close ONLY the tabs this session opened, so we
      // don't leak them (tab accumulation), while preserving the warm context
      // (cookies/consent) and any other session's tabs. Then disconnect our CDP
      // link (does not kill the shared Chromium).
      for (const [, state] of this.pages) {
        if (!state.page.isClosed()) {
          await state.page.close().catch(() => undefined);
        }
      }
      this.pages.clear();
      await this.attachedBrowser?.close().catch(() => undefined);
      this.attachedBrowser = undefined;
      this.context = undefined;
      this.activeProfile = "assistant";
    }
    // A full stop ends the session: forget how to recover targets too.
    this.targetMeta.clear();
  }

  async detachForParentLoss(): Promise<void> {
    if (this.options.userCdpEndpoint && !this.options.isolatedContext) {
      // The contained Chromium owns this shared context. Process exit closes
      // only the CDP socket; its tabs remain available for exact adoption.
      this.pages.clear();
      this.targetMeta.clear();
      await this.attachedBrowser?.close().catch(() => undefined);
      this.context = undefined;
      this.attachedBrowser = undefined;
      this.activeProfile = "assistant";
      return;
    }
    await this.stop();
  }

  // Closes the browser context without forgetting target metadata, so the
  // headless->visible restart can re-materialize targets afterwards.
  private async closeContext(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.attachedBrowser?.close().catch(() => undefined);
    this.context = undefined;
    this.attachedBrowser = undefined;
    this.activeProfile = "assistant";
    this.pages.clear();
  }

  async profiles(): Promise<BrowserProfileSummary[]> {
    const profile = this.profile ?? (await resolveAssistantProfile(this.options));
    return profileSummaries({
      assistantRunning: Boolean(this.context && this.activeProfile === "assistant"),
      userRunning: Boolean(this.context && this.activeProfile === "user"),
      assistantHeadless: profile.headless,
      userCdpEndpoint: this.options.userCdpEndpoint,
    });
  }

  async tabs(): Promise<BrowserTab[]> {
    return [...this.pages.entries()].map(([targetId, state]) => ({
      targetId,
      url: state.page.url(),
      ...(state.label ? { label: state.label } : {}),
    }));
  }

  async open(params: { url: string; label?: string }): Promise<BrowserTab> {
    await this.start();
    await assertNavigationAllowed({
      url: params.url,
      allowPrivateNetwork: this.options.allowPrivateNetwork,
    });
    const targetId = params.label ?? `t${this.nextTargetId++}`;
    const tracked = this.pages.get(targetId);
    // A closed page handle cannot be navigated; treat it as if absent so a
    // fresh page is created instead of throwing on the dead handle.
    const existing = tracked && !tracked.page.isClosed() ? tracked : undefined;
    const result = await this.gotoWithHeadlessFallback({
      targetId,
      label: params.label,
      url: params.url,
      existing,
    });
    return this.browserTab(targetId, result.state, result.fallbackFromHeadless);
  }

  async focus(params: { targetId: string }): Promise<BrowserTab> {
    const state = await this.resolvePage(params.targetId);
    await state.page.bringToFront();
    return {
      targetId: params.targetId,
      url: state.page.url(),
      ...(state.label ? { label: state.label } : {}),
    };
  }

  async closeTab(params: { targetId: string }): Promise<{ closed: true; targetId: string }> {
    // Closing is idempotent: a tab that is already gone is still "closed".
    const state = this.pages.get(params.targetId);
    if (state && !state.page.isClosed()) {
      await state.page.close().catch(() => undefined);
    }
    this.pages.delete(params.targetId);
    this.targetMeta.delete(params.targetId);
    return { closed: true, targetId: params.targetId };
  }

  async navigate(params: { targetId: string; url: string }): Promise<BrowserTab> {
    await assertNavigationAllowed({
      url: params.url,
      allowPrivateNetwork: this.options.allowPrivateNetwork,
    });
    const state = await this.resolvePage(params.targetId);
    const result = await this.gotoWithHeadlessFallback({
      targetId: params.targetId,
      label: state.label,
      url: params.url,
      existing: state,
    });
    result.state.refs.clear();
    return this.browserTab(params.targetId, result.state, result.fallbackFromHeadless);
  }

  async snapshot(params: { targetId: string } & BrowserSnapshotOptions): Promise<{
    targetId: string;
    url: string;
    snapshot: string;
    refs: BrowserRef[];
    refsMode: "aria" | "locator";
    snapshotFormat: "ai" | "legacy";
    stats: {
      lines: number;
      chars: number;
      refs: number;
    };
    generation: number;
    fingerprint: string;
    observationMode: "interact" | "delta" | "extract";
    paymentFloorRefs: string[];
    focusPaymentContext: boolean;
  }> {
    const state = await this.resolvePage(params.targetId);
    // Let late content settle before snapshotting: a static page (Wikipedia) is already
    // idle so this returns instantly, while a JS-heavy page gets up to 2.5s to finish
    // hydrating its tables/results (and late consent banners to appear) instead of
    // snapshotting an empty shell. Bounded so it never hangs on a never-idle SPA.
    await state.page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => {});
    await dismissCommonOverlays(state.page);
    state.generation += 1;
    const snapshot = await createSnapshot(state.page, params.targetId, {
      ...params,
      previousSnapshot: state.lastFullSnapshot,
      generation: state.generation,
      previousRefs: state.previousRefs,
    });
    state.refs = snapshot.refLocators;
    state.lastFullSnapshot = snapshot.rawSnapshot;
    state.lastSnapshotFingerprint = snapshot.fingerprint;
    // Track current ref IDs for new-ref marking on the next observation.
    state.previousRefs = new Set(snapshot.refs.map((r) => r.ref));
    this.rememberTarget(params.targetId, state, state.label);
    return {
      targetId: snapshot.targetId,
      url: snapshot.url,
      snapshot: snapshot.snapshot,
      refs: snapshot.refs,
      refsMode: snapshot.refsMode,
      snapshotFormat: snapshot.snapshotFormat,
      stats: snapshot.stats,
      generation: snapshot.generation,
      fingerprint: snapshot.fingerprint,
      observationMode: snapshot.observationMode,
      paymentFloorRefs: snapshot.paymentFloorRefs,
      focusPaymentContext: snapshot.focusPaymentContext,
    };
  }

  async checkpoint(params: { targetId: string }): Promise<BrowserCheckpoint> {
    const state = await this.resolvePage(params.targetId);
    const page = state.page;
    const captured = await page.evaluate(
      ({ maxControls, maxValueChars, maxBytes }) => {
        type CapturedControl = BrowserDraftControl;
        const candidates = Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement>(
            "input,textarea,select,[contenteditable=true]",
          ),
        );
        const controls: CapturedControl[] = [];
        let omittedSensitiveCount = 0;
        let omittedBoundedCount = 0;
        let bytes = 0;
        const encoder = new TextEncoder();
        const sensitivePattern = /(password|cvv|cvc|security.?code|card.?number|credit.?card|cc-?num)/i;
        const sensitiveAutocomplete = new Set([
          "current-password",
          "new-password",
          "cc-name",
          "cc-given-name",
          "cc-additional-name",
          "cc-family-name",
          "cc-number",
          "cc-exp",
          "cc-exp-month",
          "cc-exp-year",
          "cc-csc",
          "cc-type",
        ]);

        for (const candidate of candidates) {
          const tag = candidate.tagName.toLowerCase();
          const input = candidate instanceof HTMLInputElement ? candidate : undefined;
          const type = input?.type.toLowerCase() ?? tag;
          const name = (candidate.getAttribute("name") ?? "").trim();
          const id = (candidate.id ?? "").trim();
          const autocomplete = (candidate.getAttribute("autocomplete") ?? "").trim().toLowerCase();
          const ariaLabel = (candidate.getAttribute("aria-label") ?? "").trim();
          const explicitLabel = id
            ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)?.innerText.trim()
            : "";
          const wrappingLabel = candidate.closest("label")?.innerText.trim() ?? "";
          const label = ariaLabel || explicitLabel || wrappingLabel;
          const descriptorText = `${type} ${name} ${id} ${autocomplete} ${label}`;
          const excluded =
            tag === "div" ||
            type === "password" ||
            type === "file" ||
            type === "hidden" ||
            sensitiveAutocomplete.has(autocomplete) ||
            sensitivePattern.test(descriptorText);
          if (excluded) {
            omittedSensitiveCount += 1;
            continue;
          }
          if (
            !(candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement || candidate instanceof HTMLSelectElement) ||
            candidate.disabled
          ) {
            continue;
          }
          const style = getComputedStyle(candidate);
          const rect = candidate.getBoundingClientRect();
          if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
            continue;
          }

          let value: string | boolean | string[];
          if (candidate instanceof HTMLInputElement && (type === "checkbox" || type === "radio")) {
            value = candidate.checked;
          } else if (candidate instanceof HTMLSelectElement && candidate.multiple) {
            value = Array.from(candidate.selectedOptions).map((option) => option.value);
          } else {
            value = candidate.value;
          }
          const serializedValue = typeof value === "string" ? value : JSON.stringify(value);
          if (serializedValue.length > maxValueChars || controls.length >= maxControls) {
            omittedBoundedCount += 1;
            continue;
          }
          const control: CapturedControl = {
            draftRef: `draft_${controls.length + 1}`,
            tag: tag as CapturedControl["tag"],
            type,
            ...(name ? { name } : {}),
            ...(id ? { id } : {}),
            ...(autocomplete ? { autocomplete } : {}),
            ...(label ? { label: label.slice(0, 200) } : {}),
            ...(candidate.form?.id ? { formId: candidate.form.id.slice(0, 200) } : {}),
            value,
          };
          const controlBytes = encoder.encode(JSON.stringify(control)).length;
          if (bytes + controlBytes > maxBytes) {
            omittedBoundedCount += 1;
            continue;
          }
          bytes += controlBytes;
          controls.push(control);
        }
        return { controls, omittedSensitiveCount, omittedBoundedCount };
      },
      {
        maxControls: MAX_DRAFT_CONTROLS,
        maxValueChars: MAX_DRAFT_VALUE_CHARS,
        maxBytes: MAX_DRAFT_BYTES,
      },
    );
    const url = page.url();
    return {
      schemaVersion: 1,
      targetId: params.targetId,
      url,
      origin: safeOrigin(url),
      browserEpoch: this.options.browserEpoch ?? "standalone",
      ...(await this.cdpTargetId(page)),
      generation: state.generation,
      ...captured,
    };
  }

  async restore(params: BrowserRestoreRequest): Promise<{
    tier: "adopted_live_page" | "draft_available" | "degraded_url_only";
    targetId: string;
    generation: number;
    url: string;
  }> {
    if (safeOrigin(params.url) !== params.origin) {
      throw new BrowserAutomationError({
        code: "BROWSER_RESTORE_ORIGIN_MISMATCH",
        message: "checkpoint origin does not match URL",
        retryable: false,
      });
    }
    if (
      params.cdpTargetId &&
      params.browserEpoch === (this.options.browserEpoch ?? "standalone")
    ) {
      await this.start();
      for (const page of this.requireContext().pages()) {
        const identity = await this.cdpTargetId(page);
        if (
          identity.cdpTargetId !== params.cdpTargetId ||
          safeOrigin(page.url()) !== params.origin
        ) {
          continue;
        }
        const state = this.createPageState(page, params.targetId);
        state.generation = Math.max(0, Math.floor(params.generation));
        this.pages.set(params.targetId, state);
        this.rememberTarget(params.targetId, state, params.targetId);
        return {
          tier: "adopted_live_page",
          targetId: params.targetId,
          generation: state.generation,
          url: state.page.url(),
        };
      }
    }
    await this.open({ url: params.url, label: params.targetId });
    const state = await this.resolvePage(params.targetId);
    state.generation = Math.max(0, Math.floor(params.generation));
    state.refs.clear();
    return {
      tier: "degraded_url_only",
      targetId: params.targetId,
      generation: state.generation,
      url: state.page.url(),
    };
  }

  async rehydrate(params: {
    targetId: string;
    generation: number;
    fields: BrowserRehydrateField[];
  }): Promise<{ rehydrated: number; skipped: number; generation: number }> {
    const state = await this.resolvePage(params.targetId);
    if (params.generation !== state.generation) {
      throw new BrowserAutomationError({
        code: "BROWSER_STALE_GENERATION",
        message: `rehydrate generation ${params.generation} does not match current page generation ${state.generation}`,
        retryable: true,
      });
    }
    let rehydrated = 0;
    let skipped = 0;
    for (const field of params.fields.slice(0, MAX_DRAFT_CONTROLS)) {
      const locator = requireRef(state.refs, field.ref);
      const result = await locator.evaluate(
        (element, requested) => {
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return false;
          if (element.disabled) return false;
          const tag = element.tagName.toLowerCase();
          const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : tag;
          if (tag !== requested.descriptor.tag || type !== requested.descriptor.type) return false;
          if ((element.getAttribute("name") ?? "") !== (requested.descriptor.name ?? "")) return false;
          if ((element.id ?? "") !== (requested.descriptor.id ?? "")) return false;
          if (element instanceof HTMLInputElement && (type === "checkbox" || type === "radio")) {
            return !element.checked;
          }
          return element.value === "";
        },
        field,
      );
      if (!result) {
        skipped += 1;
        continue;
      }
      if (typeof field.value === "boolean") {
        if (!field.value) {
          skipped += 1;
          continue;
        }
        await locator.check();
      } else if (Array.isArray(field.value)) {
        await locator.selectOption(field.value);
      } else if (field.descriptor.tag === "select") {
        await locator.selectOption(field.value);
      } else {
        await locator.fill(field.value);
      }
      rehydrated += 1;
    }
    return { rehydrated, skipped, generation: state.generation };
  }

  async act(action: BrowserActRequest): Promise<BrowserActionResult> {
    const state = await this.resolvePage(action.targetId);
    await dismissCommonOverlays(state.page);
    const requestedGeneration = Number((action as Record<string, unknown>).generation);
    if (Number.isFinite(requestedGeneration) && requestedGeneration > 0 && requestedGeneration !== state.generation) {
      throw new BrowserAutomationError({
        code: "BROWSER_STALE_GENERATION",
        message: `action generation ${requestedGeneration} does not match current page generation ${state.generation}`,
        retryable: true,
      });
    }
    if (action.kind === "click" && action.ref && state.armedFileChooser) {
      const files = state.armedFileChooser;
      state.armedFileChooser = undefined;
      const chooserPromise = state.page.waitForEvent("filechooser", { timeout: 10_000 });
      const clickPromise = requireRef(state.refs, action.ref).click();
      const chooser = await chooserPromise;
      await chooser.setFiles(files);
      await clickPromise;
      return { ok: true, url: state.page.url() };
    }
    const result = await executeAction(state.page, state.refs, action);
    if (!shouldSnapshotAfterAction(action)) {
      return result;
    }
    await waitForPageToSettle(state.page, action);
    state.generation += 1;
    // Post-act observation: use `extract` (40k cap, full content) after a `type` with
    // auto_complete=false so the autocomplete dropdown options are visible in the snapshot.
    // The larger window ensures the model can see and click the correct suggestion. For all
    // other actions, use `interact` (interactive-only, ~6k cap) to keep per-step latency low.
    const postActObservationMode =
      action.kind === "type" && !resolveAutoComplete(action) ? "extract" : "interact";
    const snapshot = await createSnapshot(state.page, action.targetId, {
      observationMode: postActObservationMode,
      ...(action as Record<string, unknown>),
      previousSnapshot: state.lastFullSnapshot,
      generation: state.generation,
      previousRefs: state.previousRefs,
    } as BrowserSnapshotOptions);
    state.refs = snapshot.refLocators;
    state.lastFullSnapshot = snapshot.rawSnapshot;
    state.lastSnapshotFingerprint = snapshot.fingerprint;
    // Track current ref IDs for new-ref marking on the next observation.
    state.previousRefs = new Set(snapshot.refs.map((r) => r.ref));
    this.rememberTarget(action.targetId, state, state.label);
    return {
      ...result,
      targetId: snapshot.targetId,
      snapshot: snapshot.snapshot,
      refs: snapshot.refs,
      refsMode: snapshot.refsMode,
      snapshotFormat: snapshot.snapshotFormat,
      stats: snapshot.stats,
      generation: snapshot.generation,
      fingerprint: snapshot.fingerprint,
      observationMode: snapshot.observationMode,
      paymentFloorRefs: snapshot.paymentFloorRefs,
      focusPaymentContext: snapshot.focusPaymentContext,
    };
  }

  async screenshot(params: {
    targetId: string;
    fileName: string;
    fullPage?: boolean;
    labels?: boolean;
  }): Promise<ArtifactMetadata & { marks?: ScreenshotMark[] }> {
    const state = await this.resolvePage(params.targetId);
    const root = this.requireArtifactRoot();
    await root.ensureKind("screenshots");
    const outputPath = root.outputPath("screenshots", params.fileName);

    if (!params.labels) {
      await state.page.screenshot({ path: outputPath, fullPage: params.fullPage ?? false });
      return await artifactMetadata("screenshots", outputPath);
    }

    // Set-of-marks: reuse the same snapshot builder that backs browser.snapshot
    // so the numbered badges line up with refs the model can act on. Each badge
    // number maps 1:1 to an [ref=eN] in the returned legend.
    const snapshot = await this.snapshot({
      targetId: params.targetId,
      snapshotFormat: "ai",
      refsMode: "aria",
      interactive: true,
      compact: true,
      depth: 12,
    });

    const MAX_MARKS = 50;
    const items: Array<{
      n: number;
      ref: string;
      role: string;
      name: string;
      box: { x: number; y: number; width: number; height: number };
    }> = [];
    let n = 0;
    for (const ref of snapshot.refs) {
      if (n >= MAX_MARKS) {
        break;
      }
      const loc = state.refs.get(ref.ref) ?? state.page.locator(`aria-ref=${ref.ref}`);
      const box = await loc.boundingBox().catch(() => null);
      if (!box || box.width < 2 || box.height < 2) {
        continue;
      }
      // Skip elements that are entirely offscreen above/left of the document.
      if (box.x + box.width < 0 || box.y + box.height < 0) {
        continue;
      }
      n += 1;
      items.push({ n, ref: ref.ref, role: ref.role, name: ref.name, box });
    }

    try {
      await state.page.evaluate((data) => {
        const PREV = document.getElementById("__som_overlay__");
        if (PREV) {
          PREV.remove();
        }
        const container = document.createElement("div");
        container.id = "__som_overlay__";
        container.setAttribute(
          "style",
          "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;",
        );
        for (const item of data) {
          const outline = document.createElement("div");
          outline.setAttribute(
            "style",
            `position:absolute;left:${item.box.x}px;top:${item.box.y}px;width:${item.box.width}px;height:${item.box.height}px;border:2px solid #e11;box-sizing:border-box;`,
          );
          const badge = document.createElement("div");
          badge.textContent = String(item.n);
          const badgeTop = Math.max(0, item.box.y - 14);
          badge.setAttribute(
            "style",
            `position:absolute;left:${item.box.x}px;top:${badgeTop}px;background:#e11;color:#fff;font:bold 12px/1 sans-serif;padding:1px 4px;border-radius:3px;`,
          );
          container.appendChild(outline);
          container.appendChild(badge);
        }
        document.documentElement.appendChild(container);
      }, items);
      // Marks are placed in document coordinates; full_page is intentionally
      // ignored here so the badges stay aligned with the captured viewport.
      await state.page.screenshot({ path: outputPath, fullPage: false });
    } finally {
      await state.page
        .evaluate(() => document.getElementById("__som_overlay__")?.remove())
        .catch(() => undefined);
    }

    const meta = await artifactMetadata("screenshots", outputPath);
    return {
      ...meta,
      marks: items.map((item) => ({ mark: item.n, ref: item.ref, role: item.role, name: item.name })),
    };
  }

  async pdf(params: { targetId: string; fileName: string; format?: string }): Promise<ArtifactMetadata> {
    const state = await this.resolvePage(params.targetId);
    const root = this.requireArtifactRoot();
    await root.ensureKind("pdf");
    const outputPath = root.outputPath("pdf", params.fileName);
    await state.page.pdf({ path: outputPath, format: params.format ?? "A4" });
    return await artifactMetadata("pdf", outputPath);
  }

  async console(params: { targetId: string; limit?: number }): Promise<{ messages: ConsoleEntry[] }> {
    const state = await this.resolvePage(params.targetId);
    const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
    return { messages: state.consoleMessages.slice(-limit) };
  }

  async respondDialog(params: {
    targetId: string;
    accept: boolean;
    promptText?: string;
    timeoutMs?: number;
  }): Promise<{ handled: true; message: string }> {
    const state = await this.resolvePage(params.targetId);
    const dialog = state.pendingDialog ?? (await waitForDialog(state, params.timeoutMs ?? 5_000));
    state.pendingDialog = undefined;
    const message = dialog.message();
    if (params.accept) {
      await dialog.accept(params.promptText);
    } else {
      await dialog.dismiss();
    }
    return { handled: true, message };
  }

  async armFileChooser(params: {
    targetId: string;
    files: string[];
  }): Promise<{ armed: true; fileCount: number }> {
    if (!params.files.length) {
      throw new BrowserAutomationError({
        code: "BROWSER_INVALID_REQUEST",
        message: "files must not be empty",
        retryable: false,
      });
    }
    const state = await this.resolvePage(params.targetId);
    const root = this.requireArtifactRoot();
    state.armedFileChooser = await Promise.all(params.files.map((file) => root.inputUploadPath(file)));
    return { armed: true, fileCount: state.armedFileChooser.length };
  }

  async waitDownload(params: {
    targetId: string;
    fileName?: string;
    action?: BrowserActRequest;
    timeoutMs?: number;
  }): Promise<ArtifactMetadata & { suggestedFilename: string }> {
    const state = await this.resolvePage(params.targetId);
    const root = this.requireArtifactRoot();
    await root.ensureKind("downloads");
    const downloadPromise = state.page.waitForEvent("download", {
      timeout: Math.max(1, Math.min(params.timeoutMs ?? 30_000, 300_000)),
    });
    if (params.action) {
      await this.act(params.action);
    }
    const download = await downloadPromise;
    const suggestedFilename = download.suggestedFilename();
    const fileName = params.fileName ?? suggestedFilename;
    const outputPath = root.outputPath("downloads", fileName);
    await download.saveAs(outputPath);
    return {
      ...(await artifactMetadata("downloads", outputPath)),
      suggestedFilename,
    };
  }

  private requireContext(): BrowserContext {
    if (!this.context) {
      throw new BrowserAutomationError({
        code: "BROWSER_NOT_STARTED",
        message: "browser session is not started",
        retryable: true,
      });
    }
    return this.context;
  }

  private async cdpTargetId(page: Page): Promise<{ cdpTargetId?: string }> {
    try {
      const session = await page.context().newCDPSession(page);
      const response = await session.send("Target.getTargetInfo");
      await session.detach();
      const targetId = response?.targetInfo?.targetId;
      return typeof targetId === "string" && targetId ? { cdpTargetId: targetId } : {};
    } catch {
      return {};
    }
  }


  private createPageState(page: Page, label?: string): PageState {
    const state: PageState = {
      page,
      label,
      refs: new Map(),
      generation: 0,
      consoleMessages: [],
      dialogWaiters: [],
    };
    page.on("console", (message) => {
      state.consoleMessages.push({
        type: message.type(),
        text: message.text(),
        timestamp: new Date().toISOString(),
      });
      if (state.consoleMessages.length > 500) {
        state.consoleMessages.splice(0, state.consoleMessages.length - 500);
      }
    });
    page.on("dialog", (dialog) => {
      state.pendingDialog = dialog;
      const waiter = state.dialogWaiters.shift();
      if (waiter) {
        waiter(dialog);
      }
    });
    return state;
  }

  private async gotoWithHeadlessFallback(params: {
    targetId: string;
    label?: string;
    url: string;
    existing?: PageState;
  }): Promise<{ state: PageState; fallbackFromHeadless: boolean }> {
    let state =
      params.existing ?? this.createPageState(await this.requireContext().newPage(), params.label);
    this.pages.set(params.targetId, state);
    try {
      await state.page.goto(params.url);
      await dismissCommonOverlays(state.page);
      this.rememberTarget(params.targetId, state, params.label);
      return { state, fallbackFromHeadless: false };
    } catch (error) {
      if (!this.canRetryNavigationVisible(error)) {
        throw error;
      }
    }

    await this.restartAssistantVisible();
    state = this.createPageState(await this.requireContext().newPage(), params.label);
    this.pages.set(params.targetId, state);
    await state.page.goto(params.url);
    await dismissCommonOverlays(state.page);
    this.rememberTarget(params.targetId, state, params.label);
    return { state, fallbackFromHeadless: true };
  }

  // Records where a target currently is so it can be re-opened after a crash,
  // page close, or context restart.
  private rememberTarget(targetId: string, state: PageState, label?: string): void {
    this.targetMeta.set(targetId, {
      url: state.page.url(),
      label: label ?? state.label,
    });
  }

  // Returns a live page for the target, transparently re-opening it at its last
  // known URL if the previous page was closed or lost. Operational callers use
  // this instead of requirePage so a single dead tab does not abort the loop.
  private async resolvePage(targetId: string): Promise<PageState> {
    const existing = this.pages.get(targetId);
    if (existing && !existing.page.isClosed()) {
      return existing;
    }
    const meta = this.targetMeta.get(targetId);
    if (!meta?.url) {
      throw new BrowserAutomationError({
        code: "BROWSER_TAB_NOT_FOUND",
        message: `tab not found: ${targetId}`,
        retryable: false,
      });
    }
    await this.start();
    const state = this.createPageState(await this.requireContext().newPage(), meta.label);
    this.pages.set(targetId, state);
    await state.page.goto(meta.url);
    await dismissCommonOverlays(state.page);
    return state;
  }

  private browserTab(targetId: string, state: PageState, fallbackFromHeadless: boolean): BrowserTab {
    return {
      targetId,
      url: state.page.url(),
      ...(state.label ? { label: state.label } : {}),
      profile: this.activeProfile,
      headless: this.profile?.headless,
      ...(fallbackFromHeadless ? { fallbackFromHeadless } : {}),
    };
  }

  private async startAssistantProfile(headless: boolean): Promise<{ status: "started"; profile: string }> {
    this.profile = await resolveAssistantProfile({ ...this.options, headless });
    await mkdir(this.profile.userDataDir, { recursive: true });
    // A hard-killed Chromium leaves stale Singleton* lock files in the profile dir;
    // the next launchPersistentContext then aborts ("profile already in use"). The
    // owning process is gone, so clearing them is safe — mirrors what the contained-
    // computer entrypoint already does inside the container.
    await clearSingletonLocks(this.profile.userDataDir);
    this.context = await chromium.launchPersistentContext(this.profile.userDataDir, {
      headless: this.profile.headless,
      executablePath: this.profile.executablePath,
      acceptDownloads: true,
      // Anti-detection on this managed-launch path: drop the "controlled by automated
      // software" banner and the AutomationControlled blink feature (which sets
      // navigator.webdriver), and present a host-consistent locale/timezone (a
      // mismatch is itself a tell).
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
      locale: hostLocale(),
      timezoneId: hostTimezone(),
    });
    await applyStealthInit(this.context);
    this.activeProfile = "assistant";
    return { status: "started", profile: this.profile.name };
  }

  private async restartAssistantVisible(): Promise<void> {
    await this.closeContext();
    await this.startAssistantProfile(false);
  }

  private canRetryNavigationVisible(error: unknown): boolean {
    return this.activeProfile === "assistant" && this.profile?.headless === true && isHeadlessNavigationFailure(error);
  }

  private requireArtifactRoot(): BrowserArtifactRoot {
    if (!this.artifactRoot) {
      this.artifactRoot = new BrowserArtifactRoot(
        this.options.artifactRoot ??
          path.join(os.tmpdir(), "local-first-browser-automation", "artifacts"),
        { uploadRoots: this.options.uploadRoots },
      );
    }
    return this.artifactRoot;
  }

  private async startUserProfile(): Promise<{ status: "started"; profile: "user" }> {
    if (!this.options.userCdpEndpoint) {
      throw new BrowserAutomationError({
        code: "BROWSER_USER_PROFILE_UNAVAILABLE",
        message: "user profile requires BROWSER_AUTOMATION_USER_CDP_ENDPOINT",
        retryable: false,
        manualActionRequired: true,
      });
    }
    this.attachedBrowser = await chromium.connectOverCDP(this.options.userCdpEndpoint);
    // Isolated mode: always create our OWN context so parallel workers don't
    // share tabs/cookies with each other or the default window. We own it, so
    // closeContext() tears down exactly our tabs (also fixes tab accumulation).
    this.context = this.options.isolatedContext
      ? await this.attachedBrowser.newContext({ acceptDownloads: true })
      : (this.attachedBrowser.contexts()[0] ??
        (await this.attachedBrowser.newContext({ acceptDownloads: true })));
    await applyStealthInit(this.context);
    this.activeProfile = "user";
    return { status: "started", profile: "user" };
  }
}

async function artifactMetadata(kind: ArtifactMetadata["kind"], outputPath: string): Promise<ArtifactMetadata> {
  const file = await stat(outputPath);
  return { kind, path: outputPath, bytes: file.size };
}

// Remove stale Chromium singleton lock files from a (persistent) profile dir. The
// process that held them is gone after a hard kill/crash, so they're safe to clear;
// leaving them makes launchPersistentContext abort. No-op on a fresh dir.
async function clearSingletonLocks(userDataDir: string): Promise<void> {
  await Promise.all(
    ["SingletonLock", "SingletonSocket", "SingletonCookie"].map((name) =>
      rm(path.join(userDataDir, name), { force: true }).catch(() => undefined),
    ),
  );
}

// Surgical de-automation: hide the single highest-signal tell — navigator.webdriver
// — on every document before page scripts run. Deliberately minimal: unlike
// patchright (reverted because its isolated-context evaluate broke our snapshot /
// form-fill pipeline), an addInitScript runs in the page's main world and leaves the
// CDP snapshot path untouched. Best-effort; a failure must never block a session.
async function applyStealthInit(context: BrowserContext): Promise<void> {
  try {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      } catch {
        /* already shadowed — ignore */
      }
    });
  } catch {
    /* addInitScript unsupported on this context — ignore */
  }
}

// Host locale/timezone for the browser context, so the page's reported locale and
// clock match the machine it actually runs on (a mismatch is a bot tell). Undefined
// falls back to the browser default.
function hostLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || undefined;
  } catch {
    return undefined;
  }
}

function hostTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

function shouldSnapshotAfterAction(action: BrowserActRequest): boolean {
  if (
    ("snapshotAfter" in action && action.snapshotAfter === true) ||
    ("snapshot_after" in action && action.snapshot_after === true)
  ) {
    return true;
  }
  return [
    "click",
    "clickCoords",
    "type",
    "fill",
    "fill_form",
    "press",
    "press_key",
    "select",
    "select_option",
    "hover",
    "hold",
    "scrollIntoView",
    "scroll_into_view",
    "scroll",
    "wait",
    "navigate",
    "evaluate",
    "batch",
  ].includes(action.kind);
}

function snapshotDelayForAction(action: BrowserActRequest): number {
  if (action.kind === "click" || action.kind === "clickCoords" || action.kind === "hold") {
    return 1_000;
  }
  if (action.kind === "type") {
    return 400;
  }
  if (action.kind === "fill" || action.kind === "fill_form") {
    return 500;
  }
  if (action.kind === "press" || action.kind === "press_key" || action.kind === "select" || action.kind === "select_option") {
    return 300;
  }
  if (action.kind === "hover" || action.kind === "scrollIntoView" || action.kind === "scroll_into_view") {
    return 150;
  }
  if (action.kind === "wait") {
    return 100;
  }
  if (action.kind === "batch") {
    return 600;
  }
  return 250;
}

async function waitForPageToSettle(page: Page, action: BrowserActRequest): Promise<void> {
  await page.waitForTimeout(snapshotDelayForAction(action));
  if (
    action.kind !== "click" &&
    action.kind !== "clickCoords" &&
    action.kind !== "press" &&
    action.kind !== "press_key" &&
    action.kind !== "hold"
  ) {
    return;
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  await waitForDomToStopChanging(page);
  await page.waitForTimeout(250);
}

// How long a committing action may wait for the page to finish producing its result. Submitting a
// search starts an XHR that commonly takes several seconds, and a results SPA keeps polling so
// `networkidle` never fires — with only the load-state waits above, the snapshot was taken while the
// spinner was still up. The model then saw no results, concluded the search had not run, and clicked
// again: the "it reloads the results page instead of waiting" loop.
//
// browser-use waits far less than this (0.25s min / 0.5s idle / 0.3s when requests are pending),
// because for them a wasted step costs ~1s. Ours costs one model generation (seconds to tens of
// seconds), so it is worth blocking a little longer here — but on the SAME signal they use: in-flight
// requests via the Performance API plus document.readyState, not a blind sleep. The wait ends as soon
// as the page is genuinely quiet, so a static page pays ~0.8s.
const SETTLE_TIMEOUT_MS = 12_000;
const SETTLE_SAMPLE_MS = 400;
const SETTLE_STABLE_SAMPLES = 2;
/// Confirmation delay for the already-quiet fast path — long enough for a click's fetch to show up in
/// the resource timings, short enough not to tax the many actions that start no request at all.
const SETTLE_CONFIRM_MS = 150;

/// Wait until nothing is in flight AND the DOM has stopped changing, or the timeout elapses.
/// Machine signals only — request timings, readyState, and a size probe; never a search for particular
/// words — so it behaves the same on any site and in any language.
async function waitForDomToStopChanging(page: Page): Promise<void> {
  const probe = () =>
    page
      .evaluate(() => {
        const now = performance.now();
        // A resource whose response has not ended yet is still in flight. Ignore ones that have been
        // hanging for >15s (long-poll/streaming/analytics sockets never finish and would block forever).
        const pending = performance
          .getEntriesByType("resource")
          .filter((entry) => {
            const timing = entry as PerformanceResourceTiming;
            return timing.responseEnd === 0 && now - timing.startTime < 15_000;
          }).length;
        const size = `${document.querySelectorAll("*").length}:${document.body?.innerText.length ?? 0}`;
        return { ready: document.readyState, pending, size };
      })
      .catch(() => null);

  const isQuiet = (sample: Awaited<ReturnType<typeof probe>>) =>
    // A failed probe (navigation in flight, context torn down) is not stability — keep waiting.
    sample !== null && sample.pending === 0 && sample.ready !== "loading";

  // Fast path: a page that is ALREADY quiet only pays one short confirmation sample. Most actions
  // (typing, opening a menu, picking a suggestion) do not start a fetch, and charging them a full
  // stability loop would add latency to every step of every run.
  const first = await probe();
  if (isQuiet(first)) {
    await page.waitForTimeout(SETTLE_CONFIRM_MS);
    const second = await probe();
    if (isQuiet(second) && second!.size === first!.size) {
      return;
    }
  }

  let previousSize: string | null = first?.size ?? null;
  let stable = 0;
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(SETTLE_SAMPLE_MS);
    const current = await probe();
    if (isQuiet(current) && current!.size === previousSize) {
      stable += 1;
      if (stable >= SETTLE_STABLE_SAMPLES) {
        return;
      }
    } else {
      stable = 0;
    }
    previousSize = current?.size ?? null;
  }
}

const COMMON_OVERLAY_DISMISS_SELECTORS = [
  "#onetrust-reject-all-handler",
  "#onetrust-pc-btn-handler",
  "button:has-text(\"Rifiuta tutto\")",
  "button:has-text(\"Solo necessari\")",
  "button:has-text(\"Reject all\")",
  "button:has-text(\"Necessary only\")",
  "#onetrust-accept-btn-handler",
  "#accept-recommended-btn-handler",
  "button:has-text(\"ACCETTA\")",
  "button:has-text(\"Accetta\")",
  "button:has-text(\"Accetta tutto\")",
  "button:has-text(\"Accetta tutti\")",
  "button:has-text(\"Accept all\")",
];

const COMMON_BACKDROP_SELECTORS = [
  ".offcanvas-backdrop.show",
  ".offcanvas-backdrop",
  ".modal-backdrop.show",
  ".modal-backdrop",
];

async function dismissCommonOverlays(page: Page): Promise<void> {
  for (const selector of COMMON_OVERLAY_DISMISS_SELECTORS) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      continue;
    }
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    const clicked = await locator.click({ timeout: 800 }).then(
      () => true,
      () => false,
    );
    if (clicked) {
      await page.waitForTimeout(150);
      return;
    }
  }
  for (const selector of COMMON_BACKDROP_SELECTORS) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      continue;
    }
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(150);
    const stillVisible = await locator.isVisible().catch(() => false);
    if (!stillVisible) {
      return;
    }
    const clicked = await locator.click({ timeout: 800, force: true }).then(
      () => true,
      () => false,
    );
    if (clicked) {
      await page.waitForTimeout(150);
      return;
    }
  }
}

export function isHeadlessNavigationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "ERR_HTTP2_PROTOCOL_ERROR",
    "ERR_CONNECTION_RESET",
    "ERR_CONNECTION_CLOSED",
    "ERR_EMPTY_RESPONSE",
    "ERR_BLOCKED_BY_CLIENT",
    "ERR_TUNNEL_CONNECTION_FAILED",
  ].some((needle) => message.includes(needle));
}

async function waitForDialog(state: PageState, timeoutMs: number): Promise<Dialog> {
  return await new Promise<Dialog>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const index = state.dialogWaiters.indexOf(resolve);
      if (index >= 0) {
        state.dialogWaiters.splice(index, 1);
      }
      reject(
        new BrowserAutomationError({
          code: "BROWSER_DIALOG_NOT_FOUND",
          message: "no pending dialog",
          retryable: true,
        }),
      );
    }, timeoutMs);
    state.dialogWaiters.push((dialog) => {
      clearTimeout(timeout);
      resolve(dialog);
    });
  });
}
