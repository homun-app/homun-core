import { DESKTOP_GATEWAY_URL, gatewayHeaders } from "./gatewayConfig";

// Shared JSON fetch helpers for the desktop gateway. Extracted from coreBridge so
// feature modules (providers, connectors, memory, …) can be split out without a
// circular import back to coreBridge. gatewayConfig is a leaf (URL + auth header).

// Desktop Gateway errors serialize as { error: { code, message } }.
export async function gatewayErrorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: { message?: string } | string;
    };
    if (typeof payload?.error === "string") return payload.error;
    if (payload?.error?.message) return payload.error.message;
  } catch {
    // fall through to status-code detail
  }
  return `HTTP ${response.status}`;
}

export async function gatewayPostJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}${path}`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await gatewayErrorDetail(response));
  }
  return response.json() as Promise<T>;
}

export async function gatewayPutJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}${path}`, {
    method: "PUT",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await gatewayErrorDetail(response));
  }
  return response.json() as Promise<T>;
}

export async function gatewayPatchJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}${path}`, {
    method: "PATCH",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await gatewayErrorDetail(response));
  }
  return response.json() as Promise<T>;
}

export async function gatewayGetJson<T>(path: string): Promise<T> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}${path}`, {
    headers: gatewayHeaders(),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function gatewayDeleteJson<T>(path: string): Promise<T> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}${path}`, {
    method: "DELETE",
    headers: gatewayHeaders(),
  });
  if (!response.ok) {
    throw new Error(await gatewayErrorDetail(response));
  }
  return response.json() as Promise<T>;
}
