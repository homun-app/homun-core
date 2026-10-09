/**
 * First-run gate: a usable product model (not the CI/demo "fake" provider).
 */

export type ModelProviderReadyCheck = {
  id: string;
  kind: string;
  configured: boolean;
  credential_present: boolean;
  base_url?: string | null;
};

/** True when the active (or any configured) provider can serve a real first request. */
export function hasUsableModelProvider(
  items: ModelProviderReadyCheck[],
  activeProviderId: string,
): boolean {
  const ordered = [
    items.find((p) => p.id === activeProviderId),
    ...items.filter((p) => p.id !== activeProviderId),
  ].filter((p): p is ModelProviderReadyCheck => Boolean(p));

  for (const provider of ordered) {
    if (!provider.configured || provider.id === "fake") continue;
    const local =
      /ollama|local/i.test(provider.kind) || Boolean(provider.base_url?.includes("11434"));
    if (provider.credential_present || local) return true;
  }
  return false;
}
