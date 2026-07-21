import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildHostComputerHelper,
  hostComputerStagingPlan,
} from "../scripts/build-host-computer-helper.mjs";

test("helper bundle has a stable nested-app layout", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "homun-helper-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(outputDir, { recursive: true, force: true });
  });

  const bundle = await buildHostComputerHelper({ configuration: "debug", outputDir });

  assert.equal(
    path.relative(outputDir, bundle.executable),
    "HomunComputerService.app/Contents/MacOS/HomunComputerService",
  );
  assert.equal(bundle.info.CFBundleIdentifier, "app.homun.desktop.computer-service");
  assert.equal(bundle.info.CFBundleExecutable, "HomunComputerService");
  assert.equal(bundle.info.LSUIElement, true);
  assert.equal(bundle.info.LSMinimumSystemVersion, "14.0");
  assert.match(bundle.info.NSAccessibilityUsageDescription, /Homun/);
  assert.match(bundle.info.NSScreenCaptureUsageDescription, /Homun/);
  assert.equal((await stat(bundle.executable)).mode & 0o111, 0o111);
  assert.match(await readFile(bundle.infoPlist, "utf8"), /app\.homun\.desktop\.computer-service/);
});

test("host helper is staged on macOS only", () => {
  assert.deepEqual(hostComputerStagingPlan("darwin"), {
    relativeBundlePath: "host-computer/HomunComputerService.app",
  });
  assert.equal(hostComputerStagingPlan("linux"), null);
  assert.equal(hostComputerStagingPlan("win32"), null);
});

test("desktop packaging stages the helper and passes only its public path", async () => {
  const appRoot = path.resolve(import.meta.dirname, "..");
  const prepare = await readFile(path.join(appRoot, "scripts", "prepare-package.mjs"), "utf8");
  const electron = await readFile(path.join(appRoot, "electron", "main.cjs"), "utf8");

  assert.match(prepare, /buildHostComputerHelper/);
  assert.match(prepare, /host-computer["'],[\s\n]*["']HomunComputerService\.app/);
  assert.match(electron, /HOMUN_HOST_COMPUTER_HELPER_PATH/);
  assert.match(electron, /HOMUN_HOST_COMPUTER !== ["']0["']/);
  assert.match(electron, /env\.HOMUN_HOST_COMPUTER = ["']1["']/);
  assert.doesNotMatch(electron, /HOMUN_HOST_COMPUTER_TOKEN/);
});

test("Mac app access requires an explicit app selection", async () => {
  const source = await readFile(
    path.resolve(import.meta.dirname, "../src/components/SettingsView.tsx"),
    "utf8",
  );
  const styles = await readFile(
    path.resolve(import.meta.dirname, "../src/styles.css"),
    "utf8",
  );

  assert.doesNotMatch(source, /setSelectedBundle\(\(current\).*nextApps\.find/s);
  assert.match(source, /<option value="">\{t\("settings\.computer\.selectApp"\)\}<\/option>/);
  assert.match(styles, /\.set-btn:disabled\s*\{[^}]*cursor:\s*not-allowed;[^}]*opacity:/s);
});

test("assembled helper authenticates a real Unix-socket handshake", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "homun-helper-e2e-build-"));
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "homun-helper-e2e-run-"));
  const { chmod, rm } = await import("node:fs/promises");
  await chmod(runtimeDir, 0o700);
  let helperPid = null;
  t.after(async () => {
    if (helperPid) {
      try { process.kill(helperPid, "SIGTERM"); } catch { /* already exited */ }
    }
    await rm(outputDir, { recursive: true, force: true });
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const bundle = await buildHostComputerHelper({ configuration: "debug", outputDir });
  const socketPath = path.join(runtimeDir, "computer.sock");
  const tokenPath = path.join(runtimeDir, "session-token");
  const token = randomBytes(32).toString("hex");
  await writeFile(tokenPath, token, { mode: 0o600 });
  const opened = spawn(
    "/usr/bin/open",
    [
      "-n", "-a", bundle.bundle, "--args",
      "--socket", socketPath,
      "--auth-token-file", tokenPath,
      "--parent-pid", String(process.pid),
    ],
    { stdio: "ignore" },
  );
  assert.equal(await new Promise((resolve) => opened.once("exit", resolve)), 0);
  await waitForSocket(socketPath);

  const response = await rpc(socketPath, {
    jsonrpc: "2.0",
    id: 41,
    method: "handshake",
    params: {},
    meta: {
      protocol_version: 1,
      turn_id: "turn_e2e",
      deadline_unix_ms: Date.now() + 5_000,
      session_token: token,
    },
  });

  helperPid = response.result.helper_pid;
  assert.equal(response.id, 41);
  assert.equal(response.result.protocol_version, 1);
  assert.ok(helperPid > 0);
  await assert.rejects(stat(tokenPath), { code: "ENOENT" });
});

async function waitForSocket(socketPath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await stat(socketPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`helper socket did not appear: ${socketPath}`);
}

async function rpc(socketPath, request) {
  const payload = Buffer.from(JSON.stringify(request));
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = [];
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      const response = Buffer.concat(chunks);
      const length = response.readUInt32BE(0);
      resolve(JSON.parse(response.subarray(4, 4 + length).toString("utf8")));
    });
    socket.on("error", reject);
  });
}
