import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { BrowserAutomationError } from "../contracts.js";

const MAC_EXECUTABLES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

export type BrowserProfileConfig = {
  name: string;
  userDataDir: string;
  headless: boolean;
  executablePath: string;
};

export type BrowserProfileSummary = {
  name: "assistant" | "user";
  status: string;
  headless: boolean;
  mode: "managed" | "attach_only";
};

export async function resolveAssistantProfile(options?: {
  headless?: boolean;
  executablePath?: string;
  profileRoot?: string;
}): Promise<BrowserProfileConfig> {
  return {
    name: "assistant",
    userDataDir:
      options?.profileRoot ??
      process.env.BROWSER_AUTOMATION_PROFILE_ROOT ??
      path.join(os.tmpdir(), "local-first-browser-automation", `assistant-${process.pid}`),
    headless: options?.headless ?? true,
    executablePath: await discoverChromiumExecutable(options?.executablePath),
  };
}

export function profileSummaries(params: {
  assistantRunning: boolean;
  userRunning: boolean;
  assistantHeadless: boolean;
  userCdpEndpoint?: string;
}): BrowserProfileSummary[] {
  return [
    {
      name: "assistant",
      status: params.assistantRunning ? "running" : "stopped",
      headless: params.assistantHeadless,
      mode: "managed",
    },
    {
      name: "user",
      status: params.userRunning
        ? "running"
        : params.userCdpEndpoint
          ? "available"
          : "needs_cdp_endpoint",
      headless: false,
      mode: "attach_only",
    },
  ];
}

export async function discoverChromiumExecutable(explicit?: string): Promise<string> {
  const candidates = [
    explicit,
    process.env.BROWSER_EXECUTABLE_PATH,
    ...MAC_EXECUTABLES,
    chromium.executablePath(),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new BrowserAutomationError({
    code: "BROWSER_EXECUTABLE_NOT_FOUND",
    message: "No Chromium-based browser executable was found",
    retryable: false,
    manualActionRequired: true,
  });
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}
