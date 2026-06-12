import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import { Lightbulb } from "lucide-react";
import { ProattivitaView } from "../components/ProattivitaView";
import type { ProactivitySuggestion } from "../lib/coreBridge";

// The host-provided capability surface a plugin's panel may use (ADR 0011 §6).
// In path A this is a plain object; in path B it becomes the typed postMessage
// bridge across the iframe boundary — same shape, so conversion is mechanical.
export interface PluginHost {
  openChat: (suggestion: ProactivitySuggestion) => void | Promise<void>;
}

export interface PluginPanelProps {
  host: PluginHost;
}

// A self-contained addon: its nav entry, panel AND engine live and die together.
// `id` matches BOTH the ViewId (nav/render) and the backend plugin id (enabled
// flag + engine gate) — one canonical id, no mapping layer.
export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  navLabel: string;
  navIcon: LucideIcon;
  // Declared capabilities (informational in path A; enforced at the bridge in B).
  capabilities: string[];
  Panel: ComponentType<PluginPanelProps>;
}

export const pluginRegistry: PluginManifest[] = [
  {
    id: "proattivita",
    name: "Proattività",
    description:
      "Suggerimenti proattivi sui tuoi progetti e sul personale, come schede. Apri quello che ti serve e creo la chat nello spazio giusto.",
    navLabel: "Proattività",
    navIcon: Lightbulb,
    capabilities: [
      "suggestions.read",
      "suggestions.act",
      "memory.read",
      "connectors.read",
      "chat.create",
    ],
    Panel: ({ host }) => <ProattivitaView onOpenChat={host.openChat} />,
  },
];
