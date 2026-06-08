interface LocalFirstDesktopConfig {
  gatewayUrl?: string;
  gatewayToken?: string;
  pickFolder?: () => Promise<string | null>;
  revealPath?: (path: string) => Promise<boolean>;
  /** Resolves a File to its absolute on-disk path (Electron webUtils). Sync. */
  getPathForFile?: (file: File) => string;
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
  viteEnv?.VITE_LOCAL_FIRST_DESKTOP_GATEWAY_URL ??
    desktopConfig?.gatewayUrl ??
    "http://127.0.0.1:18765",
);

const gatewayToken =
  viteEnv?.VITE_LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN ??
  desktopConfig?.gatewayToken;

export function gatewayHeaders(extra: HeadersInit = {}): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
    ...extra,
  };
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
