/**
 * Gateway Channels client for Homun Engine.
 * Provides endpoints for configuring and testing external messaging channels (Telegram, Discord, Slack, etc.).
 */

import { ENGINE_DEFAULT_BASE_URL } from "./engine-client";

function getBaseUrl(): string {
  if (typeof window !== "undefined") {
    if (window.homunDesktop?.engineBaseUrl) {
      return window.homunDesktop.engineBaseUrl;
    }
    const custom = (window as unknown as { __HOMUN_ENGINE_URL__?: string }).__HOMUN_ENGINE_URL__;
    if (custom) return custom;
  }
  return ENGINE_DEFAULT_BASE_URL;
}

export type ChannelPlatformInfo = {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  state: "connected" | "needs_setup" | "disabled" | "error";
  fields: Record<string, string>;
  has_secrets: boolean;
};

export type ChannelPlatformUpdatePayload = {
  enabled?: boolean;
  fields?: Record<string, string>;
};

export type ChannelPlatformTestResponse = {
  ok: boolean;
  message: string;
};

export async function listEngineChannelPlatforms(): Promise<ChannelPlatformInfo[]> {
  try {
    const res = await fetch(`${getBaseUrl()}/v1/gateway/channels/platforms`);
    if (!res.ok) {
      throw new Error(`Failed to list platforms: ${res.status}`);
    }
    const data = await res.json();
    return data.platforms || [];
  } catch (err) {
    console.warn("listEngineChannelPlatforms error, falling back to local defaults:", err);
    return [];
  }
}

export async function updateEngineChannelPlatform(
  platformId: string,
  payload: ChannelPlatformUpdatePayload,
): Promise<{ ok: boolean; platform: string; enabled: boolean }> {
  const res = await fetch(`${getBaseUrl()}/v1/gateway/channels/platforms/${encodeURIComponent(platformId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.detail?.message || err?.detail || `Errore salvataggio canale (HTTP ${res.status})`);
  }
  return res.json();
}

export async function testEngineChannelPlatform(
  platformId: string,
  fields?: Record<string, string>,
): Promise<ChannelPlatformTestResponse> {
  const res = await fetch(`${getBaseUrl()}/v1/gateway/channels/platforms/${encodeURIComponent(platformId)}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: fields || {} }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return {
      ok: false,
      message: err?.detail?.message || err?.detail || `Verifica fallita (HTTP ${res.status})`,
    };
  }
  return res.json();
}

export type TelegramOnboardingStartResponse = {
  pairing_id: string;
  deep_link: string;
  qr_payload: string;
  expires_at: string;
  suggested_username?: string;
};

export type TelegramOnboardingStatusResponse = {
  status: "waiting" | "ready" | "expired";
  bot_username?: string;
  owner_user_id?: string;
  expires_at?: string;
};

export async function startTelegramOnboarding(botName = "Homun Agent"): Promise<TelegramOnboardingStartResponse> {
  const res = await fetch(`${getBaseUrl()}/v1/gateway/channels/telegram/onboarding/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bot_name: botName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.detail?.message || err?.detail || `Impossibile avviare la creazione bot (HTTP ${res.status})`);
  }
  return res.json();
}

export async function getTelegramOnboardingStatus(pairingId: string): Promise<TelegramOnboardingStatusResponse> {
  const res = await fetch(`${getBaseUrl()}/v1/gateway/channels/telegram/onboarding/${encodeURIComponent(pairingId)}`);
  if (!res.ok) {
    if (res.status === 410) {
      return { status: "expired" };
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.detail?.message || err?.detail || `Errore verifica stato bot (HTTP ${res.status})`);
  }
  return res.json();
}

export async function applyTelegramOnboarding(
  pairingId: string,
  allowedUserIds?: string[],
): Promise<{ ok: boolean; platform: string; bot_username?: string; enabled: boolean; fields?: Record<string, string> }> {
  const res = await fetch(`${getBaseUrl()}/v1/gateway/channels/telegram/onboarding/${encodeURIComponent(pairingId)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowed_user_ids: allowedUserIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.detail?.message || err?.detail || `Errore applicazione bot Telegram (HTTP ${res.status})`);
  }
  return res.json();
}

export async function cancelTelegramOnboarding(pairingId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${getBaseUrl()}/v1/gateway/channels/telegram/onboarding/${encodeURIComponent(pairingId)}`, {
    method: "DELETE",
  });
  return res.json().catch(() => ({ ok: true }));
}
