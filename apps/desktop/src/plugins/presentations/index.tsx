import type { i18n as I18n } from "i18next";
import { Presentation } from "lucide-react";
import { BrandKitPanel } from "../../components/BrandKitPanel";
import type { PluginManifest } from "../registry";
import en from "./locales/en.json";
import it from "./locales/it.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";

/**
 * The Presentations addon — produces on-brand decks (and documents). Phase F2: the
 * BRAND KIT (persistent colours, fonts, logo) that the deck generator applies. The
 * visual deck generator + viewer build on top in later phases. Like every plugin its
 * manifest, panel and translations live together (ADR 0011 §6).
 */
export const presentationsPlugin: PluginManifest = {
  id: "presentations",
  name: "presentations:title",
  description: "presentations:lead",
  navLabel: "presentations:nav",
  navIcon: Presentation,
  navSection: "create",
  promoted: true,
  navOrder: 10,
  capabilities: ["artifacts.read", "artifacts.write", "images.generate"],
  Panel: ({ host }) => <BrandKitPanel host={host} />,
  registerI18n: (i18n: I18n) => {
    i18n.addResourceBundle("en", "presentations", en);
    i18n.addResourceBundle("it", "presentations", it);
    i18n.addResourceBundle("es", "presentations", es);
    i18n.addResourceBundle("fr", "presentations", fr);
    i18n.addResourceBundle("de", "presentations", de);
  },
};
