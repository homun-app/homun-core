import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Dialog, Locator, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { BrowserAutomationError } from "../contracts.js";
import { executeAction, requireRef, type BrowserActRequest } from "./actions.js";
import { BrowserArtifactRoot } from "./artifacts.js";
import { assertNavigationAllowed } from "./navigation_guard.js";
import {
  profileSummaries,
  resolveAssistantProfile,
  type BrowserProfileConfig,
  type BrowserProfileSummary,
} from "./profiles.js";
import { createSnapshot, type BrowserRef } from "./snapshot.js";

export type BrowserSessionOptions = {
  headless?: boolean;
  allowPrivateNetwork?: boolean;
  executablePath?: string;
  profileRoot?: string;
  artifactRoot?: string;
  uploadRoots?: string[];
  userCdpEndpoint?: string;
};

export type BrowserTab = {
  targetId: string;
  url: string;
  label?: string;
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

export class BrowserSessionManager {
  private readonly options: BrowserSessionOptions;
  private context?: BrowserContext;
  private attachedBrowser?: Browser;
  private activeProfile: "assistant" | "user" = "assistant";
  private profile?: BrowserProfileConfig;
  private artifactRoot?: BrowserArtifactRoot;
  private pages = new Map<string, PageState>();
  private nextTargetId = 1;

  constructor(options?: BrowserSessionOptions) {
    this.options = options ?? {};
  }

  async start(params?: { profile?: "assistant" | "user" }): Promise<{ status: "started"; profile: string }> {
    if (this.context) {
      return { status: "started", profile: this.activeProfile };
    }
    const profile = params?.profile ?? "assistant";
    if (profile === "user") {
      return await this.startUserProfile();
    }
    this.profile = await resolveAssistantProfile(this.options);
    await mkdir(this.profile.userDataDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.profile.userDataDir, {
      headless: this.profile.headless,
      executablePath: this.profile.executablePath,
      acceptDownloads: true,
    });
    this.activeProfile = "assistant";
    return { status: "started", profile: this.profile.name };
  }

  async stop(): Promise<void> {
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
    const existing = this.pages.get(targetId);
    const page = existing?.page ?? (await this.requireContext().newPage());
    const state = existing ?? this.createPageState(page, params.label);
    this.pages.set(targetId, state);
    await page.goto(params.url);
    return { targetId, url: page.url(), ...(params.label ? { label: params.label } : {}) };
  }

  async focus(params: { targetId: string }): Promise<BrowserTab> {
    const state = this.requirePage(params.targetId);
    await state.page.bringToFront();
    return {
      targetId: params.targetId,
      url: state.page.url(),
      ...(state.label ? { label: state.label } : {}),
    };
  }

  async closeTab(params: { targetId: string }): Promise<{ closed: true; targetId: string }> {
    const state = this.requirePage(params.targetId);
    await state.page.close();
    this.pages.delete(params.targetId);
    return { closed: true, targetId: params.targetId };
  }

  async navigate(params: { targetId: string; url: string }): Promise<BrowserTab> {
    await assertNavigationAllowed({
      url: params.url,
      allowPrivateNetwork: this.options.allowPrivateNetwork,
    });
    const state = this.requirePage(params.targetId);
    await state.page.goto(params.url);
    state.refs.clear();
    return {
      targetId: params.targetId,
      url: state.page.url(),
      ...(state.label ? { label: state.label } : {}),
    };
  }

  async snapshot(params: { targetId: string }): Promise<{
    targetId: string;
    url: string;
    snapshot: string;
    refs: BrowserRef[];
  }> {
    const state = this.requirePage(params.targetId);
    const snapshot = await createSnapshot(state.page, params.targetId);
    state.refs = snapshot.refLocators;
    return {
      targetId: snapshot.targetId,
      url: snapshot.url,
      snapshot: snapshot.snapshot,
      refs: snapshot.refs,
    };
  }

  async act(action: BrowserActRequest): Promise<{ ok: true; url: string }> {
    const state = this.requirePage(action.targetId);
    if (action.kind === "click" && state.armedFileChooser) {
      const files = state.armedFileChooser;
      state.armedFileChooser = undefined;
      const chooserPromise = state.page.waitForEvent("filechooser", { timeout: 10_000 });
      const clickPromise = requireRef(state.refs, action.ref).click();
      const chooser = await chooserPromise;
      await chooser.setFiles(files);
      await clickPromise;
      return { ok: true, url: state.page.url() };
    }
    return await executeAction(state.page, state.refs, action);
  }

  async screenshot(params: {
    targetId: string;
    fileName: string;
    fullPage?: boolean;
  }): Promise<ArtifactMetadata> {
    const state = this.requirePage(params.targetId);
    const root = this.requireArtifactRoot();
    await root.ensureKind("screenshots");
    const outputPath = root.outputPath("screenshots", params.fileName);
    await state.page.screenshot({ path: outputPath, fullPage: params.fullPage ?? false });
    return await artifactMetadata("screenshots", outputPath);
  }

  async pdf(params: { targetId: string; fileName: string; format?: string }): Promise<ArtifactMetadata> {
    const state = this.requirePage(params.targetId);
    const root = this.requireArtifactRoot();
    await root.ensureKind("pdf");
    const outputPath = root.outputPath("pdf", params.fileName);
    await state.page.pdf({ path: outputPath, format: params.format ?? "A4" });
    return await artifactMetadata("pdf", outputPath);
  }

  async console(params: { targetId: string; limit?: number }): Promise<{ messages: ConsoleEntry[] }> {
    const state = this.requirePage(params.targetId);
    const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
    return { messages: state.consoleMessages.slice(-limit) };
  }

  async respondDialog(params: {
    targetId: string;
    accept: boolean;
    promptText?: string;
    timeoutMs?: number;
  }): Promise<{ handled: true; message: string }> {
    const state = this.requirePage(params.targetId);
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
    const state = this.requirePage(params.targetId);
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
    const state = this.requirePage(params.targetId);
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

  private requirePage(targetId: string): PageState {
    const state = this.pages.get(targetId);
    if (!state) {
      throw new BrowserAutomationError({
        code: "BROWSER_TAB_NOT_FOUND",
        message: `tab not found: ${targetId}`,
        retryable: false,
      });
    }
    return state;
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
    this.context =
      this.attachedBrowser.contexts()[0] ??
      (await this.attachedBrowser.newContext({ acceptDownloads: true }));
    this.activeProfile = "user";
    return { status: "started", profile: "user" };
  }
}

async function artifactMetadata(kind: ArtifactMetadata["kind"], outputPath: string): Promise<ArtifactMetadata> {
  const file = await stat(outputPath);
  return { kind, path: outputPath, bytes: file.size };
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
