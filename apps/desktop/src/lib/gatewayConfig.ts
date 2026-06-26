interface LocalFirstDesktopConfig {
  gatewayUrl?: string;
  gatewayToken?: string;
  pickFolder?: () => Promise<string | null>;
  revealPath?: (path: string) => Promise<boolean>;
  /** Captures the whole app window to a PNG and reveals it. */
  capturePage?: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  /** Keep the app awake during a long task (ref-counted; on=true start, false end). */
  keepAwake?: (on: boolean) => Promise<number>;
  /** Resolves a File to its absolute on-disk path (Electron webUtils). Sync. */
  getPathForFile?: (file: File) => string;
  /** Version of this running build (git tag at CI time; dev package.json in dev). */
  appVersion?: () => Promise<string>;
  /** Desktop auto-update (electron-updater). */
  checkForUpdate?: () => Promise<{
    available: boolean;
    version: string | null;
    current?: string | null;
    releaseNotes?: string | null;
    /** macOS (signed) can auto-install; Windows/Linux are unsigned → download-only. */
    canAutoInstall?: boolean;
    error?: string;
  }>;
  installUpdate?: () => Promise<{ ok: boolean; error?: string }>;
  /** Open the releases page for a manual download (unsigned platforms). */
  openUpdateDownload?: () => Promise<{ ok: boolean; error?: string }>;
  /** Subscribe to download progress; returns an unsubscribe fn. */
  onUpdateProgress?: (
    cb: (p: { percent: number; transferred: number; total: number }) => void,
  ) => () => void;
  /** Bring the desktop window to the front (e.g. on a notification click). */
  focusWindow?: () => Promise<void>;
}

declare global {
  interface Window {
    localFirstDesktop?: LocalFirstDesktopConfig;
  }
}

const viteEnv = (import.meta as unknown as {
  env?: Record<string, string | undefined>;
}).env;

const desktopConfig =
  typeof window === "undefined" ? undefined : window.localFirstDesktop;

function normalizeGatewayUrl(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export const DESKTOP_GATEWAY_URL = normalizeGatewayUrl(
  viteEnv?.VITE_HOMUN_DESKTOP_GATEWAY_URL ??
    desktopConfig?.gatewayUrl ??
    "http://127.0.0.1:18765",
);

/** Running inside the Electron shell (vs a browser / self-hosted web build). */
export const IS_DESKTOP = !!desktopConfig;

const TOKEN_STORAGE_KEY = "lfpa.gatewayToken";
const buildTimeToken = viteEnv?.VITE_HOMUN_DESKTOP_GATEWAY_TOKEN;

/** The bearer token for API calls, resolved at call time. Desktop: injected by
 *  the Electron shell. Web: a build-time token (legacy) or the token the user
 *  entered at the web login (persisted in localStorage) — so it is NOT baked
 *  into the bundle for self-hosted deploys. */
export function currentGatewayToken(): string | undefined {
  if (desktopConfig?.gatewayToken) return desktopConfig.gatewayToken;
  if (buildTimeToken) return buildTimeToken;
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setGatewayToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
  } catch {
    // localStorage unavailable (SSR/sandboxed) — nothing to persist.
  }
}

