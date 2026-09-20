/**
 * Pure work-status and notification helpers for the simulated workspace.
 */

import { isHumanMember, type MemberProfile } from "./conversation-members.ts";
import { phaseText, scenarioForWork, type ConversationScenario } from "./conversation-scenarios.ts";
import type { Work } from "./conversation-types.ts";

type Profiles = Record<string, MemberProfile> | undefined;

export function workStatusLabel(
  w: Work,
  scenarios: ConversationScenario[],
  profiles: Profiles,
): string {
  if (w.request?.status === "pending") return `Aspetta ${w.request.to}`;
  const agent = scenarioForWork(w, scenarios).agent;
  if (isHumanMember(agent, profiles)) {
    if (w.phase === "ready") return "Da svolgere";
    if (w.phase === "proposal") return "Da assegnare";
    return phaseText[w.phase];
  }
  if (w.phase === "approved" && w.autoDelivered) return "Consegnato";
  return phaseText[w.phase];
}

export function isPendingForViewer(
  w: Work,
  viewer: string,
  scenarios: ConversationScenario[],
  profiles: Profiles,
): boolean {
  if (w.coordinatedBy || w.archived) return false;
  if (w.request?.status === "pending") return w.request.to === viewer;
  const agent = scenarioForWork(w, scenarios).agent;
  if (isHumanMember(agent, profiles)) {
    return (
      (w.phase === "ready" && agent === viewer) ||
      (w.phase === "review" && (w.requester || "Fabio") === viewer)
    );
  }
  return (
    (w.phase === "waiting" && (w.requester || "Fabio") === viewer) ||
    (w.phase === "review" && (w.reviewer || w.requester || "Fabio") === viewer)
  );
}

export function isCompletedNoticeForViewer(
  w: Work,
  viewer: string,
  resultNotifications: boolean,
  seenResults: string[],
): boolean {
  return (
    resultNotifications &&
    !w.archived &&
    !w.coordinatedBy &&
    w.phase === "approved" &&
    (w.requester || "Fabio") === viewer &&
    !seenResults.includes(`${viewer}:${w.id}`)
  );
}
