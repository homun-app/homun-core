/**
 * Settings navigation: Essenziale (day-1 PMI) vs Avanzato (jargon / power tools).
 * Keep labels human; section ids stay stable for deep-links and tests.
 */
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Bell,
  BookMarked,
  Bot,
  ClipboardCheck,
  Cpu,
  Database,
  Globe,
  HelpCircle,
  Brain,
  Puzzle,
  Settings2,
  Sparkles,
  UserRound,
  UsersRound,
  Wallet,
  Zap,
} from "lucide-react";

export type SettingsNavItem = {
  id: string;
  label: string;
  icon: LucideIcon;
};

export type SettingsNavGroup = {
  title: string;
  level: "essential" | "advanced";
  items: SettingsNavItem[];
};

export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    title: "Essenziale",
    level: "essential",
    items: [
      { id: "space", label: "Spazio e profilo", icon: UserRound },
      { id: "models", label: "Modelli collegati", icon: Brain },
      { id: "budget", label: "Spesa e limiti", icon: Wallet },
      { id: "preferences", label: "Aspetto e lingua", icon: Settings2 },
      { id: "help", label: "Guida", icon: HelpCircle },
    ],
  },
  {
    title: "Avanzato",
    level: "advanced",
    items: [
      { id: "plugins", label: "Plugin e strumenti", icon: Puzzle },
      { id: "notifications", label: "Canali e messaggi", icon: Bell },
      { id: "automations", label: "Automazioni", icon: Zap },
      { id: "review", label: "Code di revisione", icon: ClipboardCheck },
      { id: "people", label: "Persone e inviti", icon: UsersRound },
      { id: "remote-spaces", label: "Spazi remoti", icon: Globe },
      { id: "memory", label: "Memoria condivisa", icon: BookMarked },
      { id: "agents", label: "Catalogo squadra", icon: Bot },
      { id: "skills", label: "Competenze e skill", icon: Sparkles },
      { id: "engine", label: "Manutenzione", icon: Cpu },
      { id: "archive", label: "Archivio", icon: Archive },
      ...(import.meta.env.DEV
        ? ([{ id: "data", label: "Dati della demo", icon: Database }] as const)
        : []),
    ],
  },
];
