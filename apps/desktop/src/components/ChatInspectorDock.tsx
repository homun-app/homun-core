import { Loader2 } from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { SubagentInfo } from "../lib/chatApi";
import type {
  InspectorTabKind,
  InspectorWorkspaceState,
} from "../lib/inspectorWorkspace";
import type { ParsedArtifact } from "./MessageArtifacts";
import type {
  ChatAttachment,
  ComputerSession,
  ComputerSurfaceKind,
} from "../types";
import { InspectorWorkspace } from "./InspectorWorkspace";
import {
  INSPECTOR_VIEW_LABEL_KEY,
  InspectorView,
  type IslandSource,
} from "./InspectorView";

interface ChatInspectorDockProps {
  activeSurface: ComputerSurfaceKind;
  artifactCatalogError: boolean;
  artifacts: ParsedArtifact[];
  availableViews: { key: InspectorTabKind }[];
  computerSession: ComputerSession;
  controlBusy: boolean;
  controlError: string | null;
  goalSeed: string | null;
  inspectorResourcesReady: boolean;
  layoutRef: RefObject<HTMLElement | null>;
  operationalPlanMarkdown?: string;
  previewDataUrl: string | null;
  ratio: number;
  sources: IslandSource[];
  state: InspectorWorkspaceState;
  subagents: SubagentInfo[];
  threadId: string;
  uploadedFiles: ChatAttachment[];
  onActivate: (tabId: string) => void;
  onAdd: (kind: InspectorTabKind) => void;
  onCloseTab: (tabId: string) => void;
  onGoalSeedConsumed: () => void;
  onHide: () => void;
  onMoveTab: (tabId: string, targetIndex: number) => void;
  onOpenArtifact: (artifact: ParsedArtifact) => void;
  onOpenFile: (path: string) => void;
  onOpenFilesIndex: () => void;
  onPauseComputer: () => void;
  onRatioCommit: (ratio: number) => void;
  onResumeComputer: () => void;
  onRetryArtifactCatalog: () => void;
  onSelectSurface: (surface: ComputerSurfaceKind) => void;
  onTakeoverComputer: () => void;
  onToggleFocus: () => void;
}

export function ChatInspectorDock({
  activeSurface,
  artifactCatalogError,
  artifacts,
  availableViews,
  computerSession,
  controlBusy,
  controlError,
  goalSeed,
  inspectorResourcesReady,
  layoutRef,
  operationalPlanMarkdown,
  previewDataUrl,
  ratio,
  sources,
  state,
  subagents,
  threadId,
  uploadedFiles,
  onActivate,
  onAdd,
  onCloseTab,
  onGoalSeedConsumed,
  onHide,
  onMoveTab,
  onOpenArtifact,
  onOpenFile,
  onOpenFilesIndex,
  onPauseComputer,
  onRatioCommit,
  onResumeComputer,
  onRetryArtifactCatalog,
  onSelectSurface,
  onTakeoverComputer,
  onToggleFocus,
}: ChatInspectorDockProps) {
  const { t } = useTranslation();

  return (
    <InspectorWorkspace
      layoutRef={layoutRef}
      state={state}
      ratio={ratio}
      addItems={availableViews.map((view) => ({
        kind: view.key,
        title: t(INSPECTOR_VIEW_LABEL_KEY[view.key]),
      }))}
      onActivate={onActivate}
      onCloseTab={onCloseTab}
      onMoveTab={onMoveTab}
      onAdd={onAdd}
      onHide={onHide}
      onToggleFocus={onToggleFocus}
      onRatioCommit={onRatioCommit}
      renderTab={(tab) =>
        !inspectorResourcesReady && (tab.kind === "file" || tab.kind === "artifact") ? (
          <div className="workbench-empty">
            <Loader2 size={22} className="spin" />
            <p>{t("chat.loadingActivity")}</p>
          </div>
        ) : (
          <InspectorView
            descriptor={tab}
            artifacts={artifacts}
            artifactCatalogError={artifactCatalogError}
            uploadedFiles={uploadedFiles}
            threadId={threadId}
            goalSeed={goalSeed}
            onGoalSeedConsumed={onGoalSeedConsumed}
            operationalPlanMarkdown={operationalPlanMarkdown}
            layoutSignal={`${state.activeTabId}:${ratio}`}
            onOpenFile={onOpenFile}
            onOpenFilesIndex={onOpenFilesIndex}
            onOpenArtifact={onOpenArtifact}
            onRetryArtifactCatalog={onRetryArtifactCatalog}
            sources={sources}
            subagents={subagents}
            activeSurface={activeSurface}
            controlBusy={controlBusy}
            controlError={controlError}
            onPauseComputer={onPauseComputer}
            onResumeComputer={onResumeComputer}
            onSelectSurface={onSelectSurface}
            onTakeoverComputer={onTakeoverComputer}
            previewDataUrl={previewDataUrl}
            computerSession={computerSession}
            onCloseTab={() => onCloseTab(tab.id)}
          />
        )
      }
    />
  );
}
