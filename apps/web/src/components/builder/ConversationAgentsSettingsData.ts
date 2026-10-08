import { ShieldAlert, ShieldCheck, Zap } from "lucide-react";

export type RoleTemplate = {
  name: string;
  role: string;
  responsibility: string;
  instructions: string;
  autonomyMode: string;
  capabilities: string[];
};

export type AutonomyLevel = {
  id: string;
  title: string;
  desc: string;
  icon: typeof ShieldAlert;
};

export type AgentCognitiveConfig = {
  fallback_connection_id?: string | null;
  thinking_mode?: boolean;
  temperature?: number;
  max_tokens?: number;
  notes?: string;
};

export const TEMPERATURE_PRESETS = [
  {
    value: 0.1,
    label: "Deterministico",
    desc: "Rigido, ideale per codice, schemi JSON e logica matematica.",
  },
  {
    value: 0.5,
    label: "Bilanciato",
    desc: "Equilibrato per architettura di prodotto, piani e sintesi.",
  },
  {
    value: 0.8,
    label: "Creativo",
    desc: "Esplorativo per copywriting, brainstorming e redazione libera.",
  },
] as const;

export const TOKEN_BUDGET_PRESETS = [4096, 8192, 16384, 32768] as const;

export function parseAgentCognitiveConfig(methodStr?: string | null): AgentCognitiveConfig {
  if (!methodStr || !methodStr.trim()) {
    return {
      fallback_connection_id: null,
      thinking_mode: false,
      temperature: 0.5,
      max_tokens: 8192,
    };
  }

  try {
    const parsed = JSON.parse(methodStr) as Record<string, unknown>;
    const res: AgentCognitiveConfig = {
      fallback_connection_id:
        typeof parsed["fallback_connection_id"] === "string" ? parsed["fallback_connection_id"] : null,
      thinking_mode: Boolean(parsed["thinking_mode"]),
      temperature:
        typeof parsed["temperature"] === "number" ? parsed["temperature"] : 0.5,
      max_tokens:
        typeof parsed["max_tokens"] === "number" ? parsed["max_tokens"] : 8192,
    };
    if (typeof parsed["notes"] === "string") {
      res.notes = parsed["notes"];
    }
    return res;
  } catch {
    return {
      fallback_connection_id: null,
      thinking_mode: false,
      temperature: 0.5,
      max_tokens: 8192,
      notes: methodStr,
    };
  }
}

export function serializeAgentCognitiveConfig(
  existingMethod: string | null | undefined,
  config: AgentCognitiveConfig,
): string {
  let existingNotes: string | undefined = config.notes;
  if (!existingNotes && existingMethod) {
    try {
      const parsed = JSON.parse(existingMethod) as Record<string, unknown>;
      if (typeof parsed["notes"] === "string") existingNotes = parsed["notes"];
    } catch {
      existingNotes = existingMethod;
    }
  }

  const payload: Record<string, unknown> = {
    fallback_connection_id: config.fallback_connection_id || null,
    thinking_mode: Boolean(config.thinking_mode),
    temperature: config.temperature ?? 0.5,
    max_tokens: config.max_tokens ?? 8192,
  };
  if (existingNotes) {
    payload["notes"] = existingNotes;
  }

  return JSON.stringify(payload);
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    name: "Architetto di Prodotto",
    role: "Product Architect & Strategist",
    responsibility: "Definisce requisiti, roadmap e scompone gli obiettivi in deliverable operativi.",
    instructions:
      "Sei l'Architetto del Prodotto. Il tuo compito è analizzare la visione dell'utente, chiarire ambiguità e strutturare piani d'azione pragmatici con criteri di accettazione verificabili.",
    autonomyMode: "supervised",
    capabilities: ["web_search", "filesystem"],
  },
  {
    name: "Ingegnere del Software",
    role: "Full-Stack Engineer",
    responsibility: "Scrive codice pulito, esegue refactoring e implementa soluzioni end-to-end.",
    instructions:
      "Sei uno sviluppatore senior. Scrivi codice modulare, tipizzato e ben documentato. Preferisci soluzioni semplici ed estendibili, testando sempre la coerenza dell'architettura.",
    autonomyMode: "supervised",
    capabilities: ["code_sandbox", "filesystem", "mcp_tools"],
  },
  {
    name: "Ricercatore & Analista",
    role: "Deep Research Specialist",
    responsibility: "Esplora documentazione tecnica, analizza mercati e sintetizza dati complessi.",
    instructions:
      "Sei un ricercatore meticoloso. Raccogli fonti autorevoli, verifichi informazioni e fornisci sintesi strutturate con pro, contro ed evidenze verificabili.",
    autonomyMode: "supervised",
    capabilities: ["web_search", "filesystem"],
  },
];

export const AUTONOMY_LEVELS: AutonomyLevel[] = [
  {
    id: "supervised",
    title: "Supervisione umana (staging)",
    desc: "Ogni run, comando e modifica file attende l'approvazione di una persona nelle code di revisione. Consigliato per codice e scritture.",
    icon: ShieldAlert,
  },
  {
    id: "autonomous",
    title: "Autonomo (auto-approvazione policy)",
    desc: "I run e i gate in container vengono approvati dalla policy in modo tracciato (marcati 'auto-approvazione prevista'); resta tutto nel registro di audit.",
    icon: Zap,
  },
];

/** Etichetta del badge per il livello di autonomia (valori del motore: supervised|autonomous). */
export function autonomyLabel(mode?: string): string {
  if (mode === "autonomous") return "Autonomo";
  return "Supervisione umana";
}
