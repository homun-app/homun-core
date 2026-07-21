// Single source of truth for the model-provider catalog.
//
// Both Settings → Model & Runtime and the first-run onboarding render from this
// list, so the providers we offer stay aligned everywhere. Selecting a preset
// fills the base URL + kind; the user adds the key and picks a model. "Custom"
// leaves the URL blank. Brand marks come from providerLogos.tsx (keyed by `id`).
export type ProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  kind: string;
  hint?: string;
};

export const RUNTIME_MODELS_CHANGED_EVENT = "homun:runtime-models-changed";

export function notifyRuntimeModelsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(RUNTIME_MODELS_CHANGED_EVENT));
  }
}

export function isLocalOllamaProvider(kind: string, baseUrl: string): boolean {
  if (kind !== "ollama") return false;
  try {
    const url = new URL(baseUrl);
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", kind: "openai_compat" },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", kind: "anthropic" },
  { id: "zai", label: "Z.ai (GLM)", baseUrl: "https://api.z.ai/api/paas/v4", kind: "openai_compat", hint: "GLM-5 standard" },
  { id: "zai-coding", label: "Z.ai Coding (GLM)", baseUrl: "https://api.z.ai/api/coding/paas/v4", kind: "openai_compat", hint: "GLM-5 coding" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", kind: "openai_compat" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", kind: "openai_compat" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", kind: "openai_compat" },
  { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", kind: "openai_compat" },
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", kind: "openai_compat" },
  { id: "moonshot", label: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.ai/v1", kind: "openai_compat" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", kind: "openai_compat" },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", kind: "ollama" },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    kind: "openai_compat",
    hint: ":cloud models — key from ollama.com/settings/keys",
  },
  { id: "custom", label: "Custom", baseUrl: "", kind: "openai_compat" },
];
