import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Dialog, Locator, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { BrowserAutomationError } from "../contracts.js";
import { executeAction, requireRef, type BrowserActRequest, type BrowserActionResult } from "./actions.js";
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
};

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
  }> {
    const state = await this.resolvePage(params.targetId);
    await dismissCommonOverlays(state.page);
    const snapshot = await createSnapshot(state.page, params.targetId, params);
    state.refs = snapshot.refLocators;
    return {
      targetId: snapshot.targetId,
      url: snapshot.url,
      snapshot: snapshot.snapshot,
      refs: snapshot.refs,
      refsMode: snapshot.refsMode,
      snapshotFormat: snapshot.snapshotFormat,
      stats: snapshot.stats,
    };
  }

  async act(action: BrowserActRequest): Promise<BrowserActionResult> {
    const state = await this.resolvePage(action.targetId);
    await dismissCommonOverlays(state.page);
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
    const snapshot = await createSnapshot(state.page, action.targetId);
    state.refs = snapshot.refLocators;
    return {
      ...result,
      targetId: snapshot.targetId,
      snapshot: snapshot.snapshot,
      refs: snapshot.refs,
      refsMode: snapshot.refsMode,
      snapshotFormat: snapshot.snapshotFormat,
      stats: snapshot.stats,
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


  private createPageState(page: Page, label?: string): PageState {
    const state: PageState = {
      page,
      label,
      refs: new Map(),
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
    this.activeProfile = "user";
    return { status: "started", profile: "user" };
  }
}

async function artifactMetadata(kind: ArtifactMetadata["kind"], outputPath: string): Promise<ArtifactMetadata> {
  const file = await stat(outputPath);
  return { kind, path: outputPath, bytes: file.size };
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
  await page.waitForTimeout(250);
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