export function clearGatewayToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function gatewayHeaders(extra: HeadersInit = {}): HeadersInit {
  const token = currentGatewayToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/** Validates a token against a protected endpoint: 200 = valid, 401 = wrong. */
export async function verifyGatewayToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${DESKTOP_GATEWAY_URL}/api/chat/threads`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Opens the native directory picker (Electron). Returns the chosen absolute
 *  path, or null if unavailable (e.g. browser dev) or cancelled. */
export async function pickWorkspaceFolder(): Promise<string | null> {
  const pick = desktopConfig?.pickFolder;
  if (!pick) return null;
  try {
    return await pick();
  } catch {
    return null;
  }
}

/** Reveals a folder/file in the OS file manager (no-op outside Electron). */
export async function revealWorkspacePath(path: string): Promise<boolean> {
  const reveal = desktopConfig?.revealPath;
  if (!reveal) return false;
  try {
    return await reveal(path);
  } catch {
    return false;
  }
}

/** Resolves a File (picked or dropped) to its absolute on-disk path via Electron's
 *  webUtils. Returns "" outside Electron or for files with no on-disk backing
 *  (e.g. pasted/synthetic Files). Synchronous — must be called with the original
 *  File object (don't clone/spread it, or the native backing is lost). */
export function fileLocalPathFromBridge(file: File): string {
  const resolve = desktopConfig?.getPathForFile;
  if (!resolve) return "";
  try {
    return resolve(file) ?? "";
  } catch {
    return "";
  }
}

/** Version string of the running build (e.g. "0.1.1019"). Returns null outside
 *  Electron (web build) where there is no packaged version to report. */
export async function getAppVersion(): Promise<string | null> {
  const get = desktopConfig?.appVersion;
  if (!get) return null;
  try {
    return (await get()) || null;
  } catch {
    return null;
  }
}

/** Keep the app awake while a long task streams (no-op on web). Ref-counted in the
 *  Electron shell, so overlapping streams are handled; ALWAYS pair on=true with a
 *  later on=false (use try/finally) to avoid pinning the app awake. */
export function keepDesktopAwake(on: boolean): void {
  try {
    void desktopConfig?.keepAwake?.(on);
  } catch {
    // best effort
  }
}

/** Captures the whole app window to a PNG and reveals it (desktop only). Returns the
 *  file path, or null outside Electron / on failure. */
export async function captureAppScreenshot(): Promise<string | null> {
  const capture = desktopConfig?.capturePage;
  if (!capture) return null;
  try {
    const result = await capture();
    return result.ok ? result.path ?? null : null;
  } catch {
    return null;
  }
}

/** Desktop only: asks the Electron shell (electron-updater) whether a newer
 *  release is published. Returns null outside Electron or on any error, so the
 *  caller can simply hide the update card. */
export async function checkDesktopUpdate(): Promise<{
  available: boolean;
  version: string | null;
  current: string | null;
  releaseNotes: string | null;
  canAutoInstall: boolean;
} | null> {
  const check = desktopConfig?.checkForUpdate;
  if (!check) return null;
  try {
    const result = await check();
    return {
      available: !!result.available,
      version: result.version ?? null,
      current: result.current ?? null,
      releaseNotes: result.releaseNotes ?? null,
      // Default true (mac) when the field is absent (older shells), so the signed
      // mac flow is never accidentally downgraded.
      canAutoInstall: result.canAutoInstall ?? true,
    };
  } catch {
    return null;
  }
}

/** Desktop only: downloads the pending update and restarts into it. */
export async function installDesktopUpdate(): Promise<{ ok: boolean; error?: string }> {
  const install = desktopConfig?.installUpdate;
  if (!install) return { ok: false, error: "unavailable" };
  try {
    return await install();
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) };
  }
}

/** Desktop only: open the releases page for a manual download (unsigned
 *  platforms — Windows/Linux — that must not auto-install). */
export async function openDesktopUpdateDownload(): Promise<{ ok: boolean; error?: string }> {
  const open = desktopConfig?.openUpdateDownload;
  if (!open) return { ok: false, error: "unavailable" };
  try {
    return await open();
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) };
  }
}

/** Brings the desktop window to the front (notification click). No-op on web. */
export async function focusDesktopWindow(): Promise<void> {
  try {
    await desktopConfig?.focusWindow?.();
  } catch {
    // best effort
  }
}

/** Desktop only: subscribe to update download progress. Returns an unsubscribe
 *  fn (a no-op outside Electron). */
export function onDesktopUpdateProgress(
  cb: (p: { percent: number; transferred: number; total: number }) => void,
): () => void {
  const sub = desktopConfig?.onUpdateProgress;
  if (!sub) return () => {};
  try {
    return sub(cb);
  } catch {
    return () => {};
  }
}
