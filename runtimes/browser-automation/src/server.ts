import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  BrowserAutomationError,
  BrowserRequest,
  makeErrorResponse,
  makeSuccessResponse,
  parseRequestLine,
  serializeResponseLine,
} from "./contracts.js";
import { BrowserSessionManager } from "./browser/session_manager.js";

const manager = new BrowserSessionManager({
  headless: process.env.BROWSER_AUTOMATION_HEADLESS !== "0",
  allowPrivateNetwork: process.env.BROWSER_AUTOMATION_ALLOW_PRIVATE_NETWORK === "1",
  profileRoot: process.env.BROWSER_AUTOMATION_PROFILE_ROOT,
  artifactRoot: process.env.BROWSER_AUTOMATION_ARTIFACT_ROOT,
  uploadRoots: process.env.BROWSER_AUTOMATION_UPLOAD_ROOTS?.split(":").filter(Boolean),
  userCdpEndpoint: process.env.BROWSER_AUTOMATION_USER_CDP_ENDPOINT,
  isolatedContext: process.env.BROWSER_AUTOMATION_ISOLATED_CONTEXT === "1",
});

export async function handleRequestLine(line: string): Promise<string> {
  let request: BrowserRequest | undefined;
  try {
    request = parseRequestLine(line);
    const result = await dispatch(request);
    return serializeResponseLine(makeSuccessResponse(request.id, result));
  } catch (error) {
    return serializeResponseLine(makeErrorResponse(request?.id ?? "unknown", error));
  }
}

async function dispatch(request: BrowserRequest): Promise<unknown> {
  switch (request.method) {
    case "browser.health":
      return {
        status: "ready",
        transport: "stdio",
      };
    case "browser.profiles":
      return { profiles: await manager.profiles() };
    case "browser.start":
      return await manager.start({
        profile: optionalProfile(request.params, "profile"),
      });
    case "browser.stop":
      await manager.stop();
      return { status: "stopped" };
    case "browser.tabs":
      return { tabs: await manager.tabs() };
    case "browser.focus":
      return await manager.focus({
        targetId: requireString(request.params, "target_id"),
      });
    case "browser.close_tab":
      return await manager.closeTab({
        targetId: requireString(request.params, "target_id"),
      });
    case "browser.open":
      return await manager.open({
        url: requireString(request.params, "url"),
        label: optionalString(request.params, "label"),
      });
    case "browser.navigate":
      return await manager.navigate({
        targetId: requireString(request.params, "target_id"),
        url: requireString(request.params, "url"),
      });
    case "browser.snapshot":
      return await manager.snapshot({
        targetId: requireString(request.params, "target_id"),
        snapshotFormat: optionalSnapshotFormat(request.params, "snapshot_format"),
        refsMode: optionalRefsMode(request.params, "refs_mode"),
        mode: optionalSnapshotMode(request.params, "mode"),
        interactive: optionalBoolean(request.params, "interactive"),
        compact: optionalBoolean(request.params, "compact"),
        depth: optionalNumber(request.params, "depth"),
        timeoutMs: optionalNumber(request.params, "timeout_ms"),
        maxChars: optionalNumber(request.params, "max_chars"),
        urls: optionalBoolean(request.params, "urls"),
      });
    case "browser.act":
      return await manager.act({
        ...(request.params ?? {}),
        targetId: requireString(request.params, "target_id"),
      } as never);
    case "browser.screenshot":
      return await manager.screenshot({
        targetId: requireString(request.params, "target_id"),
        fileName: requireString(request.params, "file_name"),
        fullPage: optionalBoolean(request.params, "full_page"),
      });
    case "browser.arm_file_chooser":
      return await manager.armFileChooser({
        targetId: requireString(request.params, "target_id"),
        files: requireStringArray(request.params, "files"),
      });
    case "browser.respond_dialog":
      return await manager.respondDialog({
        targetId: requireString(request.params, "target_id"),
        accept: optionalBoolean(request.params, "accept") ?? true,
        promptText: optionalString(request.params, "prompt_text"),
        timeoutMs: optionalNumber(request.params, "timeout_ms"),
      });
    case "browser.wait_download":
      return await manager.waitDownload({
        targetId: requireString(request.params, "target_id"),
        fileName: optionalString(request.params, "file_name"),
        action: optionalObject(request.params, "action") as never,
        timeoutMs: optionalNumber(request.params, "timeout_ms"),
      });
    case "browser.console":
      return await manager.console({
        targetId: requireString(request.params, "target_id"),
        limit: optionalNumber(request.params, "limit"),
      });
    case "browser.pdf":
      return await manager.pdf({
        targetId: requireString(request.params, "target_id"),
        fileName: requireString(request.params, "file_name"),
        format: optionalString(request.params, "format"),
      });
    default:
      throw new BrowserAutomationError({
        code: "BROWSER_NOT_IMPLEMENTED",
        message: `${request.method} is not implemented`,
        retryable: false,
      });
  }
}

function requireString(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new BrowserAutomationError({
      code: "BROWSER_INVALID_REQUEST",
      message: `${key} is required`,
      retryable: false,
    });
  }
  return value;
}

function optionalString(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalBoolean(params: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = params?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(params: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = params?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalObject(
  params: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = params?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireStringArray(params: Record<string, unknown> | undefined, key: string): string[] {
  const value = params?.[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string" && entry.trim() !== "")
  ) {
    throw new BrowserAutomationError({
      code: "BROWSER_INVALID_REQUEST",
      message: `${key} must be a non-empty string array`,
      retryable: false,
    });
  }
  return value;
}

function optionalProfile(
  params: Record<string, unknown> | undefined,
  key: string,
): "assistant" | "user" | undefined {
  const value = params?.[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === "assistant" || value === "user") {
    return value;
  }
  throw new BrowserAutomationError({
    code: "BROWSER_INVALID_REQUEST",
    message: `${key} must be assistant or user`,
    retryable: false,
  });
}

function optionalSnapshotFormat(
  params: Record<string, unknown> | undefined,
  key: string,
): "ai" | "legacy" | undefined {
  const value = params?.[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === "ai" || value === "legacy") {
    return value;
  }
  throw new BrowserAutomationError({
    code: "BROWSER_INVALID_REQUEST",
    message: `${key} must be ai or legacy`,
    retryable: false,
  });
}

function optionalRefsMode(
  params: Record<string, unknown> | undefined,
  key: string,
): "aria" | "locator" | undefined {
  const value = params?.[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === "aria" || value === "locator") {
    return value;
  }
  throw new BrowserAutomationError({
    code: "BROWSER_INVALID_REQUEST",
    message: `${key} must be aria or locator`,
    retryable: false,
  });
}

function optionalSnapshotMode(
  params: Record<string, unknown> | undefined,
  key: string,
): "efficient" | undefined {
  const value = params?.[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === "efficient") {
    return value;
  }
  throw new BrowserAutomationError({
    code: "BROWSER_INVALID_REQUEST",
    message: `${key} must be efficient`,
    retryable: false,
  });
}

async function main() {
  // Tear the browser down on any exit path so Chromium is never orphaned:
  // a clean stdin EOF (parent closed the pipe) or a termination signal.
  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await manager.stop().catch(() => undefined);
    process.exit(code);
  };
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));

  const rl = createInterface({ input });
  for await (const line of rl) {
    output.write(await handleRequestLine(line));
  }
  // stdin closed (parent gone): stop the browser and exit cleanly.
  await shutdown(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
