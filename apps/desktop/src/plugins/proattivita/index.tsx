import type { i18n as I18n } from "i18next";
import { Lightbulb } from "lucide-react";
import { ProattivitaView } from "../../components/ProattivitaView";
import type { PluginManifest } from "../registry";
import en from "./locales/en.json";
import it from "./locales/it.json";

/**
 * The Proactivity addon — the FIRST plugin (ADR 0011 §9).
 *
 * Self-contained: its manifest, panel AND translations live together. The host
 * calls `registerI18n` once at bootstrap to wire this plugin's i18n namespace;
 * detaching the plugin (removing it from the registry) makes its nav entry,
 * panel and translations all vanish together.
 */
export const proattivitaPlugin: PluginManifest = {
  id: "proattivita",
  name: "proattivita:title",
  description: "proattivita:lead",
  navLabel: "proattivita:title",
  navIcon: Lightbulb,
  capabilities: [
    "suggestions.read",
    "suggestions.act",
    "memory.read",
    "connectors.read",
    "chat.create",
  ],
  Panel: ({ host }) => <ProattivitaView onOpenChat={host.openChat} />,
  registerI18n: (i18n: I18n) => {
    i18n.addResourceBundle("en", "proattivita", en);
    i18n.addResourceBundle("it", "proattivita", it);
  },
};
