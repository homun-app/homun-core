import { mkdir } from "node:fs/promises";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { BrowserAutomationError } from "../contracts.js";
import { executeAction, type BrowserActRequest } from "./actions.js";
import { assertNavigationAllowed } from "./navigation_guard.js";
import { resolveAssistantProfile, type BrowserProfileConfig } from "./profiles.js";
import { createSnapshot, type BrowserRef } from "./snapshot.js";

export type BrowserSessionOptions = {
  headless?: boolean;
  allowPrivateNetwork?: boolean;
  executablePath?: string;
  profileRoot?: string;
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
};

export class BrowserSessionManager {
  private readonly options: BrowserSessionOptions;
  private context?: BrowserContext;
  private profile?: BrowserProfileConfig;
  private pages = new Map<string, PageState>();
  private nextTargetId = 1;

  constructor(options?: BrowserSessionOptions) {
    this.options = options ?? {};
  }

  async start(): Promise<{ status: "started"; profile: string }> {
    if (this.context) {
      return { status: "started", profile: "assistant" };
    }
    this.profile = await resolveAssistantProfile(this.options);
    await mkdir(this.profile.userDataDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.profile.userDataDir, {
      headless: this.profile.headless,
      executablePath: this.profile.executablePath,
    });
    return { status: "started", profile: this.profile.name };
  }

  async stop(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.pages.clear();
  }

  async profiles(): Promise<Array<{ name: string; status: string; headless: boolean }>> {
    const profile = this.profile ?? (await resolveAssistantProfile(this.options));
    return [{ name: "assistant", status: this.context ? "running" : "stopped", headless: profile.headless }];
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
    await page.goto(params.url);
    this.pages.set(targetId, { page, label: params.label, refs: new Map() });
    return { targetId, url: page.url(), ...(params.label ? { label: params.label } : {}) };
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
    return await executeAction(state.page, state.refs, action);
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
}
