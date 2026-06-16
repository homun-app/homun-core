import { coreBridge } from "./coreBridge";

// Shared Composio connect flow (same as Settings → Connectors): kick off the OAuth
// link (or API-key flow), open the redirect, then POLL connected accounts until the
// toolkit reports ACTIVE — so the in-chat connect/reconnect cards "detect automatically"
// instead of dead-ending on "autorizza e riprova".
export type ComposioConnectStatus = "connecting" | "connected" | "failed";

export async function connectComposioToolkit(
  slug: string,
  opts: { apiKey?: string; onStatus?: (s: ComposioConnectStatus) => void } = {},
): Promise<boolean> {
  const { apiKey, onStatus } = opts;
  let redirect = "";
  try {
    const result = await coreBridge.composioLink(slug, apiKey ? { apiKey } : undefined);
    redirect = result.redirect_url || "";
  } catch {
    onStatus?.("failed");
    return false;
  }
  if (redirect) {
    window.open(redirect, "_blank", "noopener,noreferrer");
  }
  onStatus?.("connecting");
  // OAuth (browser) is slow; an API-key connection is active almost immediately.
  const deadline = Date.now() + (redirect ? 150_000 : 20_000);
  const step = redirect ? 3000 : 1500;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, step));
    try {
      const conns = await coreBridge.composioConnections();
      if (conns.some((c) => c.toolkit_slug === slug && c.status === "ACTIVE")) {
        onStatus?.("connected");
        return true;
      }
    } catch {
      /* transient — keep polling */
    }
  }
  onStatus?.("failed");
  return false;
}
