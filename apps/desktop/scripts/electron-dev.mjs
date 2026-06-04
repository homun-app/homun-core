import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const devUrl = process.env.LOCAL_FIRST_DESKTOP_URL ?? "http://127.0.0.1:1420/";

// Stable dev token: reuse the SAME 0600 file the gateway persists
// (~/.local-first-personal-assistant/desktop-gateway-token) instead of minting
// a fresh random token each launch. This keeps the token constant across
// gateway restarts, so long-lived children (e.g. the WhatsApp sidecar) keep a
// valid WA_GATEWAY_TOKEN and don't need to be reconnected after every restart.
function resolveGatewayToken() {
  const fromEnv = (process.env.LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  const dir = join(homedir(), ".local-first-personal-assistant");
  const tokenPath = join(dir, "desktop-gateway-token");
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // No persisted token yet — fall through to generate one.
  }
  const token = randomBytes(32).toString("hex");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch {
    // Non-fatal: fall back to an ephemeral in-memory token for this run.
  }
  return token;
}

const gatewayToken = resolveGatewayToken();
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const children = new Set();

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
  const port = process.env.LOCAL_FIRST_DESKTOP_GATEWAY_PORT ?? "18765";
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
    LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN: gatewayToken,
    VITE_LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN: gatewayToken,
  },
});
await waitForDevServer(devUrl);

const electron = run("npx", ["electron", "electron/main.cjs"], {
  env: {
    ...process.env,
    LOCAL_FIRST_DESKTOP_URL: devUrl,
    LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN: gatewayToken,
  },
});

electron.on("exit", (code) => shutdown(code ?? 0));
