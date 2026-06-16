import type { i18n as I18n } from "i18next";
import i18next from "i18next";
import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import { proattivitaPlugin } from "./proattivita";
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
  /// i18n key with namespace syntax (e.g. "proattivita:title").
  name: string;
  /// i18n key with namespace syntax (e.g. "proattivita:lead").
  description: string;
  /// i18n key with namespace syntax — shown in the nav rail.
  navLabel: string;
  navIcon: LucideIcon;
  // Declared capabilities (informational in path A; enforced at the bridge in B).
  capabilities: string[];
  Panel: ComponentType<PluginPanelProps>;
  /// Registers the plugin's own i18n resource bundles (namespaces) with the host's
  /// i18next instance. Called once at bootstrap for every known plugin — makes the
  /// plugin self-contained for translations too (ADR 0011 §6). In path B this is
  /// how an external plugin publishes its strings to the host.
  registerI18n?: (i18n: I18n) => void;
}

export const pluginRegistry: PluginManifest[] = [proattivitaPlugin];

/// Registers all known plugins' i18n namespaces with the host i18next instance.
/// Call once after `i18n.init()` in the bootstrap. Idempotent per namespace.
export function registerPluginI18n(): void {
  for (const plugin of pluginRegistry) {
    plugin.registerI18n?.(i18next);
  }
}
