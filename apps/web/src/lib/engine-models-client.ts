/**
 * Homun model provider client (F3.1).
 * Explicit engine path — never invents completions when the provider is down.
 */

import { ENGINE_DEFAULT_BASE_URL, EngineUnavailableError } from "./engine-client.ts";
import { homunErrorFromHttp } from "./homun-errors.ts";

export type ModelProviderInfo = {
  id: string;
  kind: string;
  display_name: string;
  configured: boolean;
  credential_present: boolean;
  base_url?: string | null;
  default_model?: string | null;
  notes: string[];
};

export type ModelProvidersResponse = {
  active_provider_id: string;
  items: ModelProviderInfo[];
};

export type ModelVerifyResult = {
  ok: boolean;
  provider_id: string;
  message: string;
  checked_at: string;
};

export type ModelCompletionResult = {
  text: string;
  model_id: string;
  provider_id: string;
  finish_reason: string;
};

async function modelsFetch(path: string, init: RequestInit, baseUrl: string): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${path}`, init);
  } catch (cause) {
    throw new EngineUnavailableError(
      `Engine unreachable at ${baseUrl}. Start it with: npm run engine:dev`,
      cause,
    );
  }
}

async function readError(response: Response, fallback: string): Promise<never> {
  const body = await response.json().catch(() => null);
  throw homunErrorFromHttp(response.status, body, fallback);
}

export async function listModelProviders(
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<ModelProvidersResponse> {
  const response = await modelsFetch(
    "/v1/models/providers",
    { method: "GET", headers: { Accept: "application/json" } },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `List model providers failed with HTTP ${response.status}`);
  }
  return (await response.json()) as ModelProvidersResponse;
}

export type ModelVerifyOptions = {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  modelId?: string | undefined;
  engineBaseUrl?: string | undefined;
};

export async function verifyModelProvider(
  providerId: string,
  optionsOrBaseUrl?: ModelVerifyOptions | string,
): Promise<ModelVerifyResult> {
  const opts: ModelVerifyOptions =
    typeof optionsOrBaseUrl === "string"
      ? { engineBaseUrl: optionsOrBaseUrl }
      : (optionsOrBaseUrl ?? {});
  const baseUrl = opts.engineBaseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const hasBody = Boolean(opts.apiKey || opts.baseUrl || opts.modelId);
  const response = await modelsFetch(
    `/v1/models/providers/${encodeURIComponent(providerId)}/verify`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      ...(hasBody
        ? {
            body: JSON.stringify({
              api_key: opts.apiKey,
              base_url: opts.baseUrl,
              model_id: opts.modelId,
            }),
          }
        : {}),
    },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Verify provider failed with HTTP ${response.status}`);
  }
  return (await response.json()) as ModelVerifyResult;
}

export type UpsertConnectionInput = {
  connection_id: string;
  kind?: "fake" | "openai_compatible" | "pydantic_ai" | undefined;
  display_name: string;
  model_id: string;
  base_url?: string | undefined;
  api_key?: string | undefined;
  context_window?: number | undefined;
  max_output_tokens?: number | undefined;
  engineBaseUrl?: string | undefined;
};

export async function upsertModelConnection(
  input: UpsertConnectionInput,
): Promise<ModelConnectionInfo> {
  const baseUrl = input.engineBaseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const response = await modelsFetch(
    "/v1/models/connections",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        connection_id: input.connection_id,
        kind: input.kind ?? "openai_compatible",
        display_name: input.display_name,
        model_id: input.model_id,
        base_url: input.base_url,
        api_key: input.api_key,
        context_window: input.context_window,
        max_output_tokens: input.max_output_tokens ?? 8192,
      }),
    },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Upsert connection failed with HTTP ${response.status}`);
  }
  return (await response.json()) as ModelConnectionInfo;
}

export type PooledCredentialInfo = {
  key_id: string;
  provider: string;
  masked_secret: string;
  status: string;
  is_available: boolean;
  usage_count?: number;
  error_count?: number;
  last_used_at?: number;
  last_error?: string | null;
};

export async function addPooledCredential(input: {
  provider: string;
  secret_value: string;
  key_id?: string | undefined;
  engineBaseUrl?: string | undefined;
}): Promise<{ key_id: string; provider: string; status: string; masked_secret: string }> {
  const baseUrl = input.engineBaseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const response = await modelsFetch(
    "/v1/credentials/pool",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: input.provider,
        secret_value: input.secret_value,
        key_id: input.key_id,
      }),
    },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Add pooled credential failed with HTTP ${response.status}`);
  }
  return (await response.json()) as { key_id: string; provider: string; status: string; masked_secret: string };
}

export async function listPooledCredentials(
  provider?: string,
  engineBaseUrl?: string,
): Promise<PooledCredentialInfo[]> {
  const baseUrl = engineBaseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const url = provider ? `/v1/credentials/pool?provider=${encodeURIComponent(provider)}` : "/v1/credentials/pool";
  const response = await modelsFetch(
    url,
    { method: "GET", headers: { Accept: "application/json" } },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `List pooled credentials failed with HTTP ${response.status}`);
  }
  return (await response.json()) as PooledCredentialInfo[];
}

