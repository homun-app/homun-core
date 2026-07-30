import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, Server } from "node:http";
import { createInterface, Interface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserMethod, BrowserResponse } from "../src/contracts.js";
import { BrowserCheckpoint } from "../src/browser/session_manager.js";
import { discoverChromiumExecutable } from "../src/browser/profiles.js";

type SnapshotResult = {
  snapshot: string;
  generation: number;
  refs: Array<{ ref: string; name?: string }>;
};

type RestoreResult = {
  tier: string;
  targetId: string;
  generation: number;
};

class SidecarRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

class StdioSidecar {
  private readonly lines: Interface;
  private readonly pending = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 1;
  private stderr = "";

  private constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.acceptLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      const error = new Error(
        `browser sidecar exited before replying (code=${code}, signal=${signal})${detail ? `: ${detail}` : ""}`,
      );
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      this.pending.clear();
    });
  }

  static async start(endpoint: string, browserEpoch: string): Promise<StdioSidecar> {
    const child = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BROWSER_AUTOMATION_ALLOW_PRIVATE_NETWORK: "1",
          BROWSER_AUTOMATION_USER_CDP_ENDPOINT: endpoint,
          BROWSER_AUTOMATION_BROWSER_EPOCH: browserEpoch,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const sidecar = new StdioSidecar(child);
    await sidecar.call("browser.health");
    return sidecar;
  }

  call<T>(method: BrowserMethod, params?: Record<string, unknown>): Promise<T> {
    const id = `req_${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`browser sidecar request timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timeout,
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async hardKill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGKILL");
    await exited;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await this.call("browser.stop").catch(() => undefined);
    const exited = once(this.child, "exit");
    this.child.stdin.end();
    await exited;
  }

  private acceptLine(line: string): void {
    const response = JSON.parse(line) as BrowserResponse;
    const request = this.pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timeout);
    this.pending.delete(response.id);
    if (response.ok) {
      request.resolve(response.result);
      return;
    }
    request.reject(new SidecarRequestError(response.error.code, response.error.message));
  }
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to reserve CDP port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitForCdp(endpoint: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) return;
    } catch {
      // Chromium is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("CDP browser did not start");
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

describe("browser sidecar crash recovery over stdio", () => {
  it("adopts the exact live CDP target after a hard process crash", async () => {
    const fixtureHtml = await readFile(
      path.join(import.meta.dirname, "fixtures", "form.html"),
      "utf8",
    );
    const fixtureServer: Server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(fixtureHtml);
    });
    await new Promise<void>((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
    const fixtureAddress = fixtureServer.address();
    if (!fixtureAddress || typeof fixtureAddress === "string") {
      throw new Error("fixture server did not start");
    }
    const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}`;

    const cdpPort = await reservePort();
    const profile = await mkdtemp(path.join(tmpdir(), "homun-sidecar-crash-"));
    const chromium = spawn(await discoverChromiumExecutable(), [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ]);
    const endpoint = `http://127.0.0.1:${cdpPort}`;
    const browserEpoch = "process-crash-browser-epoch";
    let firstSidecar: StdioSidecar | undefined;
    let replacementSidecar: StdioSidecar | undefined;

    try {
      await waitForCdp(endpoint);
      firstSidecar = await StdioSidecar.start(endpoint, browserEpoch);
      await firstSidecar.call("browser.open", {
        url: fixtureUrl,
        label: "crash-recovery",
      });
      const before = await firstSidecar.call<SnapshotResult>("browser.snapshot", {
        target_id: "crash-recovery",
      });
      const oldNameRef = before.refs.find((ref) => ref.name === "Name")?.ref;
      expect(oldNameRef).toMatch(/^e/);
      await firstSidecar.call("browser.act", {
        target_id: "crash-recovery",
        kind: "fill",
        ref: oldNameRef,
        text: "Ada survives a hard sidecar crash",
        generation: before.generation,
      });
      const checkpoint = await firstSidecar.call<BrowserCheckpoint>("browser.checkpoint", {
        target_id: "crash-recovery",
      });
      expect(checkpoint.cdpTargetId).toBeTruthy();

      await firstSidecar.hardKill();
      const liveTargets = (await (await fetch(`${endpoint}/json/list`)).json()) as Array<{
        id: string;
        url: string;
      }>;
      const liveTarget = liveTargets.find((target) => target.id === checkpoint.cdpTargetId);
      expect(liveTarget).toBeDefined();
      expect(new URL(liveTarget!.url).origin).toBe(new URL(fixtureUrl).origin);

      replacementSidecar = await StdioSidecar.start(endpoint, browserEpoch);
      const restored = await replacementSidecar.call<RestoreResult>("browser.restore", {
        target_id: checkpoint.targetId,
        url: checkpoint.url,
        origin: checkpoint.origin,
        browser_epoch: checkpoint.browserEpoch,
        cdp_target_id: checkpoint.cdpTargetId,
        generation: checkpoint.generation,
      });
      expect(restored).toMatchObject({
        tier: "adopted_live_page",
        targetId: checkpoint.targetId,
        generation: checkpoint.generation,
      });

      const after = await replacementSidecar.call<SnapshotResult>("browser.snapshot", {
        target_id: checkpoint.targetId,
      });
      expect(after.generation).toBe(checkpoint.generation + 1);
      expect(after.snapshot).toContain("Ada survives a hard sidecar crash");
      await expect(
        replacementSidecar.call("browser.act", {
          target_id: checkpoint.targetId,
          kind: "fill",
          ref: oldNameRef,
          text: "must not use a pre-crash observation",
          generation: checkpoint.generation,
        }),
      ).rejects.toMatchObject({ code: "BROWSER_STALE_GENERATION" });
    } finally {
      await firstSidecar?.hardKill();
      await replacementSidecar?.stop();
      await stopProcess(chromium);
      fixtureServer.closeAllConnections();
      await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  });
});
