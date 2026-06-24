const { app, BrowserWindow, Menu, shell, ipcMain, dialog, nativeImage, powerSaveBlocker } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DEV_SERVER_URL = process.env.HOMUN_DESKTOP_URL ?? "http://127.0.0.1:1420/";
const GATEWAY_PORT = process.env.HOMUN_DESKTOP_GATEWAY_PORT ?? "18765";
const GATEWAY_URL =
  process.env.HOMUN_DESKTOP_GATEWAY_URL ?? `http://127.0.0.1:${GATEWAY_PORT}`;
const GATEWAY_TOKEN =
  process.env.HOMUN_DESKTOP_GATEWAY_TOKEN ?? randomBytes(32).toString("hex");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const RESOURCES_ROOT =
  process.env.HOMUN_DESKTOP_RESOURCES_DIR ??
  (app.isPackaged ? process.resourcesPath : REPO_ROOT);
let gatewayProcess = null;
let isQuitting = false;

// Brand icon (Homun pictogram on a white rounded square). Used as the window
// icon on Windows/Linux and as the macOS dock icon in dev. macOS ignores the
// BrowserWindow `icon` option, so the dock icon must be set explicitly via
// app.dock.setIcon. Resolved from staged resources when packaged, otherwise
// from the repo assets folder.
function brandIconPath() {
  const candidates = [
    path.join(RESOURCES_ROOT, "assets", "brand", "icon.png"),
    path.join(__dirname, "..", "assets", "brand", "icon.png"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

process.env.HOMUN_DESKTOP_GATEWAY_URL = GATEWAY_URL;
process.env.HOMUN_DESKTOP_GATEWAY_TOKEN = GATEWAY_TOKEN;

// Product/display name (macOS menu bar, About panel, dock tooltip). Set early,
// before the app is ready, so the menu reflects it. Technical identifiers
// (crate/binary "local-first-desktop-gateway", HOMUN_* env) are unchanged.
app.setName("Homun");

// Public page where each release's notes live (also where electron-updater pulls
// installers from). Surfaced from the "About" menu and the Settings version card.
const RELEASES_URL = "https://github.com/homun-app/homun-releases/releases";

// Native "About Homun" panel (⌘-menu → About). Without this, macOS shows a bare
// panel; here we stamp the real version so the user can always confirm which
// build they're running — the single source of the "am I on 1019?" truth.
app.setAboutPanelOptions({
  applicationName: "Homun",
  applicationVersion: app.getVersion(),
  copyright: "© 2026 Homun",
  website: RELEASES_URL,
});

// In dev the macOS menu bar shows the bundle name ("Electron") unless we install a
// custom application menu — its first submenu label follows app.getName() ("Homun").
// Standard roles are kept so copy/paste/zoom/window shortcuts still work.
function applyAppMenu() {
  if (process.platform !== "darwin") return;
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Note di rilascio…",
          click: () => void shell.openExternal(RELEASES_URL),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Modifica",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Vista",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { label: "Finestra", role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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
  if (process.env.HOMUN_DESKTOP_GATEWAY_BIN) {
    return process.env.HOMUN_DESKTOP_GATEWAY_BIN;
  }

  const executable = process.platform === "win32"
    ? "local-first-desktop-gateway.exe"
    : "local-first-desktop-gateway";
  const packagedPath = path.join(RESOURCES_ROOT, "bin", executable);
  if ((app.isPackaged || process.env.HOMUN_DESKTOP_RESOURCES_DIR) && fs.existsSync(packagedPath)) {
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

// macOS/Linux GUI apps launched from Finder/Dock inherit launchd's minimal PATH
// (typically /usr/bin:/bin:/usr/sbin:/sbin) — WITHOUT Homebrew (/opt/homebrew/bin),
// /usr/local/bin (where Docker Desktop's `docker` symlink lives), ~/.cargo/bin, etc.
// The gateway shells out to `docker`, `colima`, `cargo`, `git`, `python` by bare
// name, so a truncated PATH makes them "not found" — the classic "works in dev,
// broken in the packaged .app" bug. Reconstruct a full PATH before spawning, the
// way the `fix-path` library does (login-shell query ∪ well-known bin dirs).
let cachedGatewayPath = null;
function resolveGatewayPath() {
  if (cachedGatewayPath !== null) return cachedGatewayPath;
  const sep = process.platform === "win32" ? ";" : ":";
  const seen = new Set();
  const parts = [];
  const add = (entry) => {
    if (typeof entry === "string" && entry && !seen.has(entry)) {
      seen.add(entry);
      parts.push(entry);
    }
  };

  // 1) Whatever PATH we already have (full in dev, truncated in a GUI launch).
  for (const entry of (process.env.PATH ?? "").split(sep)) add(entry);

  if (process.platform !== "win32") {
    // 2) The user's login shell PATH — captures custom locations (asdf, nvm,
    //    pyenv, non-standard Homebrew prefixes). Bounded by a timeout so a slow
    //    or misconfigured shell can't hang startup; stderr is discarded.
    try {
      const shellBin = process.env.SHELL || "/bin/zsh";
      const shellPath = execFileSync(shellBin, ["-ilc", 'printf %s "$PATH"'], {
        timeout: 3000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const entry of shellPath.split(sep)) add(entry);
    } catch {
      // Shell missing/misconfigured/slow — the well-known dirs below cover Docker.
    }
    // 3) Always union the common bin dirs, so `docker` resolves even when the
    //    shell query failed or returned a minimal PATH.
    const home = os.homedir();
    for (const entry of [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      path.join(home, ".docker", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".local", "bin"),
    ]) {
      add(entry);
    }
  }

  cachedGatewayPath = parts.join(sep);
  return cachedGatewayPath;
}

function spawnGateway() {
  const gatewayBin = gatewayBinaryPath();
  const workspaceRoot = process.env.HOMUN_WORKSPACE_ROOT ??
    ((app.isPackaged || process.env.HOMUN_DESKTOP_RESOURCES_DIR)
      ? RESOURCES_ROOT
      : REPO_ROOT);
  const env = {
    ...process.env,
    PATH: resolveGatewayPath(),
    HOMUN_DESKTOP_GATEWAY_PORT: GATEWAY_PORT,
    HOMUN_DESKTOP_GATEWAY_TOKEN: GATEWAY_TOKEN,
    HOMUN_WORKSPACE_ROOT: workspaceRoot,
  };

  // Point the gateway at the bundled contained-computer build context so the
  // "local computer" can start from an installed app (up.sh builds the image
  // from that dir). In dev this path doesn't exist (RESOURCES_ROOT = repo root)
  // and the gateway falls back to its repo-relative lookup. An explicit
  // HOMUN_CONTAINED_COMPUTER_UP in the environment wins (kept by ...process.env).
  if (!env.HOMUN_CONTAINED_COMPUTER_UP) {
    const ccUp = path.join(RESOURCES_ROOT, "contained-computer", "up.sh");
    if (fs.existsSync(ccUp)) env.HOMUN_CONTAINED_COMPUTER_UP = ccUp;
  }

  // Point the gateway at the bundled default skills (HomunCoder methodology) so
  // it can seed them into the data dir on first run. Same dev/packaged story as
  // above; an explicit env override wins.
  if (!env.HOMUN_DEFAULT_SKILLS_DIR) {
    const skillsDir = path.join(RESOURCES_ROOT, "default-skills");
    if (fs.existsSync(skillsDir)) env.HOMUN_DEFAULT_SKILLS_DIR = skillsDir;
  }

  // Point the gateway at the bundled channel-bridge sidecars (Telegram,
  // WhatsApp) so connecting a channel works from an installed app. Without this
  // the gateway only finds repo-relative bridge paths (absent from the bundle)
  // and channel connect fails with `telegram_bin_missing` / `whatsapp_bin_missing`.
  // Same dev/packaged story as above; an explicit env override wins.
  const bridgeExe = process.platform === "win32" ? ".exe" : "";
  if (!env.HOMUN_TELEGRAM_BIN) {
    const tgBin = path.join(RESOURCES_ROOT, "bin", `channel-telegram${bridgeExe}`);
    if (fs.existsSync(tgBin)) env.HOMUN_TELEGRAM_BIN = tgBin;
  }
  if (!env.HOMUN_WHATSAPP_BIN) {
    const waBin = path.join(RESOURCES_ROOT, "bin", `channel-whatsapp${bridgeExe}`);
    if (fs.existsSync(waBin)) env.HOMUN_WHATSAPP_BIN = waBin;
  }

  // Point the gateway at the bundled browser-automation sidecar (Node/Playwright)
  // that drives the contained-computer browser over CDP. Without this the gateway
  // only finds the repo-relative runtimes/ path (absent from the bundle) and the
  // browser is "unreachable" from an installed app — `npm run start` (tsx) is
  // resolved via the reconstructed PATH above. An explicit env override wins.
  if (!env.HOMUN_BROWSER_AUTOMATION_DIR) {
    const baDir = path.join(RESOURCES_ROOT, "browser-automation");
    if (fs.existsSync(baDir)) env.HOMUN_BROWSER_AUTOMATION_DIR = baDir;
  }

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
  if (process.env.HOMUN_DESKTOP_URL) {
    return { kind: "url", value: DEV_SERVER_URL };
  }

  const indexPath = path.join(__dirname, "..", "dist", "index.html");
  return { kind: "url", value: pathToFileURL(indexPath).toString() };
}

function createWindow() {
  const iconPath = brandIconPath();
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    ...(iconPath ? { icon: iconPath } : {}),
    title: "Homun",
    backgroundColor: "#ffffff",
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarOverlay: { height: 44, color: "#ffffff", symbolColor: "#5f6368" } }),
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

  // Allow microphone access for on-device dictation (denied by default in
  // Electron). Scoped to "media"; everything else stays denied.
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === "media");
    },
  );

  const entry = rendererEntry();
  void window.loadURL(entry.value);

  if (process.env.HOMUN_ELECTRON_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }
}

// Native folder picker for the "@ linked folder" feature. User-initiated only
// (invoked by clicking @ in the composer); returns the chosen absolute path.
ipcMain.handle("lfpa:pick-folder", async () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const options = {
    title: "Collega una cartella alla conversazione",
    properties: ["openDirectory", "createDirectory"],
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Reveal a folder/file in the OS file manager (artifacts "Apri cartella").
ipcMain.handle("lfpa:reveal-path", async (_event, targetPath) => {
  if (typeof targetPath !== "string" || !targetPath) return false;
  const error = await shell.openPath(targetPath);
  return error === "";
});

// Keep the app awake while a long task streams, so a sleeping Mac doesn't suspend the
// gateway + drop the in-flight generation mid-task. Ref-counted: the renderer calls
// keep-awake(true) when a generation starts and (false) when it ends (incl. errors).
let powerBlockId = null;
let powerBlockCount = 0;
ipcMain.handle("lfpa:keep-awake", (_event, on) => {
  if (on) {
    powerBlockCount += 1;
    if (powerBlockId === null || !powerSaveBlocker.isStarted(powerBlockId)) {
      powerBlockId = powerSaveBlocker.start("prevent-app-suspension");
    }
  } else {
    powerBlockCount = Math.max(0, powerBlockCount - 1);
    if (powerBlockCount === 0 && powerBlockId !== null && powerSaveBlocker.isStarted(powerBlockId)) {
      powerSaveBlocker.stop(powerBlockId);
      powerBlockId = null;
    }
  }
  return powerBlockCount;
});

// Capture the WHOLE page (the full scrollable conversation, not just the visible
// viewport) to a PNG and reveal it — so the user can SHOW the actual UI/pagination.
// The chat scrolls inside an inner container, so we temporarily expand the scrollers
// (height:auto / overflow:visible) and use CDP captureBeyondViewport to grab the full
// document height, then restore the styles. Falls back to a viewport capture.
ipcMain.handle("lfpa:capture-page", async () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!win) return { ok: false, error: "no window" };
  const wc = win.webContents;
  const dir = path.join(os.homedir(), ".homun", "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `homun-${stamp}.png`);

  const expand = `(() => {
    const start = document.querySelector('.thread-scroll') || document.scrollingElement || document.body;
    const saved = [];
    let el = start;
    while (el) {
      saved.push([el, el.getAttribute('style')]);
      el.style.height = 'auto'; el.style.maxHeight = 'none'; el.style.minHeight = '0';
      el.style.overflow = 'visible'; el.style.flex = 'none';
      if (el === document.documentElement) break;
      el = el.parentElement;
    }
    window.__capSaved = saved;
    const de = document.documentElement;
    return { w: Math.ceil(de.scrollWidth), h: Math.ceil(de.scrollHeight) };
  })()`;
  const restore = `(() => {
    (window.__capSaved || []).forEach(([el, s]) => {
      if (s === null || s === undefined) el.removeAttribute('style'); else el.setAttribute('style', s);
    });
    window.__capSaved = null;
  })()`;

  try {
    const size = await wc.executeJavaScript(expand, true);
    let detach = false;
    try {
      wc.debugger.attach("1.3");
      detach = true;
    } catch {
      /* already attached (e.g. devtools) — sendCommand still works */
    }
    // Cap the height to CDP's safe limit so a very long chat doesn't fail outright.
    const height = Math.min(size?.h ?? 0, 30000) || 1000;
    const width = size?.w ?? 1280;
    const shot = await wc.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    if (detach) {
      try {
        wc.debugger.detach();
      } catch {
        /* ignore */
      }
    }
    await wc.executeJavaScript(restore, true);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    shell.showItemInFolder(file);
    return { ok: true, path: file };
  } catch (error) {
    // Restore + fall back to a plain viewport capture so the user still gets something.
    try {
      await wc.executeJavaScript(restore, true);
    } catch {
      /* ignore */
    }
    try {
      const image = await wc.capturePage();
      fs.writeFileSync(file, image.toPNG());
      shell.showItemInFolder(file);
      return { ok: true, path: file, partial: true };
    } catch (fallbackError) {
      return { ok: false, error: String(fallbackError?.message ?? fallbackError) };
    }
  }
});

// Bring the window to the front when the user clicks a system notification.
ipcMain.handle("lfpa:focus-window", () => {
  const win = BrowserWindow.getAllWindows()[0] ?? null;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  if (process.platform === "darwin" && app.dock) app.focus({ steal: true });
  return true;
});

// Auto-update via electron-updater. The feed is the public `homun-releases` repo
// (build.publish), so no token is embedded. Manual flow: the Notifications view
// checks, then downloads + restarts on the user's click. No-op in dev.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

// The version of THIS running build (set from the git tag at CI time). The
// renderer shows it in Settings → Account so "which build am I on?" is never a
// guess. Works in dev too (returns the dev package.json version).
ipcMain.handle("lfpa:app-version", () => app.getVersion());

// electron-updater can return releaseNotes as a string or an array of
// {version, note}; normalise to a single string the renderer can render.
function flattenReleaseNotes(notes) {
  if (!notes) return null;
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (typeof n === "string" ? n : n?.note ?? ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return null;
}

ipcMain.handle("lfpa:update-check", async () => {
  const current = app.getVersion();
  if (!app.isPackaged) return { available: false, version: null, current };
  try {
    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo?.version ?? null;
    const available = version ? autoUpdater.currentVersion.compare(version) < 0 : false;
    const releaseNotes = flattenReleaseNotes(result?.updateInfo?.releaseNotes);
    return { available, version, current, releaseNotes };
  } catch (error) {
    return { available: false, version: null, current, error: String(error?.message ?? error) };
  }
});

ipcMain.handle("lfpa:update-install", async (event) => {
  if (!app.isPackaged) return { ok: false, error: "dev build" };
  // Stream download progress to the renderer so the UI isn't a frozen button.
  const onProgress = (p) => {
    try {
      event.sender.send("lfpa:update-progress", {
        percent: Math.round(p?.percent ?? 0),
        transferred: p?.transferred ?? 0,
        total: p?.total ?? 0,
      });
    } catch {
      // sender gone (window closed mid-download) — nothing to do.
    }
  };
  autoUpdater.on("download-progress", onProgress);
  try {
    await autoUpdater.downloadUpdate();
    onProgress({ percent: 100 });
    // Download done → swap + relaunch. quitAndInstall quits this process, so the
    // renderer's `installing` state never has to be cleared by us.
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    autoUpdater.removeListener("download-progress", onProgress);
  }
});

app.whenReady().then(async () => {
  applyAppMenu();
  if (process.platform === "darwin" && app.dock) {
    const iconPath = brandIconPath();
    if (iconPath) {
      const dockIcon = nativeImage.createFromPath(iconPath);
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    }
  }
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
