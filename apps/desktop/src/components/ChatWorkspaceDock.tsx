import type { SubagentInfo } from "../lib/chatApi";
import type { WorkspaceSection } from "../lib/workspaceIslandSections";
import type { PlanStep } from "./ChatPayloadParsers";
import { AdaptiveWorkspaceIsland } from "./AdaptiveWorkspaceIsland";
import { ChatComputerPanel } from "./ChatComputerPanel";
import { WorkspaceIslandSections } from "./WorkspaceIslandSections";
import type { IslandSource } from "./InspectorView";

interface ChatWorkspaceDockProps {
  activity: string[];
  artifactSources: IslandSource[];
  browserBudgetAssistantId: string | null;
  browserBudgetMessage: string | null;
  disabled: boolean;
  fileSources: IslandSource[];
  openActivityNonce: number;
  planSteps: PlanStep[];
  previewDataUrl: string | null;
  previewTitle: string;
  projectObjective: string | null;
  sections: WorkspaceSection[];
  subagents: SubagentInfo[];
  threadId: string;
  workInProgress: boolean;
  onComputerLiveChange: (status: { active: boolean; activity: string | null }) => void;
  onOpenComputer: () => void;
  onOpenSource: (source: IslandSource) => void;
  onRetryBrowserBudget: (assistantMessageId: string) => void;
}

export function ChatWorkspaceDock({
  activity,
  artifactSources,
  browserBudgetAssistantId,
  browserBudgetMessage,
  disabled,
  fileSources,
  openActivityNonce,
  planSteps,
  previewDataUrl,
  previewTitle,
  projectObjective,
  sections,
  subagents,
  threadId,
  workInProgress,
  onComputerLiveChange,
  onOpenComputer,
  onOpenSource,
  onRetryBrowserBudget,
}: ChatWorkspaceDockProps) {
  return (
    <>
      <AdaptiveWorkspaceIsland
        threadId={threadId}
        sections={sections}
        disabled={disabled}
        openSectionRequest={{ section: "activity", nonce: openActivityNonce }}
        renderSection={(section) => (
          <WorkspaceIslandSections
            section={section}
            projectObjective={projectObjective}
            planSteps={planSteps}
            subagents={subagents}
            activity={activity}
            workInProgress={workInProgress}
            browserBudgetMessage={browserBudgetMessage}
            browserBudgetAssistantId={browserBudgetAssistantId}
            previewDataUrl={previewDataUrl}
            previewTitle={previewTitle}
            artifactSources={artifactSources}
            fileSources={fileSources}
            onRetryBrowserBudget={onRetryBrowserBudget}
            onOpenComputer={onOpenComputer}
            onOpenSource={onOpenSource}
          />
        )}
      />
      <div className="chat-computer-runtime">
        <ChatComputerPanel threadId={threadId} onLiveChange={onComputerLiveChange} />
      </div>
    </>
  );
}
