import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureDevBrowserAutomationRuntime } from "./browser-runtime.mjs";
import { ensureDevPdfiumRuntime } from "./pdfium-runtime.mjs";
import { resolveGatewayToken } from "../electron/lib/gateway-token.cjs";

const devUrl = process.env.HOMUN_DESKTOP_URL ?? "http://127.0.0.1:1420/";

const gatewayToken = resolveGatewayToken();
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const children = new Set();

// Keep dev behavior aligned with packaged builds. This downloads the pinned
// runtime once, then reuses the verified local copy on subsequent launches.
const pdfiumDir = process.env.HOMUN_PDFIUM_LIB ?? await ensureDevPdfiumRuntime();
const browserAutomationDir = ensureDevBrowserAutomationRuntime();

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

async function waitForDevServer(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite dev server not reachable at ${url}`);
}

function stopGatewayOnPort() {
  const port = process.env.HOMUN_DESKTOP_GATEWAY_PORT ?? "18765";
  const result = spawnSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  const pids = result.stdout
    .split(/\s+/)
    .map((pid) => pid.trim())
    .filter(Boolean);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}

function shutdown(exitCode = 0) {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

stopGatewayOnPort();

run("npm", ["run", "dev"], {
  env: {
    ...process.env,
    HOMUN_DESKTOP_GATEWAY_TOKEN: gatewayToken,
    VITE_HOMUN_DESKTOP_GATEWAY_TOKEN: gatewayToken,
  },
});
await waitForDevServer(devUrl);

const electron = run("npx", ["electron", "electron/main.cjs"], {
  env: {
    ...process.env,
    HOMUN_DESKTOP_URL: devUrl,
    HOMUN_DESKTOP_GATEWAY_TOKEN: gatewayToken,
    HOMUN_PDFIUM_LIB: pdfiumDir,
    HOMUN_BROWSER_AUTOMATION_DIR: browserAutomationDir,
  },
});

electron.on("exit", (code) => shutdown(code ?? 0));
