import { isIP } from "node:net";
import { BrowserAutomationError } from "../contracts.js";

const NETWORK_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);

export type NavigationPolicy = {
  url: string;
  allowPrivateNetwork?: boolean;
};

export async function assertNavigationAllowed(policy: NavigationPolicy): Promise<void> {
  const raw = policy.url.trim();
  if (!raw) {
    throw new BrowserAutomationError({
      code: "BROWSER_NAVIGATION_BLOCKED",
      message: "url is required",
      retryable: false,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BrowserAutomationError({
      code: "BROWSER_NAVIGATION_BLOCKED",
      message: `invalid URL: ${raw}`,
      retryable: false,
    });
  }

  if (!NETWORK_PROTOCOLS.has(parsed.protocol)) {
    if (SAFE_NON_NETWORK_URLS.has(parsed.href)) {
      return;
    }
    throw new BrowserAutomationError({
      code: "BROWSER_NAVIGATION_BLOCKED",
      message: `unsupported protocol: ${parsed.protocol}`,
      retryable: false,
    });
  }

  if (!policy.allowPrivateNetwork && isPrivateHostname(parsed.hostname)) {
    throw new BrowserAutomationError({
      code: "BROWSER_PRIVATE_NETWORK_BLOCKED",
      message: `private network navigation blocked: ${parsed.hostname}`,
      retryable: false,
    });
  }
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost") {
    return true;
  }
  const ipKind = isIP(normalized);
  if (ipKind === 0) {
    return false;
  }
  if (ipKind === 6) {
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  const [aRaw, bRaw] = normalized.split(".");
  const a = Number(aRaw);
  const b = Number(bRaw);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}