export async function completeWithModel(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options?: { providerId?: string; modelId?: string; baseUrl?: string },
): Promise<ModelCompletionResult> {
  const baseUrl = options?.baseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const response = await modelsFetch(
    "/v1/models/complete",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        provider_id: options?.providerId,
        model_id: options?.modelId,
      }),
    },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Model complete failed with HTTP ${response.status}`);
  }
  return (await response.json()) as ModelCompletionResult;
}

export type ModelConnectionInfo = {
  id: string;
  kind: string;
  display_name: string;
  model_id: string;
  base_url?: string | null;
  configured: boolean;
  credential_present: boolean;
  active: boolean;
  notes: string[];
};

export type ModelConnectionsResponse = {
  active_connection_id: string;
  items: ModelConnectionInfo[];
};

export async function listModelConnections(
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<ModelConnectionsResponse> {
  const response = await modelsFetch(
    "/v1/models/connections",
    { method: "GET", headers: { Accept: "application/json" } },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `List model connections failed with HTTP ${response.status}`);
  }
  return (await response.json()) as ModelConnectionsResponse;
}

/** ModelPort chat entrypoint (`POST /v1/models/chat`). */
export async function postModelChat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options?: { connectionId?: string; modelId?: string; baseUrl?: string },
): Promise<ModelCompletionResult> {
  const baseUrl = options?.baseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const response = await modelsFetch(
    "/v1/models/chat",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        connection_id: options?.connectionId,
        model_id: options?.modelId,
      }),
    },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Model chat failed with HTTP ${response.status}`);
  }
  return (await response.json()) as ModelCompletionResult;
}

export async function setOpenAICompatibleCredentials(input: {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  engineBaseUrl?: string;
}): Promise<void> {
  const baseUrl = input.engineBaseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const response = await modelsFetch(
    "/v1/models/providers/openai_compatible/credentials",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: input.apiKey,
        base_url: input.baseUrl,
        default_model: input.defaultModel,
      }),
    },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Set credentials failed with HTTP ${response.status}`);
  }
}

export async function setActiveModelProvider(
  providerId: string,
  engineBaseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<string> {
  const response = await modelsFetch(
    "/v1/models/providers/active",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: providerId }),
    },
    engineBaseUrl,
  );
  if (!response.ok) {
    await readError(response, `Set active provider failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { active_provider_id: string };
  return body.active_provider_id;
}

export async function applyOllamaPreset(input?: {
  model?: string;
  engineBaseUrl?: string;
}): Promise<{ active_provider_id: string; base_url: string; default_model: string }> {
  const baseUrl = input?.engineBaseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const response = await modelsFetch(
    "/v1/models/providers/openai_compatible/ollama_preset",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ model: input?.model ?? "qwen3.5:4b" }),
    },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Ollama preset failed with HTTP ${response.status}`);
  }
  return (await response.json()) as {
    active_provider_id: string;
    base_url: string;
    default_model: string;
  };
}

export async function listOllamaTags(
  engineBaseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<string[]> {
  const response = await modelsFetch(
    "/v1/models/ollama/tags",
    { method: "GET", headers: { Accept: "application/json" } },
    engineBaseUrl,
  );
  if (!response.ok) {
    await readError(response, `List Ollama tags failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { items: string[] };
  return body.items ?? [];
}

export type UsageAttemptRow = {
  id: string;
  command_id: string | null;
  conversation_id: string | null;
  purpose: string;
  attempt_index: number;
  provider_id: string;
  model_id: string | null;
  status: string;
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
};

export async function listUsageAttempts(
  limit: number = 20,
  engineBaseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<UsageAttemptRow[]> {
  const response = await modelsFetch(
    `/v1/models/usage-attempts?limit=${Math.max(1, Math.min(limit, 200))}`,
    { method: "GET", headers: { Accept: "application/json" } },
    engineBaseUrl,
  );
  if (!response.ok) {
    await readError(response, `List usage attempts failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { items: UsageAttemptRow[] };
  return body.items ?? [];
}

export type ModelSuggestion = {
  model: string;
  source: "ollama" | "cloud";
  params: string | null;
  size_gb: number | null;
  fit: "best" | "good" | "fair";
  why: string;
  active: boolean;
};

export type ModelRecommendationTask = {
  id: string;
  label: string;
  hint: string;
  suggestions: ModelSuggestion[];
};

/** Heuristic per-task suggestions from the engine over the real local catalog. */
export async function listModelRecommendations(
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<ModelRecommendationTask[]> {
  const response = await modelsFetch(
    "/v1/models/recommendations",
    { headers: { Accept: "application/json" } },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Model recommendations failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { tasks: ModelRecommendationTask[] };
  return body.tasks ?? [];
}
