const { app, BrowserWindow, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DEV_SERVER_URL = process.env.LOCAL_FIRST_DESKTOP_URL ?? "http://127.0.0.1:1420/";
const GATEWAY_PORT = process.env.LOCAL_FIRST_DESKTOP_GATEWAY_PORT ?? "18765";
const GATEWAY_URL =
  process.env.LOCAL_FIRST_DESKTOP_GATEWAY_URL ?? `http://127.0.0.1:${GATEWAY_PORT}`;
const GATEWAY_TOKEN =
  process.env.LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN ?? randomBytes(32).toString("hex");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const RESOURCES_ROOT =
  process.env.LOCAL_FIRST_DESKTOP_RESOURCES_DIR ??
  (app.isPackaged ? process.resourcesPath : REPO_ROOT);
let gatewayProcess = null;
let isQuitting = false;

process.env.LOCAL_FIRST_DESKTOP_GATEWAY_URL = GATEWAY_URL;
process.env.LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN = GATEWAY_TOKEN;

function normalizeGatewayUrl(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function gatewayHealthUrl() {
  return new URL("/api/health", normalizeGatewayUrl(GATEWAY_URL)).toString();
}

async function waitForGateway(timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(gatewayHealthUrl(), { method: "GET" });
      if (response.ok) return;
    } catch {
      // Gateway process may still be starting or Cargo may still be compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Desktop gateway not reachable at ${gatewayHealthUrl()}`);
}

async function isGatewayUsable() {
  try {
    const health = await fetch(gatewayHealthUrl(), { method: "GET" });
    if (!health.ok) return false;
    const body = await health.json();
    if (!body.auth_required) return true;

    const response = await fetch(
      new URL("/api/chat/threads", normalizeGatewayUrl(GATEWAY_URL)).toString(),
      { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } },
    );
    return response.ok;
  } catch {
    return false;
  }
}

function gatewayBinaryPath() {
  if (process.env.LOCAL_FIRST_DESKTOP_GATEWAY_BIN) {
    return process.env.LOCAL_FIRST_DESKTOP_GATEWAY_BIN;
  }

  const executable = process.platform === "win32"
    ? "local-first-desktop-gateway.exe"
    : "local-first-desktop-gateway";
  const packagedPath = path.join(RESOURCES_ROOT, "bin", executable);
  if ((app.isPackaged || process.env.LOCAL_FIRST_DESKTOP_RESOURCES_DIR) && fs.existsSync(packagedPath)) {
    return packagedPath;
  }

  return null;
}

function stopStaleGatewayOnPort() {
  if (process.platform === "win32") return;
  const result = spawnSync("lsof", [`-tiTCP:${GATEWAY_PORT}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  for (const rawPid of result.stdout.split(/\s+/)) {
    const pid = Number(rawPid.trim());
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited or is not owned by this user.
    }
  }
}

function spawnGateway() {
  const gatewayBin = gatewayBinaryPath();
  const workspaceRoot = process.env.LOCAL_FIRST_WORKSPACE_ROOT ??
    ((app.isPackaged || process.env.LOCAL_FIRST_DESKTOP_RESOURCES_DIR)
      ? RESOURCES_ROOT
      : REPO_ROOT);
  const packagedPythonVenv = path.join(RESOURCES_ROOT, ".venv-mlx");
  const processLogDir = path.join(app.getPath("userData"), "logs", "processes");
  const env = {
    ...process.env,
    LOCAL_FIRST_DESKTOP_GATEWAY_PORT: GATEWAY_PORT,
    LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN: GATEWAY_TOKEN,
    LOCAL_FIRST_WORKSPACE_ROOT: workspaceRoot,
    LOCAL_FIRST_PROCESS_LOG_DIR: processLogDir,
    ...(app.isPackaged && fs.existsSync(packagedPythonVenv)
      ? { LOCAL_FIRST_GEMMA_PYTHON_VENV: packagedPythonVenv }
      : {}),
  };

  if (gatewayBin) {
    gatewayProcess = spawn(gatewayBin, [], {
      cwd: REPO_ROOT,
      env,
      stdio: app.isPackaged ? "ignore" : "inherit",
      windowsHide: true,
    });
  } else {
    gatewayProcess = spawn("cargo", ["run", "-p", "local-first-desktop-gateway"], {
      cwd: REPO_ROOT,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
  }

  gatewayProcess.on("exit", () => {
    gatewayProcess = null;
    if (!isQuitting) {
      console.error("Desktop gateway exited unexpectedly");
    }
  });
}

async function ensureGateway() {
  if (await isGatewayUsable()) return;
  stopStaleGatewayOnPort();
  spawnGateway();
  await waitForGateway();
}

function rendererEntry() {
  if (process.env.LOCAL_FIRST_DESKTOP_URL) {
    return { kind: "url", value: DEV_SERVER_URL };
  }

  const indexPath = path.join(__dirname, "..", "dist", "index.html");
  return { kind: "url", value: pathToFileURL(indexPath).toString() };
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: "Local First Assistant",
    backgroundColor: "#ffffff",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const entry = rendererEntry();
  void window.loadURL(entry.value);

  if (process.env.LOCAL_FIRST_ELECTRON_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(async () => {
  await ensureGateway();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (gatewayProcess && !gatewayProcess.killed) {
    gatewayProcess.kill("SIGTERM");
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
