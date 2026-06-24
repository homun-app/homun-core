import type { i18n as I18n } from "i18next";
import { Presentation } from "lucide-react";
import { BrandKitPanel } from "../../components/BrandKitPanel";
import type { PluginManifest } from "../registry";
import en from "./locales/en.json";
import it from "./locales/it.json";

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
  Panel: () => <BrandKitPanel />,
  registerI18n: (i18n: I18n) => {
    i18n.addResourceBundle("en", "presentations", en);
    i18n.addResourceBundle("it", "presentations", it);
  },
};
