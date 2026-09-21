/**
 * Pure parser for the chat's navigation commands ("apri i materiali", …).
 * Extracted from ConversationWorkspace.send so the shell keeps shrinking.
 */
import type { SpaceView } from "@/components/builder/ConversationSpace";

const NAVIGATION_PATTERN =
  /^(?:apri|mostra|vai a|gestisci)\s+(?:(?:le|la|i|il|ai|alle)\s+)?(impostazioni|compiti|materiali|squadra|progetti|plugin|automazioni)$/;

export type ConversationNavigation =
  | { target: "settings" }
  | { target: "space"; view: SpaceView };

export function parseConversationNavigation(text: string): ConversationNavigation | null {
  const match = text.trim().toLowerCase().match(NAVIGATION_PATTERN);
  if (!match) return null;
  if (match[1] === "impostazioni") return { target: "settings" };
  return {
    target: "space",
    view: (match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1)) as SpaceView,
  };
}
