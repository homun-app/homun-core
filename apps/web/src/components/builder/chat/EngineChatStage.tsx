/** Connessione stage-chat motore <-> ConversationWorkspace: mappa i prop.

    Tiene la mappatura (preferenze, menzioni, refresh) fuori dallo shell, che
    resta sotto il ratchet architetturale. */
import type { ConversationPreferences } from "../conversation-preferences";
import type { ConversationScenario } from "../conversation-scenarios";
import type { SpaceData } from "../ConversationSpace";
import type { Work } from "../conversation-types";
import type { EngineWorkspaceState } from "@/hooks/useEngineWorkspace";
import { buildMentionRefs } from "../conversation-mentions";

import { EngineAgentChat } from "./EngineAgentChat";

export function EngineChatStage({
  engine,
  work,
  activeWorkId,
  preferences,
  setPreferences,
  notice,
  setNotice,
  assignee,
  scenarios,
  spaceData,
  onOpenSpace,
  onOpenModels,
  onCreateExample,
  onSend,
  newChatProject,
}: {
  engine: EngineWorkspaceState;
  work: Work | undefined;
  activeWorkId: string | null;
  preferences: ConversationPreferences;
  setPreferences: React.Dispatch<React.SetStateAction<ConversationPreferences>>;
  notice: string;
  setNotice: (notice: string) => void;
  assignee: string;
  scenarios: ConversationScenario[];
  spaceData: SpaceData;
  onOpenSpace:
    | ((space: "Progetti" | "Squadra" | "Materiali", initial?: string, selected?: string) => void)
    | undefined;
  onOpenModels?: (() => void) | undefined;
  onCreateExample: (index: number) => void;
  onSend: (text: string, attachments: File[]) => void;
  newChatProject?: { id: string; name: string } | null | undefined;
}) {
  return (
    <EngineAgentChat
      conversationId={work?.engineConversationId ?? undefined}
      activeWorkId={activeWorkId}
      onSend={onSend}
      notice={notice}
      onClearNotice={() => setNotice("")}
      newChatProject={newChatProject}
      engineBusy={engine.busy}
      onCancelInFlight={() => engine.cancelInFlight()}
      historyLoading={engine.historyLoading}
      autonomyLevel={preferences.autonomyLevel}
      onAutonomyLevelChange={(level) => setPreferences((p) => ({ ...p, autonomyLevel: level }))}
      modelConnectionId={preferences.preferredModelConnectionId || undefined}
      onModelConnectionIdChange={(connId) =>
        setPreferences((p) => ({ ...p, preferredModelConnectionId: connId }))}
      references={buildMentionRefs(scenarios, spaceData, engine.agents)}
      onRefreshEngine={engine.refresh}
      onOpenSpace={onOpenSpace}
      onOpenModels={onOpenModels}
      assignee={assignee}
      scenarios={scenarios}
      spaceData={spaceData}
      onCreateExample={onCreateExample}
    />
  );
}
