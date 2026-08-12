import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import { ChatView } from "./ChatView";
import { ShallowView } from "./ShallowView";
import {
  automationProposals,
  brainRun,
  learningInsights,
} from "../data/mockData";
import {
  contextBudgetCompressionRatio,
  contextBudgetSummary,
} from "../lib/contextBudgetDisplay";
import type {
  AutomationCreateteInput,
  ChatAttachmentInput,
  CoreUncertainEffectOutcome,
  ManagedAutomation,
} from "../lib/coreBridge";
import type { PluginHost, PluginManifest } from "../plugins/registry";
import type {
  ApprovelItem,
  ChatAttachment,
  ChatMessage,
  ChatThread,
  ConnectionItem,
  SettingsSectionId,
  UncertainEffectItem,
  ViewId,
} from "../types";

// Secondary views are not on the path to the first chat paint; keeping them out
// of the eager chunk avoids paying parse cost before the chat is interactive.
const AutomationsView = lazy(() =>
  import("./AutomationsView").then((m) => ({ default: m.AutomationsView })),
);
const ContainedComputerView = lazy(() =>
  import("./ContainedComputerView").then((m) => ({
    default: m.ContainedComputerView,
  })),
);
const SettingsView = lazy(() =>
  import("./SettingsView").then((m) => ({ default: m.SettingsView })),
);
const LearningView = lazy(() =>
  import("./LearningView").then((m) => ({ default: m.LearningView })),
);

export interface PendingTemplateAutoSubmit {
  id: string;
  threadId: string;
  prompt: string;
  visibleText: string;
  attachments: ChatAttachmentInput[];
  visibleAttachments?: ChatAttachment[];
  mode?: string;
}

export interface AppWorkspaceProps {
  activeView: ViewId;
  isSettings: boolean;
  sidebarCollapsed: boolean;
  activeThread: ChatThread;
  activeMessages: ChatMessage[];
  approvals: ApprovelItem[];
  approvalBusyId: string | null;
  uncertainEffects: UncertainEffectItem[];
  effectResolutionBusyId: string | null;
  effectResolutionError: string | null;
  islandRefreshNonce: number;
  bumpIslandRefreshNonce: () => void;
  runtimeContextRevision: number;
  incomingBackgroundTurn: {
    turnId: string;
    threadId: string;
    userMessageId: string;
    assistantMessageId: string;
  } | null;
  autoSubmit: PendingTemplateAutoSubmit | null;
  settingsSection: SettingsSectionId;
  settingsSub: string;
  connections: ConnectionItem[];
  automations: ManagedAutomation[];
  enabledPlugins: PluginManifest[];
  pluginHost: PluginHost;
  onExpandSidebar: () => void;
  onOpenSearch: () => void;
  onOpenUsageSettings: () => void;
  onMessagesChange: (messages: ChatMessage[]) => void;
  onAutoSubmitConsumed: (id: string) => void;
  onResolveEffect: (
    effect: UncertainEffectItem,
    outcome: CoreUncertainEffectOutcome,
  ) => void | Promise<void>;
  onApproveApprovel: (
    approvalId: string,
    options?: {
      scope?: "once" | "always";
      browser_visibility?: "auto" | "visible" | "headless";
    },
  ) => void | Promise<void>;
  onRejectApprovel: (approvalId: string) => void | Promise<void>;
  onRuntimeChanged: () => void | Promise<void>;
  onThreadChanged: () => void | Promise<void>;
  onStreamingChange: (busy: boolean) => void;
  onPluginsChanged: () => void | Promise<void>;
  onCreateteAutomation: (input: AutomationCreateteInput) => void | Promise<void>;
  onUpdateAutomation: (
    id: string,
    input: Partial<AutomationCreateteInput>,
  ) => void | Promise<void>;
  onToggleAutomation: (id: string) => void | Promise<void>;
  onDeleteAutomation: (id: string) => void | Promise<void>;
}

