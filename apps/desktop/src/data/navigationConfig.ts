import {
  Blocks,
  Brain,
  CalendarClock,
  ChartNoAxesCombined,
  Cpu,
  FileText,
  KeyRound,
  MessageSquare,
  Monitor,
  MonitorPlay,
  Palette,
  Plug,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  User,
  Users,
} from "lucide-react";
import type { NavItem, SettingsSectionId } from "../types";

// Static core nav. Plugin/addon entries are composed at runtime from the plugin registry.
export const navItems: NavItem[] = [
  { id: "chat", label: "chat.newTask", icon: MessageSquare },
  // Memory lives ONLY in Settings -> Memory (rendered there as <MemoryView embedded />).
  // The top-level nav entry (ADR 0022 Piano UI A4) was removed: it duplicated the exact
  // same MemoryView already reachable from Settings.
  // "Pianificato" (coda dei run) e' confluito in Automazioni: la regola e' la cosa
  // di prima classe; i run si vedono nei thread. Manteniamo l'icona-calendario.
  { id: "automations", label: "nav.automations", icon: CalendarClock },
];

export const settingsSections: Array<{
  id: SettingsSectionId;
  label: string;
  icon: typeof Monitor;
  group: "account" | "capabilities";
}> = [
  { id: "account", label: "settings.account", icon: User, group: "account" },
  { id: "general", label: "settings.general", icon: SlidersHorizontal, group: "account" },
  { id: "appearance", label: "settings.appearance", icon: Palette, group: "account" },
  { id: "runtime", label: "settings.runtime", icon: Cpu, group: "account" },
  { id: "usage", label: "settings.usage.title", icon: ChartNoAxesCombined, group: "account" },
  { id: "privacy", label: "settings.privacy", icon: KeyRound, group: "account" },
  { id: "sandbox", label: "settings.sandbox", icon: Shield, group: "account" },
  { id: "vault", label: "settings.vault", icon: ShieldCheck, group: "account" },
  { id: "memory", label: "nav.memory", icon: Brain, group: "account" },
  { id: "artifacts", label: "settings.artifacts", icon: FileText, group: "account" },
  { id: "contacts", label: "nav.contacts", icon: Users, group: "account" },
  { id: "channels", label: "settings.channels", icon: MessageSquare, group: "capabilities" },
  { id: "connections", label: "settings.connectors", icon: Plug, group: "capabilities" },
  { id: "skills", label: "settings.skills", icon: Sparkles, group: "capabilities" },
  { id: "addon", label: "settings.addon", icon: Blocks, group: "capabilities" },
  { id: "computer", label: "settings.computer.title", icon: MonitorPlay, group: "capabilities" },
];

export const settingsGroupLabels: Record<"account" | "capabilities", string> = {
  account: "settings.account",
  capabilities: "settings.capabilities",
};
