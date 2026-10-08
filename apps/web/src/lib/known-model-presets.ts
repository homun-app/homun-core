/**
 * Reusable known model presets for Homun (OpenAI, Anthropic, Gemini, Ollama, DeepSeek, OpenRouter).
 * Shared across the Unified Models settings panel and the Agent Model Selector.
 */

export type KnownModelPreset = {
  id: string;
  name: string;
  kind: "cloud" | "local";
  defaultModel: string;
  availableModels: string[];
  defaultBaseUrl: string;
  description: string;
};

export const KNOWN_MODEL_PRESETS: readonly KnownModelPreset[] = [
  {
    id: "openai_compatible",
    name: "OpenAI",
    kind: "cloud",
    defaultModel: "gpt-4o",
    availableModels: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1", "gpt-4-turbo"],
    defaultBaseUrl: "https://api.openai.com/v1",
    description: "Modelli di punta GPT-4o, o3-mini e compatibili OpenAI API.",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    kind: "cloud",
    defaultModel: "claude-3-7-sonnet-20250219",
    availableModels: [
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
    defaultBaseUrl: "https://api.anthropic.com/v1",
    description: "Modelli Claude 3.7 Sonnet, Claude 3.5 Haiku ad alto ragionamento.",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    kind: "cloud",
    defaultModel: "gemini-2.0-flash",
    availableModels: [
      "gemini-2.0-flash",
      "gemini-2.0-pro-exp-02-05",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ],
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    description: "Modelli multimodali ad alta velocità e grande finestra di contesto.",
  },
  {
    id: "ollama",
    name: "Ollama (Locale)",
    kind: "local",
    defaultModel: "qwen2.5:7b",
    availableModels: ["qwen2.5:7b", "deepseek-r1:8b", "llama3.2:3b", "mistral:7b", "phi4:14b"],
    defaultBaseUrl: "http://localhost:11434",
    description: "Esecuzione 100% locale sul tuo hardware senza costi o invio dati.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "cloud",
    defaultModel: "deepseek-chat",
    availableModels: ["deepseek-chat", "deepseek-reasoner"],
    defaultBaseUrl: "https://api.deepseek.com/v1",
    description: "DeepSeek-V3 e R1 per ragionamento logico e codice ad alta efficienza.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "cloud",
    defaultModel: "anthropic/claude-3.5-sonnet",
    availableModels: [
      "anthropic/claude-3.5-sonnet",
      "meta-llama/llama-3.3-70b-instruct",
      "deepseek/deepseek-r1",
      "google/gemini-2.0-flash-001",
    ],
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    description: "Router unificato per accedere a centinaia di modelli da un'unica chiave.",
  },
];

export function findModelPreset(providerId: string): KnownModelPreset | undefined {
  const baseId = providerId.includes(":") ? providerId.split(":")[0] : providerId;
  return KNOWN_MODEL_PRESETS.find((p) => p.id === baseId);
}

export function getProviderDisplayName(providerId: string): string {
  const preset = findModelPreset(providerId);
  return preset ? preset.name : providerId;
}