export function AppWorkspace({
  activeView,
  isSettings,
  sidebarCollapsed,
  activeThread,
  activeMessages,
  approvals,
  approvalBusyId,
  uncertainEffects,
  effectResolutionBusyId,
  effectResolutionError,
  islandRefreshNonce,
  bumpIslandRefreshNonce,
  runtimeContextRevision,
  incomingBackgroundTurn,
  autoSubmit,
  settingsSection,
  settingsSub,
  connections,
  automations,
  enabledPlugins,
  pluginHost,
  onExpandSidebar,
  onOpenSearch,
  onOpenUsageSettings,
  onMessagesChange,
  onAutoSubmitConsumed,
  onResolveEffect,
  onApproveApprovel,
  onRejectApprovel,
  onRuntimeChanged,
  onThreadChanged,
  onStreamingChange,
  onPluginsChanged,
  onCreateteAutomation,
  onUpdateAutomation,
  onToggleAutomation,
  onDeleteAutomation,
}: AppWorkspaceProps) {
  const { t } = useTranslation();

  return (
    <main
      className={`workspace ${isSettings ? "settings-workspace" : ""}`}
      aria-label={t("app.mainWorkspace")}
    >
      <Suspense fallback={null}>
        {activeView === "chat" && (
          <ChatView
            key={activeThread.threadId}
            sidebarCollapsed={sidebarCollapsed}
            onExpandSidebar={onExpandSidebar}
            onOpenSearch={onOpenSearch}
            onOpenUsageSettings={onOpenUsageSettings}
            approvals={approvals}
            approvalBusyId={approvalBusyId}
            uncertainEffects={uncertainEffects}
            effectResolutionBusyId={effectResolutionBusyId}
            effectResolutionError={effectResolutionError}
            computerSessionId={activeThread.computerSessionId}
            messages={activeMessages}
            thread={activeThread}
            onMessagesChange={onMessagesChange}
            islandRefreshNonce={islandRefreshNonce}
            bumpIslandRefreshNonce={bumpIslandRefreshNonce}
            runtimeContextRevision={runtimeContextRevision}
            incomingBackgroundTurn={incomingBackgroundTurn}
            autoSubmit={autoSubmit}
            onAutoSubmitConsumed={onAutoSubmitConsumed}
            onResolveEffect={onResolveEffect}
            onApproveApprovel={onApproveApprovel}
            onRejectApprovel={onRejectApprovel}
            onRuntimeChanged={onRuntimeChanged}
            onThreadChanged={onThreadChanged}
            onStreamingChange={onStreamingChange}
          />
        )}
        {activeView === "learning" && (
          <LearningView
            insights={learningInsights}
            proposals={automationProposals}
          />
        )}
        {activeView === "settings" && (
          <SettingsView
            connections={connections}
            section={settingsSection}
            sub={settingsSub}
            onPluginsChanged={onPluginsChanged}
          />
        )}
        {activeView === "automations" && (
          <AutomationsView
            automations={automations}
            onCreatete={onCreateteAutomation}
            onUpdate={onUpdateAutomation}
            onToggle={onToggleAutomation}
            onDelete={onDeleteAutomation}
          />
        )}
        {enabledPlugins.map(
          (plugin) =>
            activeView === plugin.id && <plugin.Panel key={plugin.id} host={pluginHost} />,
        )}
        {activeView === "browser" && <ContainedComputerView />}
        {activeView === "brain" && (
          <ShallowView
            title="Brain Audit"
            eyebrow={t("app.explainablePlans")}
            description={`Route, loaded tools, memory refs and subagent steps are persisted without raw payload. ${contextBudgetSummary(brainRun.contextBudget)}`}
            stats={[
              { label: "Route", value: brainRun.route },
              { label: "Rounds", value: String(brainRun.plannerRounds) },
              { label: "Tools", value: String(brainRun.loadedTools) },
              {
                label: "Context",
                value: `${Math.round(contextBudgetCompressionRatio(brainRun.contextBudget) * 100)}%`,
              },
            ]}
          />
        )}
      </Suspense>
    </main>
  );
}
