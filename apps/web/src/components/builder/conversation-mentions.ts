/** Menzionabili nel composer (@): scenario membri + roster attivo del motore. */
import { memberProfile } from "./conversation-members";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import type { ConversationScenario } from "./conversation-scenarios";
import type { SpaceData } from "./ConversationSpace";
import type { ChatReference } from "./StudioChatInput";

export function buildMentionRefs(
  scenarios: ConversationScenario[],
  spaceData: SpaceData,
  engineAgents: EngineAgentProfile[] | undefined,
): ChatReference[] {
  return [
    ...scenarios
      .filter(
        (s, i) =>
          memberProfile(s.agent, spaceData.profiles).invitation !== "pending" &&
          scenarios.findIndex((a) => a.agent === s.agent) === i &&
          !spaceData.removedPeople?.includes(s.agent),
      )
      .map((s) => ({
        id: s.agent,
        name: s.agent,
        kind: "member" as const,
        description: s.role,
      })),
    // Engine roster members are mentionable too: the squad the person built
    // with the motor must answer @ even when no demo scenario carries them.
    ...(engineAgents ?? [])
      .filter((agent) => agent.status === "active")
      .filter((agent) => !scenarios.some((s) => s.agent === agent.name))
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        kind: "member" as const,
        description: agent.role,
      })),
  ];
}
