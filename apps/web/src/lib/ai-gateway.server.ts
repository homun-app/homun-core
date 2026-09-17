import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/** Provider verso il gateway AI di Lovable (nessuna chiave da gestire lato utente). */
export function createLovableAiGatewayProvider(apiKey: string) {
  return createOpenAICompatible({
    name: "lovable",
    baseURL: "https://ai.gateway.lovable.dev/v1",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

export const HOMUN_MODEL = "google/gemini-3.8-flash";
