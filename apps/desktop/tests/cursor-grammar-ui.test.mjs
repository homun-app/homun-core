import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
const packageManifest = await readFile(new URL("../package.json", import.meta.url), "utf8");
const legacyStyles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const foundation = await readFile(new URL("../src/styles/foundation.css", import.meta.url), "utf8").catch(
  (error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  },
);
const iconButton = await readFile(
  new URL("../src/components/ui/IconButton.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const menuSurface = await readFile(
  new URL("../src/components/ui/MenuSurface.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const menus = await readFile(new URL("../src/styles/menus.css", import.meta.url), "utf8").catch(
  (error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  },
);
const sidebarFilters = await readFile(
  new URL("../src/components/SidebarFilters.tsx", import.meta.url),
  "utf8",
);
const sidebar = await readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
const sidebarStyles = await readFile(
  new URL("../src/styles/sidebar.css", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const sidebarFilterState = await readFile(
  new URL("../src/lib/sidebarFilterState.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const conversationAttention = await readFile(
  new URL("../src/lib/conversationAttention.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatView = await readFile(
  new URL("../src/components/ChatView.tsx", import.meta.url),
  "utf8",
);
const useChatTurnStateMachine = await readFile(
  new URL("../src/components/useChatTurnStateMachine.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const useChatTurnSubmissionHook = await readFile(
  new URL("../src/components/useChatTurnSubmission.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const useChatStreamResumeHook = await readFile(
  new URL("../src/components/useChatStreamResume.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatViewTypes = await readFile(
  new URL("../src/components/ChatViewTypes.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatConversationScroll = await readFile(
  new URL("../src/components/useChatConversationScroll.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatProjectContext = await readFile(
  new URL("../src/components/useChatProjectContext.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatMemoryArtifacts = await readFile(
  new URL("../src/components/useChatMemoryArtifacts.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatFollowUpsHook = await readFile(
  new URL("../src/components/useChatFollowUps.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatActiveTurnElapsed = await readFile(
  new URL("../src/components/useChatActiveTurnElapsed.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatTurnStatusHook = await readFile(
  new URL("../src/components/useChatTurnStatus.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatStreamingNotifier = await readFile(
  new URL("../src/components/useChatStreamingNotifier.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatBranchesHook = await readFile(
  new URL("../src/components/useChatBranches.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatInspectorWorkspace = await readFile(
  new URL("../src/components/useChatInspectorWorkspace.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatComputerSessionHook = await readFile(
  new URL("../src/components/useChatComputerSession.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatSteeringQueueHook = await readFile(
  new URL("../src/components/useChatSteeringQueue.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const useChatApprovalFlowHook = await readFile(
  new URL("../src/components/useChatApprovalFlow.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatBrowserActivityLifecycleHook = await readFile(
  new URL("../src/components/useChatBrowserActivityLifecycle.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatActivityProjectionHook = await readFile(
  new URL("../src/components/useChatActivityProjection.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatStreamEventProjection = await readFile(
  new URL("../src/components/chatStreamEventProjection.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatStreamLifecycleHook = await readFile(
  new URL("../src/components/useChatStreamLifecycle.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatAutoTitleHook = await readFile(
  new URL("../src/components/useChatAutoTitle.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatMessageEditingHook = await readFile(
  new URL("../src/components/useChatMessageEditing.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatMessageActionsHook = await readFile(
  new URL("../src/components/useChatMessageActions.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const appWorkspace = await readFile(
  new URL("../src/components/AppWorkspace.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const appCoreMappers = await readFile(
  new URL("../src/lib/appCoreMappers.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const contextBudgetDisplay = await readFile(
  new URL("../src/lib/contextBudgetDisplay.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const templateWorkflowPrompt = await readFile(
  new URL("../src/lib/templateWorkflowPrompt.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatMessagePreservation = await readFile(
  new URL("../src/lib/chatMessagePreservation.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const appPluginNavigation = await readFile(
  new URL("../src/lib/appPluginNavigation.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const busyThreadProjection = await readFile(
  new URL("../src/lib/busyThreadProjection.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const proactivityChatSeed = await readFile(
  new URL("../src/lib/proactivityChatSeed.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const taskQueueProjection = await readFile(
  new URL("../src/lib/taskQueueProjection.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const taskQueueController = await readFile(
  new URL("../src/lib/useTaskQueueController.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const threadSnapshotProjection = await readFile(
  new URL("../src/lib/threadSnapshotProjection.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatThreadMutations = await readFile(
  new URL("../src/lib/useChatThreadMutations.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatThreadCreation = await readFile(
  new URL("../src/lib/useChatThreadCreation.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatReadModelController = await readFile(
  new URL("../src/lib/useChatReadModelController.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const pluginHostController = await readFile(
  new URL("../src/lib/usePluginHostController.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const threadAttentionNotifications = await readFile(
  new URL("../src/lib/useThreadAttentionNotifications.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const initialThreadSelection = await readFile(
  new URL("../src/lib/initialThreadSelection.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const initialChatThreadsLoader = await readFile(
  new URL("../src/lib/useInitialChatThreadsLoader.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const automationController = await readFile(
  new URL("../src/lib/useAutomationController.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const capabilityController = await readFile(
  new URL("../src/lib/useCapabilityController.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const onboardingSetupGate = await readFile(
  new URL("../src/lib/useOnboardingSetupGate.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const pluginController = await readFile(
  new URL("../src/lib/usePluginController.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const responsiveDrawer = await readFile(
  new URL("../src/lib/useResponsiveDrawer.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const backgroundStreams = await readFile(
  new URL("../src/lib/useBackgroundStreams.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const appNavigation = await readFile(
  new URL("../src/lib/useAppNavigation.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const threadAttentionController = await readFile(
  new URL("../src/lib/useThreadAttentionController.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const operationalReadModelPoller = await readFile(
  new URL("../src/lib/useOperationalReadModelPoller.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const appEventSubscription = await readFile(
  new URL("../src/lib/useAppEventSubscription.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatStyles = await readFile(new URL("../src/styles/chat.css", import.meta.url), "utf8").catch(
  (error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  },
);
const composerShell = await readFile(
  new URL("../src/components/ComposerShell.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const composerContainer = await readFile(
  new URL("../src/components/ComposerContainer.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatComposerDock = await readFile(
  new URL("../src/components/ChatComposerDock.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const computerDetailPanel = await readFile(
  new URL("../src/components/ComputerDetailPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatEmptyHero = await readFile(
  new URL("../src/components/ChatEmptyHero.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatTopbar = await readFile(
  new URL("../src/components/ChatTopbar.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatTranscript = await readFile(
  new URL("../src/components/ChatTranscript.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatInspectorDock = await readFile(
  new URL("../src/components/ChatInspectorDock.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatWorkspaceProjections = await readFile(
  new URL("../src/components/ChatWorkspaceProjections.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageAttachmentList = await readFile(
  new URL("../src/components/MessageAttachmentList.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageActionBar = await readFile(
  new URL("../src/components/MessageActionBar.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageActionFooter = await readFile(
  new URL("../src/components/MessageActionFooter.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatMessageContent = await readFile(
  new URL("../src/components/ChatMessageContent.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const richMessageRenderer = await readFile(
  new URL("../src/components/RichMessageRenderer.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatMessageAfterContent = await readFile(
  new URL("../src/components/ChatMessageAfterContent.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatMessageRow = await readFile(
  new URL("../src/components/ChatMessageRow.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatBranchPicker = await readFile(
  new URL("../src/components/ChatBranchPicker.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatFollowUps = await readFile(
  new URL("../src/components/ChatFollowUps.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageEditBox = await readFile(
  new URL("../src/components/MessageEditBox.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageMetaCopy = await readFile(
  new URL("../src/components/MessageMetaCopy.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageStatusBadges = await readFile(
  new URL("../src/components/MessageStatusBadges.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatSystemMessageHeader = await readFile(
  new URL("../src/components/ChatSystemMessageHeader.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const pendingAssistantMessage = await readFile(
  new URL("../src/components/PendingAssistantMessage.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageActivity = await readFile(
  new URL("../src/components/MessageActivity.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const assistantThinkingState = await readFile(
  new URL("../src/components/AssistantThinkingState.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const operationalPlanPreview = await readFile(
  new URL("../src/components/OperationalPlanPreview.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageChoiceCard = await readFile(
  new URL("../src/components/MessageChoiceCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messagePlanProposeCard = await readFile(
  new URL("../src/components/MessagePlanProposeCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageDiffCard = await readFile(
  new URL("../src/components/MessageDiffCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageGoalProposeCard = await readFile(
  new URL("../src/components/MessageGoalProposeCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageVaultRevealCard = await readFile(
  new URL("../src/components/MessageVaultRevealCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageSandboxReadOnlyCard = await readFile(
  new URL("../src/components/MessageSandboxReadOnlyCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageComposioReconnectCard = await readFile(
  new URL("../src/components/MessageComposioReconnectCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const inlineUncertainEffectPanel = await readFile(
  new URL("../src/components/InlineUncertainEffectPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const inlineApprovelPanel = await readFile(
  new URL("../src/components/InlineApprovelPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messagePaymentApprovalCard = await readFile(
  new URL("../src/components/MessagePaymentApprovalCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageFsAuthorizeCard = await readFile(
  new URL("../src/components/MessageFsAuthorizeCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageSandboxEscalateCard = await readFile(
  new URL("../src/components/MessageSandboxEscalateCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageComposioConfirmCard = await readFile(
  new URL("../src/components/MessageComposioConfirmCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageConnectSuggestCard = await readFile(
  new URL("../src/components/MessageConnectSuggestCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageVaultProposeCard = await readFile(
  new URL("../src/components/MessageVaultProposeCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const artifactsPanel = await readFile(
  new URL("../src/components/ArtifactsPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const goalsPanel = await readFile(
  new URL("../src/components/GoalsPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const memoryGraphPanel = await readFile(
  new URL("../src/components/MemoryGraphPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const memoryView = await readFile(
  new URL("../src/components/MemoryView.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const inspectorView = await readFile(
  new URL("../src/components/InspectorView.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const assistantMessageBody = await readFile(
  new URL("../src/components/AssistantMessageBody.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatResumeMarkers = await readFile(
  new URL("../src/lib/chatResumeMarkers.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatEventParts = await readFile(
  new URL("../src/lib/chatEventParts.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatEventPartsImpl = await readFile(
  new URL("../src/lib/chatEventParts.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatViewMessages = await readFile(
  new URL("../src/lib/chatViewMessages.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatPayloadParsers = await readFile(
  new URL("../src/components/ChatPayloadParsers.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const planStepsModule = await readFile(
  new URL("../src/lib/chat-runtime/planSteps.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const kernelProjectionPresenterModule = await readFile(
  new URL("../src/lib/chat-runtime/kernelProjectionPresenter.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatSteeringPrompt = await readFile(
  new URL("../src/lib/chatSteeringPrompt.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatPromptAssembly = await readFile(
  new URL("../src/lib/chatPromptAssembly.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatMessageMarkerParser = await readFile(
  new URL("../src/components/ChatMessageMarkerParser.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageArtifacts = await readFile(
  new URL("../src/components/MessageArtifacts.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const runtimeContextPanel = await readFile(
  new URL("../src/components/RuntimeContextPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const runtimeContextHook = await readFile(
  new URL("../src/lib/useRuntimeContext.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const adaptiveWorkspaceIsland = await readFile(
  new URL("../src/components/AdaptiveWorkspaceIsland.tsx", import.meta.url),
  "utf8",
);
const workspaceIslandSections = await readFile(
  new URL("../src/components/WorkspaceIslandSections.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatWorkspaceDock = await readFile(
  new URL("../src/components/ChatWorkspaceDock.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const workspaceIslandStyles = await readFile(
  new URL("../src/styles/workspace-island.css", import.meta.url),
  "utf8",
);
const chatApi = await readFile(new URL("../src/lib/chatApi.ts", import.meta.url), "utf8");
const coreBridge = await readFile(new URL("../src/lib/coreBridge.ts", import.meta.url), "utf8");
const composerStyles = await readFile(
  new URL("../src/styles/composer.css", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const reducedMotion = foundation.match(
  /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/,
)?.[0] ?? "";

function cssBlock(styles, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?\\n\\}`, "m"))?.[0] ?? "";
}

test("the desktop entrypoint uses the compact visual foundation", () => {
  assert.doesNotMatch(main, /@fontsource\/hanken-grotesk/);
  assert.match(
    main,
    /import "\.\/styles\.css";\s*import "\.\/styles\/foundation\.css";\s*import "\.\/styles\/menus\.css";/,
  );
});

test("App delegates core-to-ui mapping helpers to appCoreMappers", () => {
  assert.match(app, /from "\.\/lib\/appCoreMappers";/);
  for (const helper of [
    "mapCoreChatThread",
    "mapCoreThreadAttention",
    "mapCoreChatMessage",
    "pendingChatAttachmentFromInput",
    "starterMessages",
    "summarizeThreadTitle",
    "updateThreadPreview",
    "currentTimestampSeconds",
    "mapCoreTask",
    "mapCoreUncertainEffect",
    "mapCoreApprovel",
    "mapCoreMemoryDashboard",
    "mapCoreCapabilitySnapshot",
  ]) {
    assert.doesNotMatch(app, new RegExp(`function ${helper}\\(`));
    assert.match(appCoreMappers, new RegExp(`export function ${helper}\\(`));
  }
  assert.match(appCoreMappers, /function mapCoreChatEventParts/);
  assert.match(appCoreMappers, /function filterApprovelScopes/);
  assert.match(appCoreMappers, /function providerDisplayName/);
});

test("AppWorkspace delegates context budget display helpers to contextBudgetDisplay", () => {
  assert.match(appWorkspace, /from "\.\.\/lib\/contextBudgetDisplay";/);
  assert.doesNotMatch(app, /from "\.\/lib\/contextBudgetDisplay";/);
  assert.doesNotMatch(app, /function contextBudgetCompressionRatio\(/);
  assert.doesNotMatch(app, /function contextBudgetSummary\(/);
  assert.match(contextBudgetDisplay, /export function contextBudgetCompressionRatio/);
  assert.match(contextBudgetDisplay, /export function contextBudgetSummary/);
});

test("App delegates template workflow prompt routing to templateWorkflowPrompt", () => {
  assert.match(app, /from "\.\/lib\/useChatThreadCreation";/);
  assert.doesNotMatch(app, /from "\.\/lib\/templateWorkflowPrompt";/);
  assert.doesNotMatch(app, /const operativePrompt = \[/);
  assert.doesNotMatch(app, /const routingBinding: RoutingBindingInput =/);
  assert.doesNotMatch(app, /Do not generate the deck yet/);
  assert.match(chatThreadCreation, /buildTemplateWorkflowAutoSubmit/);
  assert.match(templateWorkflowPrompt, /export function buildTemplateWorkflowAutoSubmit/);
  assert.match(templateWorkflowPrompt, /presentations\.template_deck/);
  assert.match(templateWorkflowPrompt, /presentations\.template_document/);
});

test("App delegates optimistic chat message preservation to chatMessagePreservation", () => {
  assert.match(app, /from "\.\/lib\/useChatReadModelController";/);
  assert.doesNotMatch(app, /from "\.\/lib\/chatMessagePreservation";/);
  assert.doesNotMatch(app, /function hasPendingLocalMessages\(/);
  assert.doesNotMatch(app, /function shouldPreserveLocalMessages\(/);
  assert.match(chatReadModelController, /from "\.\/chatMessagePreservation";/);
  assert.match(chatReadModelController, /shouldPreserveLocalMessages/);
  assert.match(chatMessagePreservation, /export function hasPendingLocalMessages/);
  assert.match(chatMessagePreservation, /export function shouldPreserveLocalMessages/);
});

test("App delegates plugin navigation projection to appPluginNavigation", () => {
  assert.match(app, /from "\.\/lib\/usePluginHostController";/);
  assert.doesNotMatch(app, /from "\.\/lib\/appPluginNavigation";/);
  assert.doesNotMatch(app, /pluginRegistry\.filter\(/);
  assert.doesNotMatch(app, /\.\.\.enabledPlugins\.map\(/);
  assert.match(pluginHostController, /from "\.\/appPluginNavigation";/);
  assert.match(pluginHostController, /pluginRegistry/);
  assert.match(pluginHostController, /const pluginHost: PluginHost/);
  assert.match(appPluginNavigation, /export function enabledRegistryPlugins/);
  assert.match(appPluginNavigation, /export function composePluginNavItems/);
});

test("App delegates busy thread projection to busyThreadProjection", () => {
  assert.match(app, /from "\.\/lib\/busyThreadProjection";/);
  assert.doesNotMatch(app, /const ids = new Set<string>\(backgroundStreamIds\);/);
  assert.doesNotMatch(app, /task\.status === "running" \|\| task\.status === "queued"/);
  assert.match(busyThreadProjection, /export function projectBusyThreadIds/);
});

test("App delegates conversation attention overlay to conversationAttention", () => {
  assert.match(app, /useThreadAttentionController/);
  assert.doesNotMatch(app, /projectConversationAttention/);
  assert.doesNotMatch(app, /const attention: Record<string, ThreadAttentionStatus>/);
  assert.doesNotMatch(app, /attention\[threadId\] = "working"/);
  assert.match(threadAttentionController, /projectConversationAttention/);
  assert.match(conversationAttention, /export function projectConversationAttention/);
});

test("App delegates proactivity chat seeding to proactivityChatSeed", () => {
  assert.match(app, /from "\.\/lib\/useChatThreadCreation";/);
  assert.doesNotMatch(app, /from "\.\/lib\/proactivityChatSeed";/);
  assert.doesNotMatch(app, /scope === "__personal__"/);
  assert.doesNotMatch(app, /type: "choice_prompt"/);
  assert.match(chatThreadCreation, /buildProactivityChatSeed/);
  assert.match(proactivityChatSeed, /export function buildProactivityChatSeed/);
});

test("App does not retain retired selected task projection state", async () => {
  assert.doesNotMatch(app, /from "\.\/lib\/selectedTaskProjection";/);
  assert.doesNotMatch(app, /selectedTaskId/);
  assert.doesNotMatch(app, /selectedTask/);
  await assert.rejects(
    readFile(new URL("../src/lib/selectedTaskProjection.mjs", import.meta.url), "utf8"),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readFile(new URL("../src/lib/selectedTaskProjection.ts", import.meta.url), "utf8"),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readFile(new URL("../src/lib/selectedTaskProjection.test.mjs", import.meta.url), "utf8"),
    { code: "ENOENT" },
  );
});

test("App does not retain retired memory dashboard state", () => {
  assert.doesNotMatch(app, /memorySummary/);
  assert.doesNotMatch(app, /memoryDashboard/);
  assert.doesNotMatch(app, /setMemoryDashboard/);
  assert.doesNotMatch(app, /mapCoreMemoryDashboard/);
  assert.doesNotMatch(app, /coreBridge\.memoryDashboard/);
});

test("App delegates task queue snapshot projection to taskQueueProjection", () => {
  assert.match(app, /from "\.\/lib\/useTaskQueueController";/);
  assert.doesNotMatch(app, /useState<TaskItem/);
  assert.doesNotMatch(app, /useState<ApprovelItem/);
  assert.doesNotMatch(app, /setUncertainEffectItems/);
  assert.doesNotMatch(app, /coreBridge\.taskQueue/);
  assert.doesNotMatch(app, /coreBridge\.approveApprovel/);
  assert.doesNotMatch(app, /coreBridge\.rejectApprovel/);
  assert.doesNotMatch(app, /coreBridge\.resolveUncertainEffect/);
  assert.doesNotMatch(app, /projectTaskQueueSnapshot/);
  assert.match(taskQueueController, /from "\.\/taskQueueProjection";/);
  assert.match(taskQueueController, /coreBridge\.taskQueue/);
  assert.match(taskQueueProjection, /export function projectTaskQueueSnapshot/);
  assert.doesNotMatch(taskQueueController, /from "\.\.\/data\/mockData"/);
  assert.doesNotMatch(taskQueueController, /fallbackTasks/);
  assert.doesNotMatch(taskQueueProjection, /fallbackTasks/);
});

test("App delegates thread snapshot selection to threadSnapshotProjection", () => {
  assert.match(app, /from "\.\/lib\/useChatThreadMutations";/);
  assert.doesNotMatch(app, /from "\.\/lib\/threadSnapshotProjection";/);
  assert.doesNotMatch(app, /const preservedThread = mappedThreads\.find/);
  assert.match(chatThreadMutations, /projectThreadSnapshotSelection/);
  assert.match(threadSnapshotProjection, /export function projectThreadSnapshotSelection/);
});

test("App delegates initial thread selection to initialThreadSelection", () => {
  assert.match(app, /from "\.\/lib\/useInitialChatThreadsLoader";/);
  assert.doesNotMatch(app, /from "\.\/lib\/initialThreadSelection";/);
  assert.doesNotMatch(app, /mapped\.find\(\(thread\) => thread\.threadId === snapshot\.active_thread_id\)/);
  assert.match(initialChatThreadsLoader, /selectInitialThreadFromSnapshot/);
  assert.match(initialThreadSelection, /export function selectInitialThreadFromSnapshot/);
});

test("App delegates automation state and actions to useAutomationController", () => {
  assert.match(app, /from "\.\/lib\/useAutomationController";/);
  assert.doesNotMatch(app, /useState<ManagedAutomation/);
  assert.doesNotMatch(app, /coreBridge\.automations/);
  assert.doesNotMatch(app, /coreBridge\.createAutomation/);
  assert.doesNotMatch(app, /coreBridge\.updateAutomation/);
  assert.doesNotMatch(app, /coreBridge\.toggleAutomation/);
  assert.doesNotMatch(app, /coreBridge\.deleteAutomation/);
  assert.match(automationController, /export function useAutomationController/);
  assert.match(automationController, /coreBridge\.automations/);
});

test("App delegates capability state to useCapabilityController", () => {
  assert.match(app, /from "\.\/lib\/useCapabilityController";/);
  assert.doesNotMatch(app, /useState<ConnectionItem/);
  assert.doesNotMatch(app, /coreBridge\.capabilities/);
  assert.doesNotMatch(app, /mapCoreCapabilitySnapshot/);
  assert.match(capabilityController, /export function useCapabilityController/);
  assert.match(capabilityController, /coreBridge\.capabilities/);
  assert.match(capabilityController, /mapCoreCapabilitySnapshot/);
});

test("App delegates shell setup and plugin state to focused controllers", () => {
  assert.match(app, /from "\.\/lib\/useOnboardingSetupGate";/);
  assert.match(app, /from "\.\/lib\/usePluginController";/);
  assert.match(app, /from "\.\/lib\/useResponsiveDrawer";/);
  assert.doesNotMatch(app, /coreBridge\.setupStatus/);
  assert.doesNotMatch(app, /coreBridge\.plugins\(\)/);
  assert.doesNotMatch(app, /useState<PluginState/);
  assert.doesNotMatch(app, /function syncDrawerWithViewport/);
  assert.doesNotMatch(app, /window\.innerWidth > 1024/);
  assert.match(onboardingSetupGate, /coreBridge\.setupStatus/);
  assert.match(pluginController, /coreBridge\.plugins\(\)/);
  assert.match(responsiveDrawer, /window\.innerWidth > breakpoint/);
});

test("App delegates background stream polling to useBackgroundStreams", () => {
  assert.match(app, /from "\.\/lib\/useBackgroundStreams";/);
  assert.doesNotMatch(app, /coreBridge\.activeStreams/);
  assert.doesNotMatch(app, /setBackgroundStreamIds/);
  assert.match(backgroundStreams, /export function useBackgroundStreams/);
  assert.match(backgroundStreams, /\.activeStreams\(\)/);
});

test("App delegates shell navigation state to useAppNavigation", () => {
  assert.match(app, /from "\.\/lib\/useAppNavigation";/);
  assert.doesNotMatch(app, /useState<ViewId>/);
  assert.doesNotMatch(app, /useState<SettingsSectionId>/);
  assert.doesNotMatch(app, /setSearchOpen/);
  assert.doesNotMatch(app, /function handleNavigate/);
  assert.match(appNavigation, /export function useAppNavigation/);
  assert.match(appNavigation, /useState<ViewId>\("chat"\)/);
  assert.match(appNavigation, /useState<SettingsSectionId>\("account"\)/);
  assert.match(appNavigation, /function openUsageSettings/);
});

test("App delegates thread attention ownership to useThreadAttentionController", () => {
  assert.match(app, /from "\.\/lib\/useThreadAttentionController";/);
  assert.match(app, /from "\.\/lib\/useThreadAttentionNotifications";/);
  assert.doesNotMatch(app, /createThreadAttentionState/);
  assert.doesNotMatch(app, /hydrateThreadAttentionState/);
  assert.doesNotMatch(app, /mapCoreThreadAttention/);
  assert.doesNotMatch(app, /attentionRequiredThreadIds/);
  assert.doesNotMatch(app, /projectConversationAttention/);
  assert.doesNotMatch(app, /coreBridge\.markThreadSeen/);
  assert.doesNotMatch(app, /notifiedAttentionThreadIdsRef/);
  assert.doesNotMatch(app, /showSystemNotification/);
  assert.match(threadAttentionController, /export function useThreadAttentionController/);
  assert.match(threadAttentionController, /createThreadAttentionState/);
  assert.match(threadAttentionController, /hydrateThreadAttentionState/);
  assert.match(threadAttentionController, /coreBridge[\s\S]*?\.markThreadSeen/);
  assert.match(threadAttentionNotifications, /notificationPermission/);
  assert.match(threadAttentionNotifications, /showSystemNotification/);
});

test("App delegates chat read-model lifecycle to useChatReadModelController", () => {
  assert.match(app, /from "\.\/lib\/useChatReadModelController";/);
  assert.doesNotMatch(app, /coreBridge\.selectChatThread/);
  assert.doesNotMatch(app, /coreBridge\.chatThreads/);
  assert.doesNotMatch(app, /coreBridge\.chatMessages/);
  assert.doesNotMatch(app, /reconcileChatMessages/);
  assert.doesNotMatch(app, /reconcileChatThreads/);
  assert.doesNotMatch(app, /updateThreadPreview/);
  assert.match(chatReadModelController, /coreBridge\.selectChatThread/);
  assert.match(chatReadModelController, /reconcileChatMessages/);
  assert.match(chatReadModelController, /updateThreadPreview/);
  assert.match(chatReadModelController, /mapCoreChatMessage/);
});

test("App delegates operational read-model polling to useOperationalReadModelPoller", () => {
  assert.match(app, /from "\.\/lib\/useOperationalReadModelPoller";/);
  assert.doesNotMatch(app, /operational_read_models_poll unavailable/);
  assert.doesNotMatch(app, /window\.setInterval\(refreshOperationalReadModels, 2_500\)/);
  assert.match(operationalReadModelPoller, /export function useOperationalReadModelPoller/);
  assert.match(operationalReadModelPoller, /window\.setInterval\(refreshOperationalReadModels, 2_500\)/);
});

test("App delegates WebSocket app-event subscription to useAppEventSubscription", () => {
  assert.match(app, /from "\.\/lib\/useAppEventSubscription";/);
  assert.doesNotMatch(app, /wsSubscription/);
  assert.doesNotMatch(app, /appEventHandlerRef/);
  assert.doesNotMatch(app, /event\.type === "thread\.turn_started"/);
  assert.match(appEventSubscription, /export function useAppEventSubscription/);
  assert.match(appEventSubscription, /wsSubscription\.connect\(\)/);
  assert.match(appEventSubscription, /event\.type === "thread\.turn_started"/);
  assert.match(appEventSubscription, /refreshThreadInBackground\(eventThreadId, event\.workspace/);
});

test("App delegates workspace view rendering to AppWorkspace", () => {
  assert.match(app, /from "\.\/components\/AppWorkspace";/);
  assert.match(app, /<AppWorkspace/);
  assert.doesNotMatch(app, /<ChatView/);
  assert.doesNotMatch(app, /<AutomationsView/);
  assert.match(appWorkspace, /export function AppWorkspace/);
  assert.match(appWorkspace, /<ChatView/);
  assert.match(appWorkspace, /<AutomationsView/);
});

test("the sidebar uses the canonical persisted thread filter projection", () => {
  assert.match(sidebarFilterState, /homun\.sidebar\.threadFilter\.v2/);
  assert.match(sidebar, /readSidebarThreadFilter/);
  assert.match(sidebar, /writeSidebarThreadFilter/);
  assert.match(sidebar, /projectThreads/);
  assert.match(sidebar, /PERSONAL_WORKSPACE_ID/);
  assert.match(sidebar, /Date\.now\(\)/);
  assert.match(sidebar, /workspaceId:\s*thread\.workspace_id/);
  assert.doesNotMatch(sidebar, /\bthreadMatchesFilter\b/);
  assert.doesNotMatch(sidebar, /\brequiresAttention\b/);
  assert.doesNotMatch(`${sidebar}\n${sidebarFilters}`, /\battentionOnly\b/);
  assert.doesNotMatch(sidebarFilters, /filter\.(?:date|sources)\b/);
});

test("SidebarFilters is a compact hierarchical MenuSurface chain", () => {
  for (const token of [
    "ListFilter",
    "IconButton",
    "MenuSurface",
    'role="menuitemradio"',
    'role="menuitemcheckbox"',
    't("filters.clear")',
    'chainId="sidebar-filters"',
  ]) {
    assert.match(sidebarFilters, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const staleToken of [
    "SlidersHorizontal",
    "sidebar-filter-panel",
    "filter-chip",
    "filter-segments",
  ]) {
    assert.doesNotMatch(sidebarFilters, new RegExp(staleToken));
  }
  assert.match(sidebarFilters, /SIDEBAR_FILTER_ROOT_ROWS\.map/);
  assert.match(sidebarFilters, /toggleAttentionFilterStates/);
  assert.match(sidebarFilters, /sidebarFilterBadgeModel/);
  assert.match(sidebarFilters, /freshSidebarThreadFilter/);
});

test("sidebar styles load after shared menus and own sidebar selectors", () => {
  assert.match(main, /import "\.\/styles\/menus\.css";\s*import "\.\/styles\/sidebar\.css";/);
  const cssSelectors = (css) => new Set(
    Array.from(css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g))
      .flatMap((match) => match[1].trim().startsWith("@") ? [] : match[1].split(","))
      .map((selector) => selector.trim()),
  );
  const cssClasses = (selectors) => new Set(
    [...selectors].flatMap((selector) => selector.match(/\.[A-Za-z_][\w-]*/g) ?? []),
  );
  const sidebarClasses = cssClasses(cssSelectors(sidebarStyles));
  const legacySelectors = cssSelectors(legacyStyles);
  const legacyClasses = cssClasses(legacySelectors);
  const ownedFamilies = [
    { label: "nav drawer", matches: (name) => name === ".nav-drawer" },
    {
      label: "navigation rail",
      matches: (name) => name === ".navigation-rail" || name.startsWith(".rail-"),
    },
    { label: "settings drawer", matches: (name) => name === ".settings-drawer" },
    { label: "settings navigation", matches: (name) => name.startsWith(".set-nav-") },
    { label: "settings subnavigation", matches: (name) => name.startsWith(".set-subnav-") },
    { label: "drawer resizer", matches: (name) => name === ".drawer-resizer" },
    ...[
      "titlebar",
      "topbar",
      "nav",
      "scroll",
      "footer",
      "profile",
      "thread",
      "project",
      "chats",
      "section",
      "row",
      "eyebrow",
    ].map((family) => ({
      label: `drawer ${family}`,
      matches: (name) => name.startsWith(`.drawer-${family}`),
    })),
    { label: "sidebar filters", matches: (name) => name.startsWith(".sidebar-filter") },
    { label: "thread status", matches: (name) => name === ".thread-status-dot" },
  ];
  for (const family of ownedFamilies) {
    const owned = [...sidebarClasses].filter(family.matches);
    assert.ok(owned.length > 0, `${family.label} selectors must exist in sidebar.css`);
    assert.deepEqual(
      [...legacyClasses].filter(family.matches),
      [],
      `${family.label} selectors must not remain in styles.css`,
    );
  }

  // These selectors coordinate sidebar state with global workspace chrome and intentionally stay.
  const legacySidebarAllowlist = [
    ".app-shell.drawer-closed .cc-dock.full",
    ".app-shell.drawer-closed .task-topbar",
    ".app-shell.drawer-closed::before",
    ".app-shell.drawer-open::before",
  ];
  assert.deepEqual(
    [...legacySelectors]
      .filter((selector) => selector.includes(".drawer-open") || selector.includes(".drawer-closed"))
      .sort(),
    legacySidebarAllowlist,
  );
  const retiredFilters = /filter-chip|filter-segments|sidebar-filter-panel|drawer-filter-bar/;
  assert.doesNotMatch(sidebarStyles, retiredFilters);
  assert.doesNotMatch(legacyStyles, retiredFilters);
});

test("the transcript uses the flat role and operational message grammar", () => {
  const transcriptMarkup = `${chatTranscript}\n${chatMessageRow}\n${assistantMessageBody}\n${messageActionFooter}`;
  for (const className of [
    "chat-message-agent",
    "chat-message-user-band",
    "chat-message-meta",
    "chat-message-actions-slot",
    "chat-operational-row",
  ]) {
    assert.match(transcriptMarkup, new RegExp(`\\b${className}\\b`));
  }
  assert.match(assistantMessageBody, /<details\s+className="chat-operational-row"/);
  assert.match(assistantMessageBody, /<summary>/);
  assert.doesNotMatch(chatView, /message-bubble\s+user|user\s+message-bubble/);
  assert.doesNotMatch(chatView, /"message\s+(?:user|assistant|system)\b/);
});

test("chat.css exclusively owns the migrated transcript grammar", () => {
  for (const selector of [
    ".thread-content",
    ".thread-message-list",
    ".thread-message-row",
    ".chat-message-agent",
    ".chat-message-user-band",
    ".chat-message-meta",
    ".chat-message-actions-slot",
    ".chat-operational-row",
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(chatStyles, new RegExp(escaped));
    assert.doesNotMatch(
      legacyStyles,
      new RegExp(`(?:^|[},])\\s*${escaped}\\s*(?=[,{])`, "m"),
    );
  }
  assert.match(
    main,
    /import "\.\/styles\/foundation\.css";\s*import "\.\/styles\/menus\.css";\s*import "\.\/styles\/sidebar\.css";\s*import "\.\/styles\/chat\.css";/,
  );
});

test("runtime context is fetched through the scoped thread endpoint", () => {
  assert.match(chatApi, /runtimeContext\(threadId:\s*string\)/);
  assert.match(chatApi, /threads\/\$\{encodeURIComponent\(threadId\)\}\/runtime-context/);
  assert.match(coreBridge, /runtimeContext:\s*\(threadId:\s*string\)/);
});

test("runtime context refresh follows the durable terminal cursor", () => {
  assert.match(
    app,
    /runtimeContextRevision=\{\s*threadAttention\.terminalEventIds\[activeThread\.threadId\]\s*\?\?\s*0\s*\}/,
  );
  assert.match(chatViewTypes, /runtimeContextRevision:\s*number/);
  assert.match(chatView, /useRuntimeContext\(\{\s*threadId:\s*thread\.threadId,\s*runtimeContextRevision/);
  assert.match(runtimeContextHook, /export function useRuntimeContext/);
  assert.match(runtimeContextHook, /const refreshRuntimeContext = useCallback/);
  assert.match(runtimeContextHook, /\[refreshRuntimeContext,\s*runtimeContextRevision\]/);
  assert.match(runtimeContextHook, /runtimeContextRequestRef/);
  assert.doesNotMatch(chatView, /runtimeContextRequestRef/);
  assert.doesNotMatch(chatView, /setRuntimeContextLoading/);
  assert.doesNotMatch(chatView, /runtimeContextRefreshKey/);
});

test("runtime context refreshes when the composer dialog is opened", () => {
  assert.match(chatView, /onRefreshRuntimeContext=\{refreshRuntimeContext\}/);
  assert.match(composerShell, /onRefreshRuntimeContext:\s*\(\)\s*=>\s*void\s*\|\s*Promise<void>/);
  assert.match(
    composerShell,
    /id="composer-runtime-trigger"[\s\S]*?onClick=\{\(\)\s*=>\s*\{[\s\S]*?props\.onRefreshRuntimeContext\(\);[\s\S]*?openRoot\("runtime"\)/,
  );
});

test("composer runtime uses the exclusive dialog chain and renders factual context inline", () => {
  assert.match(composerShell, /rootOpen\("runtime"\)/);
  assert.match(composerShell, /<RuntimeContextPanel/);
  assert.doesNotMatch(composerShell, /homun:open-runtime-context/);
  assert.match(composerShell, /id="composer-runtime-trigger"[\s\S]*?aria-haspopup="dialog"/);
  assert.match(composerShell, /id="composer-runtime-menu"[\s\S]*?surfaceRole="dialog"/);
  assert.match(menuSurface, /surfaceRole\?:\s*"menu"\s*\|\s*"dialog"/);
  assert.match(menuSurface, /role=\{surfaceRole\}/);
});

test("runtime panel exposes only approved redacted categories", () => {
  for (const field of [
    "effectiveModel",
    "selectedNextModel",
    "provider",
    "locality",
    "role",
    "contextWindow",
    "usedTokens",
    "percent",
    "contributions",
    "compacted",
  ]) {
    assert.match(runtimeContextPanel, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(
    runtimeContextPanel,
    /value\.(?:prompt|path|memoryContent|price|hash|baseUrl)|base_url/i,
  );
  assert.match(runtimeContextPanel, /composer\.runtime\.nextTurnModel/);
  assert.match(runtimeContextPanel, /value\.selectedNextModel\s*\?\?/);
  assert.match(runtimeContextPanel, /<section[\s\S]*?aria-labelledby=/);
  assert.match(runtimeContextPanel, /className="composer-runtime-usage-bar"[\s\S]*?role="progressbar"/);
  assert.match(runtimeContextPanel, /composer-runtime-contributions/);
  assert.match(runtimeContextPanel, /composer-runtime-segment--/);
  assert.match(composerStyles, /\.composer-runtime-usage-bar\s*\{[\s\S]*?height:\s*6px;/);
  assert.match(composerStyles, /\.composer-runtime-swatch--conversation/);
});

test("the adaptive workspace island replaces every persistent status owner", () => {
  assert.match(chatView, /from "\.\/ChatWorkspaceDock";/);
  assert.match(chatView, /<ChatWorkspaceDock[\s\S]*sections=\{workspaceSections\}/);
  assert.doesNotMatch(chatView, /<AdaptiveWorkspaceIsland/);
  assert.match(chatWorkspaceDock, /<AdaptiveWorkspaceIsland/);
  assert.match(chatView, /projectWorkspaceSections/);
  assert.match(adaptiveWorkspaceIsland, /useState<WorkspaceSectionId\s*\|\s*null>\(null\)/);
  assert.match(adaptiveWorkspaceIsland, /role="region"/);
  assert.match(workspaceIslandStyles, /\.workspace-island-rail/);
  assert.doesNotMatch(
    chatView,
    /from "\.\/WorkspaceIsland"|<WorkspaceIsland\b|chat-status-stack|islandOpen/,
  );
  assert.doesNotMatch(
    legacyStyles,
    /\.chat-status-stack|\.unified-status-panel|\.workspace-island-pill|\.workspace-island-panel|--island-reserve/,
  );
});

test("phase one has one visual owner and no retired runtime surface", async () => {
  const styleOwners = [
    foundation,
    menus,
    sidebarStyles,
    chatStyles,
    composerStyles,
    workspaceIslandStyles,
    legacyStyles,
  ];
  for (const selector of [
    ".menu-surface",
    ".sidebar-filters",
    ".chat-message-user-band",
    ".composer-surface",
    ".workspace-island-rail",
  ]) {
    assert.equal(
      styleOwners.filter((styles) => styles.replace(/\/\*[\s\S]*?\*\//g, "").includes(selector)).length,
      1,
      `${selector} must occur in exactly one style module`,
    );
  }

  assert.doesNotMatch(packageManifest, /@fontsource\/hanken-grotesk/);
  assert.doesNotMatch(
    `${chatView}\n${sidebar}\n${sidebarFilters}\n${composerShell}\n${legacyStyles}`,
    /composer-pop|sidebar-filter-panel|filter-chip|filter-segments|chat-status-stack|unified-status-panel|workspace-island-pill|addMenuOpen|fileMenuOpen|skillMenuOpen|modelMenuOpen/,
  );
  await assert.rejects(
    readFile(new URL("../src/components/ProjectContextPanel.tsx", import.meta.url), "utf8"),
    { code: "ENOENT" },
  );
});

test("phase one transient controls keep named anchors and escape ownership", () => {
  assert.match(menuSurface, /getMenuKeyboardAction\(event\.key/);
  assert.match(menuSurface, /action\.type === "none"[\s\S]*?onCloseCurrent\(\)/);
  assert.match(menuSurface, /anchorRef\.current\?\.focus/);
  for (const source of [sidebarFilters, composerShell]) {
    const surfaces = source.match(/<MenuSurface[\s\S]*?(?:\/>|<\/MenuSurface>)/g) ?? [];
    assert.ok(surfaces.length > 0);
    for (const surface of surfaces) {
      assert.match(surface, /\bid=(?:"[^"]+"|\{[^}]+\})/);
      assert.match(surface, /\blabel=\{/);
      assert.match(surface, /\banchorRef=\{/);
      assert.match(surface, /\bonCloseCurrent=\{/);
    }
  }
});

test("legacy CSS cannot recreate message, activity, or generated-file surfaces", () => {
  const selectors = new Set(
    Array.from(legacyStyles.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g))
      .flatMap((match) => match[1].trim().startsWith("@") ? [] : match[1].split(","))
      .map((selector) => selector.trim()),
  );
  const migratedMessageSelectors = new Set([
    ".message",
    ".message.user",
    ".message.user > p",
    ".message.user > .rich-message",
    ".message.assistant",
    ".message.system",
    ".message.assistant p",
    ".message.system p",
    ".message.assistant .rich-message",
    ".message.system .rich-message",
    ".message.pending p",
    ".message footer",
  ]);
  const duplicateSurfaces = [...selectors].filter((selector) => (
    migratedMessageSelectors.has(selector)
    || selector.startsWith(".message.user > .rich-message ")
    || selector.startsWith(".message.user ")
    || selector.startsWith(".message.assistant")
    || selector.startsWith(".message.system")
    || selector.startsWith(".msg-activity")
    || selector === ".msg-artifacts"
  ));

  assert.deepEqual(duplicateSurfaces, []);
  assert.doesNotMatch(legacyStyles, /@keyframes\s+(?:message-in|msg-activity-pulse)\b/);
  assert.doesNotMatch(
    legacyStyles,
    /\.message\.user\s*>\s*(?:p|\.rich-message)\s*\{[\s\S]*?(?:border-radius:\s*18px|padding:\s*12px 16px|background:\s*var\(--surface-muted\))/,
  );

  for (const selector of [
    ".message",
    ".chat-message-agent",
    ".chat-message-user-band",
    ".chat-message-system",
    ".message.pending p",
    ".chat-message-meta",
    ".msg-activity",
    ".msg-artifacts",
  ]) {
    assert.match(chatStyles, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(chatStyles, /@keyframes\s+message-in\b/);
  assert.match(chatStyles, /@keyframes\s+msg-activity-pulse\b/);
  assert.match(
    chatStyles,
    /\.chat-message-user-band\s*\{[\s\S]*?width:\s*fit-content;[\s\S]*?margin-left:\s*auto;[\s\S]*?align-self:\s*flex-end;/,
  );
  assert.match(
    chatStyles,
    /\.chat-message-agent,[\s\S]*?\.chat-message-system\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/,
  );
});

test("sent user messages stay right aligned without a bubble frame", () => {
  const userBand = cssBlock(chatStyles, ".chat-message-user-band");
  assert.match(userBand, /margin-left:\s*auto;/);
  assert.match(userBand, /align-self:\s*flex-end;/);
  assert.match(userBand, /border:\s*0;/);
  assert.match(userBand, /background:\s*transparent;/);
  assert.doesNotMatch(userBand, /background:\s*color-mix|border:\s*1px solid/);
});

test("message edit prompt keeps a usable multiline geometry", () => {
  const editShell = cssBlock(chatStyles, ".message-edit");
  const editTextarea = cssBlock(chatStyles, ".message-edit textarea");
  assert.match(editShell, /width:\s*min\(620px,\s*100%\);/);
  assert.match(editTextarea, /min-width:\s*min\(420px,\s*100%\);/);
  assert.match(editTextarea, /min-height:\s*96px;/);
  assert.doesNotMatch(legacyStyles, /\.message-edit(?:\s|\{|:)/);
});

test("ChatView delegates its public types to ChatViewTypes", () => {
  assert.match(chatView, /from "\.\/ChatViewTypes";/);
  assert.doesNotMatch(chatView, /interface ChatViewProps/);
  assert.doesNotMatch(chatView, /interface ChatAutoSubmit/);
  assert.match(chatViewTypes, /export interface ChatViewProps/);
  assert.match(chatViewTypes, /export interface ChatAutoSubmit/);
  assert.match(chatViewTypes, /autoSubmit\?: ChatAutoSubmit \| null/);
});

test("ChatView delegates the prompt surface to the thin ComposerShell boundary", () => {
  assert.match(
    composerContainer || chatView,
    /import\s+\{[^}]*\bComposerShell\b[^}]*\}\s+from\s+"\.\/ComposerShell"/s,
  );
  assert.match(composerContainer || chatView, /<ComposerShell\b/);
  assert.doesNotMatch(
    chatView,
    /\b(?:addMenuOpen|fileMenuOpen|skillMenuOpen|modelMenuOpen)\b/,
  );
  assert.doesNotMatch(chatView, /composer-pop/);

  for (const token of [
    "layeredMenuState",
    "MenuSurface",
    "IconButton",
    "composer-metadata-row",
    'chainId="composer"',
  ]) {
    assert.match(composerShell, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const label of ["add", "model", "mode", "environment", "runtimeContext"]) {
    assert.match(composerShell, new RegExp(`composer\\.${label}`));
  }
  for (const layer of ["add", "model", "mode", "runtime", "files", "capabilities", "connectors", "models"]) {
    assert.match(composerShell, new RegExp(`[\"']${layer}[\"']`));
  }
});

test("ChatView delegates composer state and submit ownership to ComposerContainer", () => {
  assert.match(chatComposerDock, /import \{ ComposerContainer/);
  assert.match(chatComposerDock, /<ComposerContainer[\s\S]*?onSubmit=\{onSubmit\}/);
  assert.doesNotMatch(chatView, /function Composer\(/);
  assert.doesNotMatch(chatView, /const \[selectedModel,\s*setSelectedModel\]/);
  assert.doesNotMatch(chatView, /const \[attachments,\s*setAttachments\]/);
  assert.match(composerContainer, /export function ComposerContainer/);
  assert.match(composerContainer, /<ComposerShell/);
  assert.match(composerContainer, /selectedModelAfterSubmission/);
  assert.match(composerContainer, /coreBridge\.runtimeModels/);
});

test("ChatView delegates the composer dock surface to ChatComposerDock", () => {
  assert.match(chatView, /import \{ ChatComposerDock[\s\S]*?from "\.\/ChatComposerDock";/);
  assert.match(chatView, /<ChatComposerDock[\s\S]*?onSubmit=\{submitComposerPrompt\}/);
  assert.doesNotMatch(chatView, /<ActiveTurnStatus/);
  assert.doesNotMatch(chatView, /<PendingSteeringQueue/);
  assert.doesNotMatch(chatView, /<ComposerContainer/);
  assert.match(chatComposerDock, /export function ChatComposerDock/);
  assert.match(chatComposerDock, /<ActiveTurnStatus/);
  assert.match(chatComposerDock, /<PendingSteeringQueue/);
  assert.match(chatComposerDock, /<ComposerContainer/);
});

test("InspectorView delegates local computer inspector rendering to ComputerDetailPanel", () => {
  assert.doesNotMatch(chatView, /import \{ ComputerDetailPanel \} from "\.\/ComputerDetailPanel";/);
  assert.match(inspectorView, /import \{ ComputerDetailPanel \} from "\.\/ComputerDetailPanel";/);
  assert.match(inspectorView, /<ComputerDetailPanel[\s\S]*?session=\{computerSession\}/);
  assert.doesNotMatch(chatView, /function ComputerDetailPanel\(/);
  assert.match(computerDetailPanel, /export function ComputerDetailPanel/);
  assert.match(computerDetailPanel, /className="computer-detail-panel"/);
  assert.match(computerDetailPanel, /onSelectSurface\(surface\.id\)/);
  assert.match(computerDetailPanel, /onClick=\{paused \? onResume : onPause\}/);
});

test("ChatView delegates empty-thread hero rendering to ChatEmptyHero", () => {
  assert.doesNotMatch(chatView, /import \{ ChatEmptyHero \} from "\.\/ChatEmptyHero";/);
  assert.match(chatTranscript, /import \{ ChatEmptyHero \} from "\.\/ChatEmptyHero";/);
  assert.match(chatTranscript, /<ChatEmptyHero[\s\S]*?sessionSeed=\{sessionSeed\}/);
  assert.doesNotMatch(chatView, /function ChatEmptyHero\(/);
  assert.match(chatEmptyHero, /export function ChatEmptyHero/);
  assert.match(chatEmptyHero, /selectGreetingKey/);
  assert.match(chatEmptyHero, /<ChatUsageOverview/);
  assert.match(chatEmptyHero, /chat-hero-headline/);
  assert.match(chatEmptyHero, /chat-hero-prompt/);
});

test("ChatView delegates the chat topbar to ChatTopbar", () => {
  assert.match(chatView, /from "\.\/ChatTopbar";/);
  assert.match(chatView, /<ChatTopbar/);
  assert.doesNotMatch(chatView, /<header className="task-topbar"/);
  assert.doesNotMatch(chatView, /task-collapsed-controls/);
  assert.match(chatTopbar, /export function ChatTopbar/);
  assert.match(chatTopbar, /<header className="task-topbar"/);
  assert.match(chatTopbar, /<ChatHeaderMenu/);
});

test("ChatView does not keep the retired unused inline computer timeline component", () => {
  assert.doesNotMatch(chatView, /function InlineTimeline\(/);
});

test("ChatView delegates message attachment rendering to MessageAttachmentList", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageAttachmentList";/);
  assert.match(chatMessageAfterContent, /from "\.\/MessageAttachmentList";/);
  assert.match(chatMessageAfterContent, /<MessageAttachmentList attachments=\{message\.attachments\}/);
  assert.doesNotMatch(chatView, /function MessageAttachmentList\(/);
  assert.match(messageAttachmentList, /export function MessageAttachmentList/);
  assert.match(messageAttachmentList, /message-image-attachment/);
  assert.match(messageAttachmentList, /message-attachment-chip/);
  assert.match(messageAttachmentList, /formatFileSize\(attachment\.sizeBytes\)/);
});

test("ChatView delegates message action footer rendering to MessageActionFooter", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageActionFooter";/);
  assert.match(chatMessageAfterContent, /from "\.\/MessageActionFooter";/);
  assert.match(chatMessageAfterContent, /<MessageActionFooter[\s\S]*?onSaveAsGoal=\{onSaveAsGoal\}/);
  assert.doesNotMatch(chatView, /from "\.\/MessageActionBar";/);
  assert.doesNotMatch(chatView, /<MessageActionBar/);
  assert.doesNotMatch(chatView, /className="chat-message-actions-slot"/);
  assert.doesNotMatch(chatView, /function MessageActionBar\(/);
  assert.doesNotMatch(chatView, /resolveMessageActionMenuPlacement/);
  assert.match(messageActionFooter, /export function MessageActionFooter/);
  assert.match(messageActionFooter, /<MessageActionBar/);
  assert.match(messageActionFooter, /messageContentKind\(message\)/);
  assert.match(messageActionFooter, /onSaveAsGoal=\{\(\) => onSaveAsGoal\(message\.text\)\}/);
  assert.match(messageActionBar, /export function MessageActionBar/);
  assert.match(messageActionBar, /message-action-menu-feedback/);
  assert.match(messageActionBar, /message-latency-summary/);
  assert.match(messageActionBar, /resolveMessageActionMenuPlacement/);
});

test("ChatView delegates branch variant controls to ChatBranchPicker", () => {
  assert.doesNotMatch(chatView, /from "\.\/ChatBranchPicker";/);
  assert.match(chatMessageAfterContent, /from "\.\/ChatBranchPicker";/);
  assert.match(chatMessageAfterContent, /<ChatBranchPicker/);
  assert.doesNotMatch(chatView, /className="branch-picker"/);
  assert.doesNotMatch(chatView, /branch-rename/);
  assert.match(chatBranchPicker, /export function ChatBranchPicker/);
  assert.match(chatBranchPicker, /className="branch-picker"/);
  assert.match(chatBranchPicker, /branch-rename/);
});

test("ChatView delegates follow-up suggestion rendering to ChatFollowUps", () => {
  assert.doesNotMatch(chatView, /from "\.\/ChatFollowUps";/);
  assert.match(chatMessageAfterContent, /from "\.\/ChatFollowUps";/);
  assert.match(chatMessageAfterContent, /<ChatFollowUps/);
  assert.doesNotMatch(chatView, /className="chat-followups"/);
  assert.match(chatFollowUps, /export function ChatFollowUps/);
  assert.match(chatFollowUps, /className="chat-followups"/);
  assert.match(chatFollowUps, /chat\.followUpQuestions/);
});

test("ChatView delegates inline message editing to MessageEditBox", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageEditBox";/);
  assert.doesNotMatch(chatView, /<MessageEditBox/);
  assert.match(chatMessageContent, /from "\.\/MessageEditBox";/);
  assert.match(chatMessageContent, /<MessageEditBox/);
  assert.doesNotMatch(chatView, /className="message-edit"/);
  assert.doesNotMatch(chatView, /message-edit-actions/);
  assert.match(messageEditBox, /export function MessageEditBox/);
  assert.match(messageEditBox, /className="message-edit"/);
  assert.match(messageEditBox, /event\.key === "Enter" && \(event\.metaKey \|\| event\.ctrlKey\)/);
  assert.match(messageEditBox, /event\.key === "Escape"/);
});

test("ChatView delegates message metadata copy to MessageMetaCopy", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageMetaCopy";/);
  assert.doesNotMatch(chatView, /<MessageMetaCopy/);
  assert.doesNotMatch(chatView, /className="chat-message-meta-copy"/);
  assert.doesNotMatch(chatView, /MemoryUsagePopover/);
  assert.doesNotMatch(chatView, /formatChatDuration/);
  assert.match(messageActionFooter, /from "\.\/MessageMetaCopy";/);
  assert.match(messageActionFooter, /<MessageMetaCopy/);
  assert.match(messageActionFooter, /onMemoryPublicationApproved=\{onMemoryPublicationApproved\}/);
  assert.match(messageMetaCopy, /export function MessageMetaCopy/);
  assert.match(messageMetaCopy, /className="chat-message-meta-copy"/);
  assert.match(messageMetaCopy, /MemoryUsagePopover/);
  assert.match(messageMetaCopy, /formatChatDuration/);
  assert.match(messageMetaCopy, /visibleMessageMetadata/);
});

test("ChatView delegates post-message status badges to MessageStatusBadges", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageStatusBadges";/);
  assert.match(chatMessageAfterContent, /from "\.\/MessageStatusBadges";/);
  assert.match(chatMessageAfterContent, /<MessageStatusBadges/);
  assert.doesNotMatch(chatView, /className="message-incomplete-note"/);
  assert.doesNotMatch(chatView, /className="auto-continue-status"/);
  assert.match(messageStatusBadges, /export function MessageStatusBadges/);
  assert.match(messageStatusBadges, /className="message-incomplete-note"/);
  assert.match(messageStatusBadges, /className="auto-continue-status"/);
  assert.match(messageStatusBadges, /chat\.responseLikelyInterrupted/);
  assert.match(messageStatusBadges, /chat\.autoCompleting/);
});

test("ChatView delegates system message headers to ChatSystemMessageHeader", () => {
  assert.doesNotMatch(chatView, /from "\.\/ChatSystemMessageHeader";/);
  assert.match(chatMessageRow, /from "\.\/ChatSystemMessageHeader";/);
  assert.match(chatMessageRow, /<ChatSystemMessageHeader/);
  assert.doesNotMatch(chatView, /className="assistant-label system-label"/);
  assert.doesNotMatch(chatView, /Clock3/);
  assert.match(chatSystemMessageHeader, /export function ChatSystemMessageHeader/);
  assert.match(chatSystemMessageHeader, /className="assistant-label system-label"/);
  assert.match(chatSystemMessageHeader, /Clock3/);
  assert.match(chatSystemMessageHeader, /chat\.roleSystem/);
});

test("ChatView delegates pending assistant rendering to PendingAssistantMessage", () => {
  assert.doesNotMatch(chatView, /from "\.\/PendingAssistantMessage";/);
  assert.doesNotMatch(chatView, /<PendingAssistantMessage/);
  assert.match(chatTranscript, /from "\.\/PendingAssistantMessage";/);
  assert.match(chatTranscript, /<PendingAssistantMessage/);
  assert.doesNotMatch(chatView, /className="message chat-message-agent pending"/);
  assert.doesNotMatch(chatView, /Sparkles/);
  assert.match(pendingAssistantMessage, /export function PendingAssistantMessage/);
  assert.match(pendingAssistantMessage, /className="message chat-message-agent pending"/);
  assert.match(pendingAssistantMessage, /AssistantThinkingState/);
  assert.match(pendingAssistantMessage, /chat\.roleAssistant/);
});

test("ChatView delegates message activity rendering to MessageActivity", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageActivity";/);
  assert.match(chatMessageContent, /from "\.\/MessageActivity";/);
  assert.match(chatMessageContent, /<MessageActivity text=\{message\.text\} live=\{false\}/);
  assert.doesNotMatch(chatView, /function MessageActivity\(/);
  assert.doesNotMatch(chatView, /function parseActivitySteps\(/);
  assert.match(chatPayloadParsers, /import \{ parseActivitySteps \} from "\.\/MessageActivity";/);
  assert.match(messageActivity, /export function MessageActivity/);
  assert.match(messageActivity, /export function parseActivitySteps/);
  assert.match(messageActivity, /msg-activity-steps/);
  assert.match(messageActivity, /ACTIVITY_RE/);
});

test("ChatView delegates assistant thinking rendering to AssistantThinkingState", () => {
  assert.match(useChatTurnStateMachine, /import type \{ ChatStreamStatus \} from "\.\/AssistantThinkingState";/);
  assert.doesNotMatch(chatView, /<AssistantThinkingState/);
  assert.match(chatMessageContent, /from "\.\/AssistantThinkingState";/);
  assert.match(chatMessageContent, /<AssistantThinkingState status=\{streamStatus\}/);
  assert.doesNotMatch(chatView, /function AssistantThinkingState\(/);
  assert.doesNotMatch(chatView, /interface ChatStreamStatus/);
  assert.match(assistantThinkingState, /export interface ChatStreamStatus/);
  assert.match(assistantThinkingState, /export function AssistantThinkingState/);
  assert.match(assistantThinkingState, /assistant-thinking-state/);
  assert.match(assistantThinkingState, /thinking-elapsed/);
});

test("ChatView delegates generated artifact rendering to MessageArtifacts", () => {
  assert.match(assistantMessageBody, /from "\.\/MessageArtifacts";/);
  assert.match(assistantMessageBody, /<MessageArtifacts text=\{text\} onOpen=\{onOpenArtifact\}/);
  assert.doesNotMatch(chatView, /function MessageArtifacts\(/);
  assert.doesNotMatch(chatView, /function ArtifactCardRow\(/);
  assert.doesNotMatch(chatView, /function InlineArtifactPreview\(/);
  assert.doesNotMatch(chatView, /function parseArtifacts\(/);
  assert.match(messageArtifacts, /export function MessageArtifacts/);
  assert.match(messageArtifacts, /export function ArtifactsList/);
  assert.match(messageArtifacts, /export function ArtifactPreviewBody/);
  assert.match(messageArtifacts, /export function parseArtifacts/);
  assert.match(messageArtifacts, /export async function buildArtifactPreview/);
  assert.match(messageArtifacts, /export async function triggerArtifactDownload/);
  assert.match(messageArtifacts, /msg-artifacts/);
});

test("ChatView delegates workspace artifact and source projections to ChatWorkspaceProjections", () => {
  assert.match(chatView, /from "\.\/ChatWorkspaceProjections";/);
  assert.match(chatView, /buildConversationArtifacts\(messages\)/);
  assert.match(chatView, /buildWorkbenchArtifacts\(/);
  assert.match(chatView, /buildUploadedFiles\(messages\)/);
  assert.match(chatView, /buildIslandSources\(/);
  assert.doesNotMatch(chatView, /artifactProjection/);
  assert.doesNotMatch(chatView, /projectMemoryArtifact/);
  assert.doesNotMatch(chatView, /ARTIFACT_IMAGE_EXT\.includes/);
  assert.doesNotMatch(chatView, /file\.kind === "image"/);
  assert.match(chatWorkspaceProjections, /export function buildConversationArtifacts/);
  assert.match(chatWorkspaceProjections, /export function buildWorkbenchArtifacts/);
  assert.match(chatWorkspaceProjections, /export function buildUploadedFiles/);
  assert.match(chatWorkspaceProjections, /export function buildIslandSources/);
  assert.match(chatWorkspaceProjections, /from "\.\.\/lib\/artifactProjection";/);
  assert.doesNotMatch(chatWorkspaceProjections, /import \* as artifactProjection/);
  assert.match(chatWorkspaceProjections, /projectMemoryArtifact/);
});

test("InspectorView delegates the artifacts workbench panel to ArtifactsPanel", () => {
  assert.match(chatView, /from "\.\/InspectorView";/);
  assert.doesNotMatch(chatView, /from "\.\/ArtifactsPanel";/);
  assert.match(inspectorView, /from "\.\/ArtifactsPanel";/);
  assert.match(inspectorView, /<ArtifactsPanel[\s\S]*artifacts=\{\[resourceArtifact\]\}/);
  assert.doesNotMatch(chatView, /function ArtifactsPanel\(/);
  assert.doesNotMatch(chatView, /function applyPreview\(/);
  assert.match(artifactsPanel, /export function ArtifactsPanel/);
  assert.match(artifactsPanel, /<ArtifactPreviewBody[\s\S]*?preview=\{preview\}/);
  assert.match(artifactsPanel, /coreBridge\.artifactVersions/);
  assert.match(artifactsPanel, /diffStats/);
  assert.match(artifactsPanel, /triggerArtifactDownload/);
});

test("InspectorView delegates the goals workbench panel to GoalsPanel", () => {
  assert.match(chatView, /from "\.\/InspectorView";/);
  assert.doesNotMatch(chatView, /from "\.\/GoalsPanel";/);
  assert.match(inspectorView, /from "\.\/GoalsPanel";/);
  assert.match(inspectorView, /<GoalsPanel[\s\S]*data=\{goalsData\}/);
  assert.doesNotMatch(chatView, /function GoalsPanel\(/);
  assert.doesNotMatch(chatView, /function normalizeGoalText\(/);
  assert.doesNotMatch(chatView, /function dedupeGoalDrafts\(/);
  assert.match(goalsPanel, /export function GoalsPanel/);
  assert.match(goalsPanel, /function normalizeGoalText/);
  assert.match(goalsPanel, /function dedupeGoalDrafts/);
  assert.match(goalsPanel, /coreBridge\.addGoal/);
  assert.match(goalsPanel, /coreBridge\.promoteGoals/);
});

test("InspectorView delegates memory graph rendering to MemoryGraphPanel", () => {
  assert.match(chatView, /from "\.\/InspectorView";/);
  assert.doesNotMatch(chatView, /from "\.\/MemoryGraphPanel";/);
  assert.match(inspectorView, /from "\.\/MemoryGraphPanel";/);
  assert.match(inspectorView, /<MemoryGraphPanel threadId=\{threadId\} layoutSignal=\{layoutSignal\}/);
  assert.doesNotMatch(chatView, /function MemoryGraphPanel\(/);
  assert.doesNotMatch(chatView, /react-force-graph-2d/);
  assert.doesNotMatch(chatView, /const GRAPH_KIND_STYLE/);
  assert.match(memoryGraphPanel, /export function MemoryGraphPanel/);
  assert.match(memoryGraphPanel, /react-force-graph-2d/);
  assert.match(memoryGraphPanel, /const GRAPH_KIND_STYLE/);
  assert.match(memoryGraphPanel, /resizeFitTimer/);
  assert.match(memoryView, /from "\.\/MemoryGraphPanel";/);
  assert.doesNotMatch(memoryView, /from "\.\/ChatView";/);
});

test("ChatView delegates inspector body rendering to InspectorView", () => {
  assert.match(chatView, /from "\.\/ChatInspectorDock";/);
  assert.match(chatView, /<ChatInspectorDock[\s\S]*state=\{inspector\}/);
  assert.doesNotMatch(chatView, /<InspectorWorkspace/);
  assert.doesNotMatch(chatView, /<InspectorView/);
  assert.match(chatInspectorDock, /from "\.\/InspectorWorkspace";/);
  assert.match(chatInspectorDock, /from "\.\/InspectorView";/);
  assert.match(chatInspectorDock, /<InspectorView[\s\S]*descriptor=\{tab\}/);
  assert.doesNotMatch(chatView, /function InspectorView\(/);
  assert.doesNotMatch(chatView, /fileStatus === "missing"/);
  assert.doesNotMatch(chatView, /coreBridge\.taskQueue/);
  assert.doesNotMatch(chatView, /coreBridge\.fsList/);
  assert.match(chatInspectorDock, /export function ChatInspectorDock/);
  assert.match(inspectorView, /export function InspectorView/);
  assert.match(inspectorView, /fileStatus === "missing"/);
  assert.match(inspectorView, /\.taskQueue\(/);
  assert.match(inspectorView, /\.fsList\(/);
});

test("ChatView delegates message and formatting helpers to chatViewMessages", () => {
  assert.match(chatView, /from "\.\.\/lib\/chatViewMessages";/);
  assert.doesNotMatch(chatView, /function describeBridgeError\(/);
  assert.doesNotMatch(chatView, /function withChatMetrics\(/);
  assert.doesNotMatch(chatView, /function formatChatDuration\(/);
  assert.doesNotMatch(chatView, /function messageContentKind\(/);
  assert.doesNotMatch(chatView, /function fileLocalPath\(/);
  assert.match(chatViewMessages, /export function describeBridgeError/);
  assert.match(chatViewMessages, /export function withChatMetrics/);
  assert.match(chatViewMessages, /export function chatMessageFromAssistantResult/);
  assert.match(chatViewMessages, /export function fileLocalPath/);
  assert.match(chatViewMessages, /fileLocalPathFromBridge/);
});

test("ChatView delegates structured payload parsing to ChatPayloadParsers", () => {
  assert.match(chatActivityProjectionHook, /from "\.\.\/lib\/chat-runtime\/kernelProjectionPresenter";/);
  assert.doesNotMatch(chatActivityProjectionHook, /from "\.\/ChatPayloadParsers";/);
  assert.doesNotMatch(chatView, /from "\.\/ChatPayloadParsers";/);
  assert.doesNotMatch(chatView, /function eventPayload\(/);
  assert.doesNotMatch(chatView, /function parseVaultProposalPayload\(/);
  assert.doesNotMatch(chatView, /function parseVaultRevealPayload\(/);
  assert.doesNotMatch(chatView, /function parsePaymentApprovalPayload\(/);
  assert.doesNotMatch(chatView, /function parseChoicePromptPayload\(/);
  assert.doesNotMatch(chatView, /function latestPlanMarkdown\(/);
  assert.doesNotMatch(chatView, /function latestActivitySteps\(/);
  assert.match(chatPayloadParsers, /export function eventPayload/);
  assert.match(chatPayloadParsers, /export function parseVaultProposalPayload/);
  assert.match(chatPayloadParsers, /export function parsePaymentApprovalPayload/);
  assert.match(chatPayloadParsers, /export function parseChoicePromptPayload/);
  assert.match(chatPayloadParsers, /export function latestActivitySteps/);
});

test("ChatView delegates browser/activity lifecycle ownership to useChatBrowserActivityLifecycle", () => {
  assert.match(chatView, /from "\.\/useChatBrowserActivityLifecycle";/);
  assert.match(chatView, /useChatBrowserActivityLifecycle\(\{/);
  assert.doesNotMatch(chatView, /from "\.\/useChatActivityProjection";/);
  assert.doesNotMatch(chatView, /useChatActivityProjection\(\{/);
  assert.doesNotMatch(chatView, /from "\.\/useChatComputerSession";/);
  assert.doesNotMatch(chatView, /useChatComputerSession\(\{/);
  assert.doesNotMatch(chatView, /fetchThreadActivity/);
  assert.doesNotMatch(chatView, /latestPlanMarkdown/);
  assert.doesNotMatch(chatView, /latestActivitySteps/);
  assert.doesNotMatch(chatView, /parsePlanSteps/);
  assert.doesNotMatch(chatView, /setProjectedActivity/);
  assert.doesNotMatch(chatView, /setProjectedPlan/);
  assert.doesNotMatch(chatView, /setProjectedTurnStatus/);
  assert.doesNotMatch(chatView, /setProjectedSubagents/);
  assert.doesNotMatch(chatView, /setProjectedActiveTurn/);
  assert.doesNotMatch(chatView, /setProjectionLoaded/);
  assert.doesNotMatch(chatView, /createLoadingComputerSession/);
  assert.doesNotMatch(chatView, /createUnavailableComputerSession/);
  assert.doesNotMatch(chatView, /mapCoreComputerSession/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*localComputerSession/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*localComputerArtifactPreview/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*pauseLocalComputerSession/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*resumeLocalComputerSession/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*requestLocalComputerTakeover/);
  // The lifecycle hook composes both sub-hooks
  assert.match(chatBrowserActivityLifecycleHook, /from "\.\/useChatComputerSession";/);
  assert.match(chatBrowserActivityLifecycleHook, /from "\.\/useChatActivityProjection";/);
  assert.match(chatBrowserActivityLifecycleHook, /export function useChatBrowserActivityLifecycle/);
  // The sub-hooks still own their internals
  assert.match(chatActivityProjectionHook, /export function useChatActivityProjection/);
  assert.match(chatActivityProjectionHook, /fetchKernelThreadProjection/);
  assert.match(chatActivityProjectionHook, /projectKernelThreadView/);
  assert.doesNotMatch(chatActivityProjectionHook, /fetchThreadActivity/);
  assert.match(chatComputerSessionHook, /export function useChatComputerSession/);
  assert.match(chatComputerSessionHook, /createLoadingComputerSession/);
});

test("ChatView delegates stream event projection ownership to chatStreamEventProjection", () => {
  assert.match(useChatTurnSubmissionHook, /from "\.\/chatStreamEventProjection";/);
  assert.match(useChatTurnSubmissionHook, /projectChatStreamEvent\(/);
  assert.doesNotMatch(chatView, /chatEventPartFromStream/);
  assert.doesNotMatch(chatView, /shouldDropStructuredMarkerDelta/);
  assert.match(chatStreamEventProjection, /export function projectChatStreamEvent/);
  assert.match(chatStreamEventProjection, /chatEventPartFromStream/);
  assert.match(chatStreamEventProjection, /shouldDropStructuredMarkerDelta/);
});

test("ChatView delegates stream lifecycle ownership to useChatStreamLifecycle", () => {
  assert.match(chatView, /from "\.\/useChatStreamLifecycle";/);
  assert.match(chatView, /useChatStreamLifecycle\(\{/);
  assert.doesNotMatch(chatView, /cancelStreamingRequestRef/);
  assert.doesNotMatch(chatView, /cancelledStreamIdsRef/);
  assert.doesNotMatch(chatView, /setStreamHasVisibleText/);
  assert.doesNotMatch(chatView, /function resetStreamingState/);
  assert.doesNotMatch(chatView, /function cancelActiveStreaming/);
  assert.match(chatStreamLifecycleHook, /export function useChatStreamLifecycle/);
  assert.match(chatStreamLifecycleHook, /cancelStreamingRequestRef/);
  assert.match(chatStreamLifecycleHook, /cancelledStreamIdsRef/);
  assert.match(chatStreamLifecycleHook, /resetStreamingState/);
  assert.match(chatStreamLifecycleHook, /cancelActiveStreaming/);
});

test("stop and resumed-stream cancel closures reconcile the active turn projection", () => {
  // stopActiveTurn branch 1 (local streaming cancel) must clear the projected
  // active turn before delegating to the cancel closure, otherwise the UI
  // stays on "assistant is thinking" with a running timer after Stop.
  assert.match(
    useChatTurnSubmissionHook,
    /clearProjectedActiveTurn\(\);\s*\n\s*cancelActiveStreaming\(\);/,
  );
  // Local cancel closures bump the island projection refresh nonce after the
  // cancel DELETE settles, so the activity projection re-fetches and
  // reconciles with the gateway instead of re-populating a still-active turn
  // (fetch-vs-DELETE race).
  assert.match(
    useChatTurnSubmissionHook,
    /cancelChatPromptStream\(requestId\)\s*\n\s*\.catch\(\(\) => undefined\)\s*\n\s*\.then\(\(\) => bumpIslandRefreshNonce\(\)\);/,
  );
  // Cancel closures must NOT bump the activity nonce: activityNonce only
  // drives the island Activity section auto-open, and stopping a turn must
  // never re-open the island.
  assert.doesNotMatch(
    useChatTurnSubmissionHook,
    /\.then\(\(\) => bumpActivityNonce\(\)\)/,
  );
  assert.doesNotMatch(
    useChatStreamResumeHook,
    /\.then\(\(\) => bumpActivityNonce\(\)\)/,
  );
  // stopActiveTurn branch 2 (direct cancelTurn) resets the composer streaming
  // state when the cancelled turn is the one owned by a local/resumed stream.
  assert.match(
    useChatTurnSubmissionHook,
    /streamOwnerTurnRef\.current === turnId \|\| activeTurnIdRef\.current === turnId/,
  );
  // Branch 2 clears the stream status only for the cancelled turn's request
  // (derived from the turn id), never wiping another request's status.
  assert.match(useChatTurnSubmissionHook, /requestIdFromTurnId\(turnId\)/);
  assert.match(
    useChatTurnSubmissionHook,
    /setStreamStatus\(\(current\) => clearStreamStatusForRequest\(current, cancelledRequestId\)\);/,
  );
  // Resumed streams must register a cancel closure so the composer Stop works
  // during a resumed stream, and release it after.
  assert.match(useChatStreamResumeHook, /setActiveStreamingCancel\(cancelStreamingRequest\);/);
  assert.match(useChatStreamResumeHook, /clearActiveStreamingCancel\(cancelStreamingRequest\);/);
  assert.match(useChatStreamResumeHook, /coreBridge\.cancelChatPromptStream\(requestId\)/);
  assert.match(useChatStreamResumeHook, /markStreamCancelled\(requestId\);/);
  // The resume cancel closure resets the thinking/streaming state immediately.
  assert.match(useChatStreamResumeHook, /setStreamingAssistantId\(null\);/);
  assert.match(useChatStreamResumeHook, /setPromptSubmitting\(false\);/);
  assert.match(useChatStreamResumeHook, /clearStreamStatusForRequest\(current, requestId\)/);
  // The resume cancel closure drops the synthetic optimistic layer; the
  // persisted partial text comes back from the DB replay.
  assert.match(useChatStreamResumeHook, /setOptimisticMessages\(null\);/);
  // The resume catch surfaces real errors (like submitPrompt) but stays
  // silent on local cancels.
  assert.match(useChatStreamResumeHook, /cancelledLocally \|\| isStreamCancelled\(requestId\)/);
  assert.match(useChatStreamResumeHook, /setPromptError\(describeBridgeError\(error\)\);/);
  // The resume path guards both event projection and result commit on cancel.
  assert.match(useChatStreamResumeHook, /isStreamCancelled\(requestId\)/);
  assert.match(useChatStreamResumeHook, /clearStreamCancelled\(requestId\);/);
});

test("cancel DELETE uses the server turn id and never swallows non-2xx", () => {
  // After a resume, POST /turns answers with the EXISTING execution id while
  // the client holds a fresh requestId: coreBridge must remember the
  // server-assigned turn id per requestId so the cancel closure targets the
  // real turn instead of a `turn_${requestId}` ghost (which 404s).
  assert.match(coreBridge, /const serverTurnIdByRequestId = new Map<string, string>\(\);/);
  // The submit path registers the server turn id right after enqueue (covers
  // both "queued" and "resumed" responses).
  assert.match(coreBridge, /const turnId = enqueued\.turn_id;/);
  assert.match(coreBridge, /serverTurnIdByRequestId\.set\(requestId, turnId\);/);
  // The cancel closure resolves the server id first and falls back to the
  // derived id only when the server id is unknown.
  assert.match(
    coreBridge,
    /serverTurnIdByRequestId\.get\(requestId\) \?\? `turn_\$\{requestId\}`/,
  );
  assert.match(coreBridge, /await cancelTurn\(turnId\);/);
  // The mapping is cleaned up once the turn's replay settles so it cannot
  // grow unboundedly across sessions.
  assert.match(coreBridge, /serverTurnIdByRequestId\.delete\(requestId\);/);
  // cancelTurn must NOT swallow non-2xx: a silent 404 historically meant the
  // server-side cancel never happened. It stays non-blocking (warn, no throw).
  assert.match(chatApi, /export async function cancelTurn\(turnId: string\): Promise<void>/);
  assert.match(chatApi, /if \(!response\.ok\)/);
  assert.match(chatApi, /console\.warn\(/);
  assert.match(chatApi, /cancelTurn DELETE \/api\/chat\/turns\/\$\{turnId\} returned HTTP \$\{response\.status\}/);
  assert.doesNotMatch(chatApi, /cancelTurn[\s\S]*throw new Error\(.*cancel/i);
});

test("ChatView delegates auto-title ownership to useChatAutoTitle", () => {
  assert.match(chatView, /from "\.\/useChatAutoTitle";/);
  assert.match(chatView, /useChatAutoTitle\(\{/);
  assert.match(useChatTurnSubmissionHook, /persistAutoTitleForCompletedTurn\(/);
  assert.doesNotMatch(chatView, /function persistAutoTitleForCompletedTurn/);
  assert.doesNotMatch(chatView, /titledThreadsRef/);
  assert.doesNotMatch(chatView, /coreBridge\.autoTitleThread/);
  assert.match(chatAutoTitleHook, /export function useChatAutoTitle/);
  assert.match(chatAutoTitleHook, /titledThreadsRef/);
  assert.match(chatAutoTitleHook, /coreBridge\.autoTitleThread/);
});

test("ChatView delegates message editing ownership to useChatMessageEditing", () => {
  assert.match(chatView, /from "\.\/useChatMessageEditing";/);
  assert.match(chatView, /useChatMessageEditing\(\{/);
  assert.match(chatView, /editingMessageId/);
  assert.match(chatView, /onEditingTextChange=\{setEditingText\}/);
  assert.match(chatView, /onCancelEdit=\{cancelEditMessage\}/);
  assert.match(chatView, /onSaveEdit=\{saveEditedMessage\}/);
  assert.match(chatView, /onEdit=\{startEditMessage\}/);
  assert.doesNotMatch(chatView, /const \[editingMessageId, setEditingMessageId\]/);
  assert.doesNotMatch(chatView, /const \[editingText, setEditingText\]/);
  assert.doesNotMatch(chatView, /function startEditMessage/);
  assert.doesNotMatch(chatView, /function cancelEditMessage/);
  assert.doesNotMatch(chatView, /function saveEditedMessage/);
  assert.match(chatMessageEditingHook, /export function useChatMessageEditing/);
  assert.match(chatMessageEditingHook, /setOptimisticMessages\(base\)/);
  assert.match(chatMessageEditingHook, /submitEditedPrompt\(/);
  assert.match(chatMessageEditingHook, /branchFromId/);
});

test("ChatView delegates message action ownership to useChatMessageActions", () => {
  assert.match(chatView, /from "\.\/useChatMessageActions";/);
  assert.match(chatView, /useChatMessageActions\(\{/);
  assert.match(chatView, /copiedMessageId/);
  assert.match(chatView, /onCaptureScreenshot=\{IS_DESKTOP \? \(\) => void captureScreenshot\(\) : undefined\}/);
  assert.match(chatView, /onCopy=\{copyMessageText\}/);
  assert.match(chatView, /onFeedback=\{setMessageFeedback\}/);
  assert.match(chatView, /onSaveToMemory=\{saveMessageToMemory\}/);
  assert.match(chatView, /onSaveAsGoal=\{saveMessageAsGoal\}/);
  assert.doesNotMatch(chatView, /const \[copiedMessageId, setCopiedMessageId\]/);
  assert.doesNotMatch(chatView, /function copyMessageText/);
  assert.doesNotMatch(chatView, /function exportChatMarkdown/);
  assert.doesNotMatch(chatView, /function captureScreenshot/);
  assert.doesNotMatch(chatView, /function setMessageFeedback/);
  assert.doesNotMatch(chatView, /function saveMessageAsGoal/);
  assert.doesNotMatch(chatView, /function saveMessageToMemory/);
  assert.doesNotMatch(chatView, /copyText\(/);
  assert.doesNotMatch(chatView, /buildChatMarkdown/);
  assert.doesNotMatch(chatView, /captureAppScreenshot\(/);
  assert.match(chatMessageActionsHook, /export function useChatMessageActions/);
  assert.match(chatMessageActionsHook, /copyText\(/);
  assert.match(chatMessageActionsHook, /captureAppScreenshot\(/);
  assert.match(chatMessageActionsHook, /coreBridge\.setChatMessageFeedback/);
  assert.match(chatMessageActionsHook, /coreBridge\.saveChatMessageToMemory/);
});

test("ChatView delegates steering prompt edit assembly to chatSteeringPrompt", () => {
  assert.match(chatSteeringQueueHook, /from "\.\.\/lib\/chatSteeringPrompt";/);
  assert.doesNotMatch(chatView, /from "\.\.\/lib\/chatSteeringPrompt";/);
  assert.doesNotMatch(chatView, /function steeringPromptWithEdit\(/);
  assert.match(chatSteeringPrompt, /export function steeringPromptWithEdit/);
  assert.match(chatSteeringPrompt, /visible_prompt/);
});

test("ChatView delegates model-facing prompt assembly to chatPromptAssembly", () => {
  assert.match(useChatTurnSubmissionHook, /from "\.\.\/lib\/chatPromptAssembly";/);
  assert.doesNotMatch(chatView, /const skillPrefix = options\?\.forcedSkillsId/);
  assert.doesNotMatch(chatView, /Apply this instruction to the active task while keeping the quoted context/);
  assert.doesNotMatch(chatView, /Reply to the quoted message keeping the context/);
  assert.doesNotMatch(chatView, /Continue the previous response from where it stopped/);
  assert.match(chatPromptAssembly, /export function buildComposerPromptDecorators/);
  assert.match(chatPromptAssembly, /export function buildSteeringPrompt/);
  assert.match(chatPromptAssembly, /export function buildReplyContextPrompt/);
  assert.match(chatPromptAssembly, /export const CONTINUE_RESPONSE_PROMPT/);
});

test("ChatView delegates assistant message body rendering to AssistantMessageBody", () => {
  assert.doesNotMatch(chatView, /from "\.\/AssistantMessageBody";/);
  assert.match(chatMessageContent, /from "\.\/AssistantMessageBody";/);
  assert.match(chatMessageContent, /<AssistantMessageBody[\s\S]*text=\{message\.text\}/);
  assert.doesNotMatch(chatView, /const AssistantMessageBody = memo/);
  assert.doesNotMatch(chatView, /function humanizeToolSlugs/);
  assert.doesNotMatch(chatView, /parseComposioConfirm\(text, eventParts\)/);
  assert.match(assistantMessageBody, /export const AssistantMessageBody = memo/);
  assert.match(assistantMessageBody, /parseComposioConfirm\(text, eventParts\)/);
  assert.match(assistantMessageBody, /visibleMessageText\(visible\)/);
});

test("ChatView delegates message content state rendering to ChatMessageContent", () => {
  assert.doesNotMatch(chatView, /from "\.\/ChatMessageContent";/);
  assert.match(chatMessageRow, /from "\.\/ChatMessageContent";/);
  assert.match(chatMessageRow, /<ChatMessageContent[\s\S]*?onSubmitChoiceAnswer=\{onSubmitChoiceAnswer\}/);
  assert.match(chatMessageRow, /<ChatMessageContent[\s\S]*?onHandleProactiveAnswer=\{onHandleProactiveAnswer\}/);
  assert.doesNotMatch(chatView, /streamHasVisibleText && !chatTurnState/);
  assert.match(chatMessageContent, /export function ChatMessageContent/);
  assert.match(chatMessageContent, /isStreaming \?/);
  assert.match(chatMessageContent, /if \(isEditing\)/);
  assert.match(chatMessageContent, /onHandleProactiveAnswer\(message\.text, answer\)/);
});

test("ChatView delegates post-content message controls to ChatMessageAfterContent", () => {
  assert.doesNotMatch(chatView, /from "\.\/ChatMessageAfterContent";/);
  assert.match(chatMessageRow, /from "\.\/ChatMessageAfterContent";/);
  assert.match(chatMessageRow, /<ChatMessageAfterContent[\s\S]*?onSelectFollowUp=\{onSelectFollowUp\}/);
  assert.match(chatMessageRow, /<ChatMessageAfterContent[\s\S]*?onSaveAsGoal=\{onSaveAsGoal\}/);
  assert.doesNotMatch(chatView, /followUpsFor === displayMessage\.id/);
  assert.doesNotMatch(chatView, /previousUserMessageIndex\.get\(displayMessage\.id\)/);
  assert.match(chatMessageAfterContent, /export function ChatMessageAfterContent/);
  assert.match(chatMessageAfterContent, /branchPoint\.options\.length >= 2/);
  assert.match(chatMessageAfterContent, /onSelectFollowUp\(suggestion\)/);
});

test("ChatView delegates each transcript row to ChatMessageRow", () => {
  assert.doesNotMatch(chatView, /from "\.\/ChatMessageRow";/);
  assert.doesNotMatch(chatView, /<ChatMessageRow/);
  assert.match(chatTranscript, /from "\.\/ChatMessageRow";/);
  assert.match(chatTranscript, /<ChatMessageRow[\s\S]*?onSaveAsGoal=\{onSaveAsGoal\}/);
  assert.doesNotMatch(chatView, /messageSurfaceClass/);
  assert.doesNotMatch(chatView, /className="thread-message-row"/);
  assert.doesNotMatch(chatView, /isLikelyIncompleteMessage\(displayMessage\)/);
  assert.match(chatMessageRow, /export function ChatMessageRow/);
  assert.match(chatMessageRow, /className="thread-message-row"/);
  assert.match(chatMessageRow, /isLikelyIncompleteMessage\(message\)/);
});

test("ChatView delegates transcript surface rendering to ChatTranscript", () => {
  assert.match(chatView, /from "\.\/ChatTranscript";/);
  assert.match(chatView, /<ChatTranscript[\s\S]*?conversationRef=\{conversationRef\}/);
  assert.match(chatView, /<ChatTranscript[\s\S]*?sessionSeed=\{CHAT_VIEW_SESSION_ID\}/);
  assert.doesNotMatch(chatView, /className="thread-scroll"/);
  assert.doesNotMatch(chatView, /className="thread-message-list"/);
  assert.doesNotMatch(chatView, /className="chat-jump-bottom"/);
  assert.match(chatTranscript, /export function ChatTranscript/);
  assert.match(chatTranscript, /className="thread-scroll"/);
  assert.match(chatTranscript, /className="thread-message-list"/);
  assert.match(chatTranscript, /className="chat-jump-bottom"/);
});

test("ChatView delegates conversation scroll ownership to useChatConversationScroll", () => {
  assert.match(chatView, /from "\.\/useChatConversationScroll";/);
  assert.match(chatView, /useChatConversationScroll\(\{\s*threadId:\s*thread\.threadId,/);
  assert.match(chatView, /onJumpToBottom=\{jumpToBottom\}/);
  assert.doesNotMatch(chatView, /const \[showJumpToBottom,\s*setShowJumpToBottom\]/);
  assert.doesNotMatch(chatView, /streamingFrameRef\s*=\s*useRef/);
  assert.doesNotMatch(chatView, /shouldStickToBottomRef\s*=\s*useRef/);
  assert.match(chatConversationScroll, /export function useChatConversationScroll/);
  assert.match(chatConversationScroll, /const \[showJumpToBottom,\s*setShowJumpToBottom\]/);
  assert.match(chatConversationScroll, /scrollConversationToBottomIfPinned/);
  assert.match(chatConversationScroll, /window\.addEventListener\("resize", handleResize\)/);
});

test("ChatView delegates project context ownership to useChatProjectContext", () => {
  assert.match(chatView, /from "\.\/useChatProjectContext";/);
  assert.match(chatView, /useChatProjectContext\(thread\.threadId\)/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*projectGoals/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*memoryGraph/);
  assert.match(chatProjectContext, /export function useChatProjectContext/);
  assert.match(chatProjectContext, /coreBridge\s*\.\s*projectGoals\(threadId\)/);
  assert.match(chatProjectContext, /coreBridge\s*\.\s*memoryGraph\(threadId\)/);
  assert.match(chatProjectContext, /setGoalSeed/);
});

test("ChatView delegates memory artifact loading to useChatMemoryArtifacts", () => {
  assert.match(chatView, /from "\.\/useChatMemoryArtifacts";/);
  assert.match(chatView, /useChatMemoryArtifacts\(thread\.threadId,\s*messages\)/);
  assert.match(chatView, /onRetryArtifactCatalog=\{retryMemoryArtifacts\}/);
  assert.doesNotMatch(chatView, /reconcileMemoryArtifacts/);
  assert.doesNotMatch(chatView, /setMemoryArtifactsReloadNonce/);
  assert.match(chatMemoryArtifacts, /export function useChatMemoryArtifacts/);
  assert.match(chatMemoryArtifacts, /coreBridge\s*\.\s*memoryArtifacts\(threadId\)/);
  assert.match(chatMemoryArtifacts, /reconcileMemoryArtifacts/);
  assert.match(chatMemoryArtifacts, /retryMemoryArtifacts/);
});

test("ChatView delegates follow-up suggestion ownership to useChatFollowUps", () => {
  assert.match(chatView, /from "\.\/useChatFollowUps";/);
  assert.match(chatView, /useChatFollowUps\(\{\s*previousUserMessageIndex,/);
  assert.match(useChatTurnSubmissionHook, /clearFollowUps\(\)/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*chatSuggestions/);
  assert.doesNotMatch(chatView, /const \[followUps,\s*setFollowUps\]/);
  assert.match(chatFollowUpsHook, /export function useChatFollowUps/);
  assert.match(chatFollowUpsHook, /coreBridge\s*\.\s*chatSuggestions/);
  assert.match(chatFollowUpsHook, /const \[followUps,\s*setFollowUps\]/);
});

test("useChatTurnStatus delegates active-turn elapsed timing to useChatActiveTurnElapsed", () => {
  assert.match(chatView, /from "\.\/useChatTurnStatus";/);
  assert.doesNotMatch(chatView, /from "\.\/useChatActiveTurnElapsed";/);
  assert.match(chatTurnStatusHook, /from "\.\/useChatActiveTurnElapsed";/);
  assert.match(chatTurnStatusHook, /useChatActiveTurnElapsed\(\{\s*activeTurnKey,/);
  assert.doesNotMatch(chatView, /setActiveTurnElapsedSeconds/);
  assert.doesNotMatch(chatView, /window\.setInterval\(updateElapsed,\s*1000\)/);
  assert.match(chatActiveTurnElapsed, /export function useChatActiveTurnElapsed/);
  assert.match(chatActiveTurnElapsed, /window\.setInterval\(updateElapsed,\s*1000\)/);
  assert.match(chatActiveTurnElapsed, /projectedUpdatedAt/);
});

test("ChatView delegates active-turn status ownership to useChatTurnStatus", () => {
  assert.match(chatView, /from "\.\/useChatTurnStatus";/);
  assert.match(chatView, /useChatTurnStatus\(\{/);
  assert.doesNotMatch(chatView, /deriveChatTurnStatus/);
  assert.doesNotMatch(chatView, /useChatActiveTurnElapsed/);
  assert.doesNotMatch(chatView, /const activeTurnKey =/);

  assert.match(chatTurnStatusHook, /export function useChatTurnStatus/);
  assert.match(chatTurnStatusHook, /useChatActiveTurnElapsed/);
  assert.match(chatTurnStatusHook, /deriveChatTurnStatus/);
});

test("ChatView delegates streaming mount notifications to useChatStreamingNotifier", () => {
  assert.match(chatView, /from "\.\/useChatStreamingNotifier";/);
  assert.match(chatView, /useChatStreamingNotifier\(onStreamingChange\)/);
  assert.doesNotMatch(chatView, /onStreamingChangeRef/);
  assert.doesNotMatch(chatView, /useRef\(onStreamingChange\)/);
  assert.match(chatStreamingNotifier, /export function useChatStreamingNotifier/);
  assert.match(chatStreamingNotifier, /const onStreamingChangeRef = useRef\(onStreamingChange\)/);
  assert.match(chatStreamingNotifier, /notifyStreaming\(false\)/);
});

test("ChatView delegates branch state ownership to useChatBranches", () => {
  assert.match(chatView, /from "\.\/useChatBranches";/);
  assert.match(chatView, /useChatBranches\(\{/);
  assert.doesNotMatch(chatView, /const \[branches,\s*setBranches\]/);
  assert.doesNotMatch(chatView, /const \[branchBusy,\s*setBranchBusy\]/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*chatBranches/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*setActiveLeaf/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*setBranchLabel/);
  assert.match(chatBranchesHook, /export function useChatBranches/);
  assert.match(chatBranchesHook, /coreBridge\s*\.\s*chatBranches/);
  assert.match(chatBranchesHook, /coreBridge\s*\.\s*setActiveLeaf/);
  assert.match(chatBranchesHook, /coreBridge\s*\.\s*setBranchLabel/);
});

test("ChatView delegates inspector workspace ownership to useChatInspectorWorkspace", () => {
  assert.match(chatView, /from "\.\/useChatInspectorWorkspace";/);
  assert.match(chatView, /useChatInspectorWorkspace\(\{/);
  assert.doesNotMatch(chatView, /inspectorWorkspaceReducer/);
  assert.doesNotMatch(chatView, /loadInspectorState/);
  assert.doesNotMatch(chatView, /filterInspectorState/);
  assert.doesNotMatch(chatView, /saveInspectorState/);
  assert.doesNotMatch(chatView, /saveInspectorWidthRatio/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*fsFile/);
  assert.match(chatInspectorWorkspace, /export function useChatInspectorWorkspace/);
  assert.match(chatInspectorWorkspace, /inspectorWorkspaceReducer/);
  assert.match(chatInspectorWorkspace, /loadInspectorState/);
  assert.match(chatInspectorWorkspace, /filterInspectorState/);
  assert.match(chatInspectorWorkspace, /saveInspectorState/);
  assert.match(chatInspectorWorkspace, /saveInspectorWidthRatio/);
  assert.match(chatInspectorWorkspace, /coreBridge\s*\.\s*fsFile/);
});

test("useChatBrowserActivityLifecycle delegates computer session ownership to useChatComputerSession", () => {
  assert.match(chatBrowserActivityLifecycleHook, /useChatComputerSession\(\{/);
  assert.doesNotMatch(chatView, /createLoadingComputerSession/);
  assert.doesNotMatch(chatView, /createUnavailableComputerSession/);
  assert.doesNotMatch(chatView, /mapCoreComputerSession/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*localComputerSession/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*localComputerArtifactPreview/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*pauseLocalComputerSession/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*resumeLocalComputerSession/);
  assert.doesNotMatch(chatView, /coreBridge\s*\.\s*requestLocalComputerTakeover/);
  assert.match(chatComputerSessionHook, /export function useChatComputerSession/);
  assert.match(chatComputerSessionHook, /createLoadingComputerSession/);
  assert.match(chatComputerSessionHook, /createUnavailableComputerSession/);
  assert.match(chatComputerSessionHook, /mapCoreComputerSession/);
  assert.match(chatComputerSessionHook, /coreBridge\s*\.\s*localComputerSession/);
  assert.match(chatComputerSessionHook, /coreBridge\s*\.\s*localComputerArtifactPreview/);
  assert.match(chatComputerSessionHook, /coreBridge\s*\.\s*pauseLocalComputerSession/);
  assert.match(chatComputerSessionHook, /coreBridge\s*\.\s*resumeLocalComputerSession/);
  assert.match(chatComputerSessionHook, /coreBridge\s*\.\s*requestLocalComputerTakeover/);
});

test("ChatView delegates approval flow ownership to useChatApprovalFlow", () => {
  assert.match(chatView, /from "\.\/useChatApprovalFlow";/);
  assert.match(chatView, /useChatApprovalFlow\(\{/);
  assert.doesNotMatch(chatView, /from "\.\/useChatSteeringQueue";/);
  assert.doesNotMatch(chatView, /useChatSteeringQueue\(\{/);
  assert.doesNotMatch(chatView, /from "\.\.\/lib\/chat-runtime\/steering";/);
  assert.doesNotMatch(chatView, /createSteeringQueueState/);
  assert.doesNotMatch(chatView, /reconcileSteering/);
  assert.doesNotMatch(chatView, /applySteeringChange/);
  assert.doesNotMatch(chatView, /fetchThreadSteering/);
  assert.doesNotMatch(chatView, /updateSteering/);
  assert.doesNotMatch(chatView, /deleteSteering/);
  assert.doesNotMatch(chatView, /sendSteeringNow/);
  assert.match(useChatApprovalFlowHook, /from "\.\/useChatSteeringQueue";/);
  assert.match(useChatApprovalFlowHook, /useChatSteeringQueue\(\{/);
  assert.match(useChatApprovalFlowHook, /visiblePendingSteeringRows/);
  assert.match(useChatApprovalFlowHook, /filterActiveApprovels/);
  assert.match(chatSteeringQueueHook, /export function useChatSteeringQueue/);
  assert.match(chatSteeringQueueHook, /createSteeringQueueState/);
  assert.match(chatSteeringQueueHook, /reconcileSteering/);
  assert.match(chatSteeringQueueHook, /applySteeringChange/);
  assert.match(chatSteeringQueueHook, /fetchThreadSteering/);
  assert.match(chatSteeringQueueHook, /updateSteering/);
  assert.match(chatSteeringQueueHook, /deleteSteering/);
  assert.match(chatSteeringQueueHook, /sendSteeringNow/);
});

test("ChatView delegates resume marker persistence to chatResumeMarkers", () => {
  assert.match(useChatTurnSubmissionHook, /from "\.\.\/lib\/chatResumeMarkers";/);
  assert.doesNotMatch(chatView, /RESUME_MARKER_TTL_MS/);
  assert.doesNotMatch(chatView, /function resumeMarkerKey/);
  assert.doesNotMatch(chatView, /window\.localStorage\.(?:setItem|getItem|removeItem)/);
  assert.match(chatResumeMarkers, /export interface ResumeMarker/);
  assert.match(chatResumeMarkers, /RESUME_MARKER_TTL_MS/);
  assert.match(chatResumeMarkers, /window\.localStorage\.setItem/);
  assert.match(chatResumeMarkers, /window\.localStorage\.getItem/);
  assert.match(chatResumeMarkers, /window\.localStorage\.removeItem/);
});

test("ChatView imports typed transcript indexes from messageIndex", () => {
  assert.match(chatView, /from "\.\.\/lib\/messageIndex";/);
  assert.doesNotMatch(chatView, /import \* as messageIndex/);
  assert.doesNotMatch(chatView, /messageIndex\.buildBranchIndex as/);
});

test("RichMessageRenderer imports typed markdown helpers", () => {
  assert.match(richMessageRenderer, /from "\.\.\/lib\/markdownBlocks";/);
  assert.match(richMessageRenderer, /from "\.\.\/lib\/settledText";/);
  assert.doesNotMatch(richMessageRenderer, /import \* as markdownBlocks/);
  assert.doesNotMatch(richMessageRenderer, /import \* as settledText/);
});

test("ChatView delegates chat event projection helpers to chatEventParts", () => {
  assert.match(useChatTurnSubmissionHook, /from "\.\.\/lib\/chatEventParts";/);
  assert.doesNotMatch(chatView, /chatEventPartFromStream/);
  assert.doesNotMatch(chatView, /function normalizeChatEventParts/);
  assert.doesNotMatch(chatView, /shouldDropStructuredMarkerDelta/);
  assert.doesNotMatch(chatView, /function replayStatusFromProjection/);
  assert.doesNotMatch(chatView, /function threadTailAwaitsUser/);
  assert.doesNotMatch(chatView, /interface ActiveTurnProjection/);
  assert.match(chatEventParts, /from "\.\/chatEventParts\.mjs"/);
  assert.match(chatEventPartsImpl, /export function chatEventPartFromStream/);
  assert.match(chatEventPartsImpl, /export function normalizeChatEventParts/);
  assert.match(chatEventPartsImpl, /export function shouldDropStructuredMarkerDelta/);
  assert.match(chatEventPartsImpl, /export function replayStatusFromProjection/);
  assert.doesNotMatch(chatEventPartsImpl, /export function threadTailAwaitsUser/);
  assert.match(chatEventParts, /export interface ActiveTurnProjection/);
});

test("ChatView does not retain retired unused chat mode helpers", () => {
  assert.doesNotMatch(chatView, /function isLatestAssistantMessage/);
  assert.doesNotMatch(chatView, /const CHAT_MODES:/);
  assert.doesNotMatch(chatView, /type ChatMode =/);
  assert.doesNotMatch(chatView, /Systematic debugging \(code projects\)/);
});

test("ChatView does not retain retired topbar status props", () => {
  assert.doesNotMatch(chatView, /activeHealth/);
  assert.doesNotMatch(chatView, /activeModelInfo/);
  assert.doesNotMatch(chatView, /headerModelLabel/);
  assert.doesNotMatch(chatView, /headerToolPolicy/);
  assert.doesNotMatch(chatView, /health: RuntimeHealth/);
  assert.doesNotMatch(chatView, /task: TaskItem/);
  assert.doesNotMatch(app, /health=\{runtimeItems\}/);
  assert.doesNotMatch(app, /task=\{selectedTask\}/);
});

test("ChatView does not retain retired unused UI flags", () => {
  assert.doesNotMatch(chatView, /modelOpen/);
  assert.doesNotMatch(chatView, /timelineCollapsed/);
  assert.doesNotMatch(chatView, /setTimelineCollapsed/);
  assert.doesNotMatch(chatView, /chatExported/);
  assert.doesNotMatch(chatView, /setChatExported/);
});

test("ChatView delegates workspace island section bodies", () => {
  assert.match(chatWorkspaceDock, /from "\.\/WorkspaceIslandSections";/);
  assert.match(chatWorkspaceDock, /<WorkspaceIslandSections/);
  assert.doesNotMatch(chatView, /<WorkspaceIslandSections/);
  assert.doesNotMatch(chatView, /workspace-island-activity/);
  assert.doesNotMatch(chatView, /workspace-island-browser/);
  assert.doesNotMatch(chatView, /workspace-island-files/);
  assert.match(workspaceIslandSections, /export function WorkspaceIslandSections/);
  assert.match(workspaceIslandSections, /workspace-island-activity/);
  assert.match(workspaceIslandSections, /workspace-island-browser/);
  assert.match(workspaceIslandSections, /workspace-island-files/);
});

test("InspectorView delegates operational plan preview rendering and parsing", () => {
  assert.match(inspectorView, /from "\.\/OperationalPlanPreview";/);
  assert.match(inspectorView, /<OperationalPlanPreview collapsed=\{false\} markdown=\{operationalPlanMarkdown\}/);
  assert.match(inspectorView, /parseOperationalPlanItems\(operationalPlanMarkdown\)/);
  assert.doesNotMatch(chatView, /function OperationalPlanPreview\(/);
  assert.doesNotMatch(chatView, /function parseOperationalPlanItems\(/);
  assert.doesNotMatch(chatView, /function planPreviewItems\(/);
  assert.match(operationalPlanPreview, /export function OperationalPlanPreview/);
  assert.match(operationalPlanPreview, /export function parseOperationalPlanItems/);
  assert.match(operationalPlanPreview, /operational-plan-preview/);
});

test("ChatView delegates choice prompt rendering to MessageChoiceCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageChoiceCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageChoiceCard";/);
  assert.match(assistantMessageBody, /<ChoicesCard prompt=\{choices\} onChoose=\{onChoose\}/);
  assert.doesNotMatch(chatView, /function ChoicesCard\(/);
  assert.doesNotMatch(chatView, /interface ChoicePrompt/);
  assert.match(messageChoiceCard, /export interface ChoicePrompt/);
  assert.match(messageChoiceCard, /export function ChoicesCard/);
  assert.match(messageChoiceCard, /choices-card/);
});

test("ChatView delegates proposed plan rendering to MessagePlanProposeCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessagePlanProposeCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessagePlanProposeCard";/);
  assert.match(assistantMessageBody, /<PlanProposeCard plan=\{planPropose\} onAnswer=\{onChoose\}/);
  assert.doesNotMatch(chatView, /function PlanProposeCard\(/);
  assert.doesNotMatch(chatView, /interface PlanProposal/);
  assert.match(messagePlanProposeCard, /export interface PlanProposal/);
  assert.match(messagePlanProposeCard, /export function PlanProposeCard/);
  assert.match(messagePlanProposeCard, /plan-card-gate/);
});

test("ChatView does not retain the retired inline operational plan progress card", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessagePlanProgressCard";/);
  assert.doesNotMatch(chatView, /<PlanProgressCard/);
  assert.doesNotMatch(chatView, /function PlanProgressCard\(/);
  assert.doesNotMatch(chatView, /interface PlanStep/);
  assert.doesNotMatch(chatView, /function parsePlanSteps\(/);
  assert.match(chatPayloadParsers, /export \{ parsePlanSteps, type PlanStep \} from "\.\.\/lib\/chat-runtime\/planSteps";/);
  assert.match(planStepsModule, /export function parsePlanSteps\(markdown\)/);
});

test("ChatView delegates diff message rendering to MessageDiffCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageDiffCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageDiffCard";/);
  assert.match(assistantMessageBody, /<DiffCard key=\{`diff-\$\{index\}`\} payload=\{part\.payload\}/);
  assert.doesNotMatch(chatView, /function DiffCard\(/);
  assert.match(messageDiffCard, /export function DiffCard/);
  assert.match(messageDiffCard, /DiffEventPayload/);
  assert.match(messageDiffCard, /diff-card/);
});

test("ChatView delegates proposed goal rendering to MessageGoalProposeCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageGoalProposeCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageGoalProposeCard";/);
  assert.match(assistantMessageBody, /<GoalProposeCard objectives=\{goalPropose\} threadId=\{threadId\}/);
  assert.doesNotMatch(chatView, /function GoalProposeCard\(/);
  assert.match(messageGoalProposeCard, /export function GoalProposeCard/);
  assert.match(messageGoalProposeCard, /coreBridge\.projectGoals/);
  assert.match(messageGoalProposeCard, /\.addGoal/);
  assert.match(messageGoalProposeCard, /goal-propose-card/);
});

test("ChatView delegates vault reveal rendering to MessageVaultRevealCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageVaultRevealCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageVaultRevealCard";/);
  assert.match(assistantMessageBody, /<VaultRevealCard proposal=\{vaultReveal\}/);
  assert.doesNotMatch(chatView, /function VaultRevealCard\(/);
  assert.doesNotMatch(chatView, /interface VaultRevealProposal/);
  assert.match(messageVaultRevealCard, /export interface VaultRevealProposal/);
  assert.match(messageVaultRevealCard, /export function VaultRevealCard/);
  assert.match(messageVaultRevealCard, /coreBridge\.vaultRecordReveal/);
  assert.match(messageVaultRevealCard, /Vault unlock required/);
});

test("ChatView delegates sandbox read-only rendering to MessageSandboxReadOnlyCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageSandboxReadOnlyCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageSandboxReadOnlyCard";/);
  assert.match(assistantMessageBody, /<SandboxReadOnlyCard target=\{readOnlyBlocked\.target\}/);
  assert.doesNotMatch(chatView, /function SandboxReadOnlyCard\(/);
  assert.match(messageSandboxReadOnlyCard, /export function SandboxReadOnlyCard/);
  assert.match(messageSandboxReadOnlyCard, /coreBridge\.setRuntimeSettings/);
  assert.match(messageSandboxReadOnlyCard, /sandbox_mode: "workspace-write"/);
  assert.match(messageSandboxReadOnlyCard, /sandboxReadOnlyTitle/);
});

test("ChatView delegates Composio reconnect rendering to MessageComposioReconnectCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageComposioReconnectCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageComposioReconnectCard";/);
  assert.match(assistantMessageBody, /<ComposioReconnectCard slug=\{reconnectSlug\}/);
  assert.doesNotMatch(chatView, /function ComposioReconnectCard\(/);
  assert.match(messageComposioReconnectCard, /export function ComposioReconnectCard/);
  assert.match(messageComposioReconnectCard, /connectComposioToolkit/);
  assert.match(messageComposioReconnectCard, /chat\.openingReconnection/);
});

test("ChatView delegates uncertain effect verification to InlineUncertainEffectPanel", () => {
  assert.doesNotMatch(chatView, /from "\.\/InlineUncertainEffectPanel";/);
  assert.doesNotMatch(chatView, /<InlineUncertainEffectPanel/);
  assert.match(chatTranscript, /from "\.\/InlineUncertainEffectPanel";/);
  assert.match(chatTranscript, /<InlineUncertainEffectPanel\s+effects=\{uncertainEffects\}/);
  assert.doesNotMatch(chatView, /function InlineUncertainEffectPanel\(/);
  assert.doesNotMatch(chatView, /function effectFamilyLabel\(/);
  assert.doesNotMatch(chatView, /function formatEffectTime\(/);
  assert.match(inlineUncertainEffectPanel, /export function InlineUncertainEffectPanel/);
  assert.match(inlineUncertainEffectPanel, /effectFamilyLabel/);
  assert.match(inlineUncertainEffectPanel, /formatEffectTime/);
  assert.match(inlineUncertainEffectPanel, /verifiedNotApplied/);
  // The browser family gets outcome-verification copy (it is a verification
  // gate, NOT an authorization request): dedicated title + prompt keys, used
  // ONLY for the browser family while other families keep the generic copy.
  assert.match(inlineUncertainEffectPanel, /chat\.effectVerificationTitleBrowser/);
  assert.match(inlineUncertainEffectPanel, /chat\.effectVerificationPromptBrowser/);
  assert.match(inlineUncertainEffectPanel, /operationFamily === "browser"/);
  assert.match(inlineUncertainEffectPanel, /chat\.effectVerificationPrompt"\)/);
});

test("ChatView delegates inline approvals to InlineApprovelPanel", () => {
  assert.doesNotMatch(chatView, /from "\.\/InlineApprovelPanel";/);
  assert.doesNotMatch(chatView, /<InlineApprovelPanel/);
  assert.match(chatTranscript, /from "\.\/InlineApprovelPanel";/);
  assert.match(chatTranscript, /<InlineApprovelPanel[\s\S]*approvals=\{activeApprovels\}/);
  assert.doesNotMatch(chatView, /function InlineApprovelPanel\(/);
  assert.doesNotMatch(chatView, /const surfaceIcons:/);
  assert.match(inlineApprovelPanel, /export function InlineApprovelPanel/);
  assert.match(inlineApprovelPanel, /const surfaceIcons:/);
  assert.match(inlineApprovelPanel, /busyId === approval\.id/);
  assert.match(inlineApprovelPanel, /approval-plan-preview/);
});

test("ChatView delegates payment approval rendering to MessagePaymentApprovalCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessagePaymentApprovalCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessagePaymentApprovalCard";/);
  assert.match(assistantMessageBody, /<PaymentApprovalCard[\s\S]*proposal=\{paymentApproval\}/);
  assert.doesNotMatch(chatView, /function PaymentApprovalCard\(/);
  assert.doesNotMatch(chatView, /function formatPaymentAmount\(/);
  assert.match(messagePaymentApprovalCard, /export interface PaymentApprovalProposal/);
  assert.match(messagePaymentApprovalCard, /export function PaymentApprovalCard/);
  assert.match(messagePaymentApprovalCard, /coreBridge\.vaultPaymentApprovalApprove/);
  assert.match(messagePaymentApprovalCard, /formatPaymentAmount/);
});

test("ChatView delegates filesystem authorization rendering to MessageFsAuthorizeCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageFsAuthorizeCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageFsAuthorizeCard";/);
  assert.match(assistantMessageBody, /<FsAuthorizeCard[\s\S]*path=\{fsAuthorize\.path\}/);
  assert.doesNotMatch(chatView, /function FsAuthorizeCard\(/);
  assert.match(messageFsAuthorizeCard, /export function FsAuthorizeCard/);
  assert.match(messageFsAuthorizeCard, /coreBridge\.fsAuthorize/);
  assert.match(messageFsAuthorizeCard, /chat\.authorizationFailed/);
});

test("ChatView delegates sandbox escalation rendering to MessageSandboxEscalateCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageSandboxEscalateCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageSandboxEscalateCard";/);
  assert.match(assistantMessageBody, /<SandboxEscalateCard[\s\S]*command=\{sandboxEscalate\.command\}/);
  assert.doesNotMatch(chatView, /function SandboxEscalateCard\(/);
  assert.match(messageSandboxEscalateCard, /export function SandboxEscalateCard/);
  assert.match(messageSandboxEscalateCard, /coreBridge\.runEscalate/);
  assert.match(messageSandboxEscalateCard, /Run without sandbox/);
});

test("ChatView delegates Composio and MCP confirmations to MessageComposioConfirmCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageComposioConfirmCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageComposioConfirmCard";/);
  assert.match(assistantMessageBody, /<ComposioConfirmCard action=\{action\}/);
  assert.doesNotMatch(chatView, /function ComposioConfirmCard\(/);
  assert.doesNotMatch(chatView, /function parseComposioConfirm\(/);
  assert.doesNotMatch(chatView, /COMPOSIO_CONFIRM_RE/);
  assert.doesNotMatch(chatView, /from "\.\/ChatMessageMarkerParser";/);
  assert.match(assistantMessageBody, /from "\.\/ChatMessageMarkerParser";/);
  assert.match(chatMessageMarkerParser, /export function parseComposioConfirm/);
  assert.match(chatMessageMarkerParser, /COMPOSIO_CONFIRM_RE/);
  assert.match(chatMessageMarkerParser, /MCP_CONFIRM_RE/);
  assert.match(chatMessageMarkerParser, /SANDBOX_ESCALATE_RE/);
  assert.doesNotMatch(chatView, /const COMPOSIO_FIELD_LABELS:/);
  assert.doesNotMatch(chatView, /const OPAQUE_FIELD_KEYS =/);
  assert.doesNotMatch(chatView, /function humanizeFieldKey\(/);
  assert.doesNotMatch(chatView, /function humanizeToolName\(/);
  assert.match(messageComposioConfirmCard, /export interface ComposioPendingAction/);
  assert.match(messageComposioConfirmCard, /export function ComposioConfirmCard/);
  assert.match(messageComposioConfirmCard, /export function humanizeToolName/);
  assert.match(messageComposioConfirmCard, /coreBridge\.composioExecute/);
  assert.match(messageComposioConfirmCard, /coreBridge\.mcpExecute/);
  assert.match(messageComposioConfirmCard, /confirmDestructiveAction/);
});

test("ChatView delegates capability suggestions to MessageConnectSuggestCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageConnectSuggestCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageConnectSuggestCard";/);
  assert.match(assistantMessageBody, /<ConnectSuggestCard[\s\S]*suggest=\{connectSuggest\}/);
  assert.doesNotMatch(chatView, /function ConnectSuggestCard\(/);
  assert.doesNotMatch(chatView, /function ConnectSuggestRow\(/);
  assert.doesNotMatch(chatView, /const CONNECT_KIND_META:/);
  assert.match(messageConnectSuggestCard, /export interface ConnectSuggest/);
  assert.match(messageConnectSuggestCard, /export function ConnectSuggestCard/);
  assert.match(messageConnectSuggestCard, /coreBridge\.mcpConnect/);
  assert.match(messageConnectSuggestCard, /coreBridge\.catalogInstall/);
  assert.match(messageConnectSuggestCard, /connectComposioToolkit/);
});

test("ChatView delegates vault proposal rendering to MessageVaultProposeCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageVaultProposeCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageVaultProposeCard";/);
  assert.match(assistantMessageBody, /<VaultProposeCard[\s\S]*proposal=\{vaultPropose\}/);
  assert.doesNotMatch(chatView, /function VaultProposeCard\(/);
  assert.match(messageVaultProposeCard, /export interface VaultProposal/);
  assert.match(messageVaultProposeCard, /export function VaultProposeCard/);
  assert.match(messageVaultProposeCard, /coreBridge\.vaultProposalAccept/);
  assert.match(messageVaultProposeCard, /coreBridge\.vaultProposalDismiss/);
  assert.match(messageVaultProposeCard, /Similar Vault record exists/);
});

test("composer.css exclusively owns the compact prompt geometry", () => {
  assert.match(
    main,
    /import "\.\/styles\/chat\.css";\s*import "\.\/styles\/composer\.css";/,
  );
  for (const selector of [
    ".composer-surface",
    ".composer-prompt-row",
    ".composer-metadata-row",
    ".composer-model-button",
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(composerStyles, new RegExp(escaped));
    assert.doesNotMatch(
      legacyStyles,
      new RegExp(`(?:^|[},])\\s*${escaped}\\s*(?=[,{])`, "m"),
    );
  }
  assert.match(composerStyles, /min-height:\s*44px/);
  assert.match(composerStyles, /border-radius:\s*(?:var\([^)]*10[^)]*\)|10px)/);
  assert.match(composerStyles, /text-overflow:\s*ellipsis/);
  assert.equal((`${legacyStyles}\n${composerStyles}`.match(/\.composer-model-button\s*\{/g) ?? []).length, 1);
});

test("shared menus keep compact commands separate from descriptive rows", () => {
  assert.match(
    menus,
    /\.menu-surface\s*\{[\s\S]*?padding:\s*6px;/,
  );
  assert.match(
    menus,
    /\.menu-item\s*\{[\s\S]*?height:\s*32px;[\s\S]*?min-height:\s*32px;/,
  );
  assert.match(
    composerStyles,
    /\.composer-menu-list \.menu-item:has\(\.menu-item__label small\)\s*\{[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*44px;/,
  );
  assert.match(
    composerStyles,
    /\.composer-menu-list \.menu-item__label small\s*\{[\s\S]*?line-height:\s*1\.3;/,
  );
});

test("sidebar hover and active states share one stable full-row surface", () => {
  assert.match(
    sidebarStyles,
    /\.drawer-thread-row:hover \.drawer-thread-main,[\s\S]*?\.drawer-thread-row:focus-within \.drawer-thread-main\s*\{[\s\S]*?background:\s*var\(--surface-hover\);/,
  );
  assert.match(
    sidebarStyles,
    /\.drawer-thread-actions\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/,
  );
  assert.match(
    sidebarStyles,
    /\.drawer-thread-row\s*\{[\s\S]*?min-height:\s*30px;/,
  );
  assert.match(
    sidebarStyles,
    /\.drawer-project-row:hover,[\s\S]*?\.drawer-project-row:focus-within\s*\{/,
  );
  assert.doesNotMatch(sidebarStyles, /\.drawer-project:focus-within/);
});

test("composer spacing keeps prompt and metadata compact but distinct", () => {
  assert.match(
    composerStyles,
    /\.composer-surface\s*\{[\s\S]*?margin:\s*6px auto 10px;[\s\S]*?gap:\s*8px;/,
  );
  assert.match(
    composerStyles,
    /\.composer-metadata-row\s*\{[\s\S]*?padding:\s*0 4px;/,
  );
});

test("composer keeps prior effective-model provenance separate from the next-turn override", () => {
  assert.match(chatView, /lastAssistantEffectiveModel/);
  assert.match(useChatTurnSubmissionHook, /threadMessages[\s\S]*?role\s*===\s*"assistant"[\s\S]*?\.model/);
  assert.match(composerShell, /selectedNextTurnModel/);
  assert.match(composerShell, /effectiveModelLabel/);
  assert.match(composerShell, /composerModelButtonLabel/);
  assert.doesNotMatch(composerShell, /modelButtonLabel:\s*string/);
  assert.doesNotMatch(chatView, /const modelButtonLabel = selectedModel[\s\S]*?activeModel[\s\S]*?effectiveModelLabel;/);
  assert.doesNotMatch(
    composerShell,
    /effectiveModelLabel\s*=\s*[^\n]*selectedNextTurnModel/,
  );
});

test("runtime context trigger is icon-only while retaining accessible text", () => {
  assert.match(
    composerShell,
    /id="composer-runtime-trigger"[\s\S]*?className="composer-runtime-button"[\s\S]*?aria-label=\{t\("composer\.runtimeContext"\)\}[\s\S]*?title=\{t\("composer\.runtimeContext"\)\}/,
  );
  assert.doesNotMatch(
    composerShell,
    /id="composer-runtime-trigger"[\s\S]*?<span>\{t\("composer\.runtimeContext"\)\}<\/span>/,
  );
  assert.match(composerStyles, /\.composer-runtime-button\s*\{[\s\S]*?width:\s*26px;[\s\S]*?justify-content:\s*center;/);
});

test("composer reducer delegates Add children to exclusive nested-layer state", () => {
  assert.match(
    composerShell,
    /action\.type === "open-nested"[\s\S]*?openLayer\(state, action\.id, null, true\)/,
  );
  assert.match(composerShell, /openNested\("files"\)/);
  assert.match(composerShell, /openNested\("models"\)/);
  assert.match(
    composerShell,
    /const childOpen = \(id: string\) => menuState\.chain\[1\] === id/,
  );
  for (const child of ["files", "capabilities", "connectors", "models"]) {
    assert.match(
      composerShell,
      new RegExp(`open=\\{rootOpen\\(\"add\"\\) && childOpen\\(\"${child}\"\\)\\}`),
    );
  }
});

test("accepted submissions reset every next-turn model while rejected submissions retain it", () => {
  assert.match(composerContainer, /selectedModelAfterSubmission\(current, accepted\)/);
  assert.doesNotMatch(
    composerContainer,
    /if \(accepted && suggestedModel && modelOverride === suggestedModel\.value\) \{\s*setSelectedModel\(null\)/,
  );
});

test("assistant model provenance uses only gateway effective_model evidence", () => {
  assert.match(useChatTurnSubmissionHook, /effectiveModelFromGateway\(result\.effective_model\)/);
  assert.match(chatView, /latestAssistantEffectiveModel\(threadMessages\)/);
  assert.doesNotMatch(
    chatView,
    /result\.effective_model \?\?[\s\S]*?activeModelInfo\?\.model/,
  );
});

test("IconButton exposes its label and semantic tooltip", () => {
  assert.match(iconButton, /aria-label=\{label\}/);
  assert.match(iconButton, /role="tooltip"/);
  assert.match(iconButton, /className="ui-tooltip"/);
  assert.match(menus, /\.ui-icon-button:focus\s*>\s*\.ui-tooltip/);
});

test("IconButton static markup composes descriptions and exposes badge context once", async () => {
  const server = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  try {
    const { IconButton } = await server.ssrLoadModule("/src/components/ui/IconButton.tsx");
    const withoutPressed = renderToStaticMarkup(React.createElement(
      IconButton,
      { label: "Models" },
      "M",
    ));
    assert.doesNotMatch(withoutPressed, /aria-pressed=/);

    const markup = renderToStaticMarkup(React.createElement(
      IconButton,
      {
        label: "Models",
        pressed: false,
        tooltip: "Choose model",
        badge: "2",
        badgeLabel: "2 models need attention",
        "aria-describedby": "external-description",
      },
      "M",
    ));
    assert.match(markup, /aria-label="Models"/);
    assert.match(markup, /aria-pressed="false"/);
    assert.match(markup, /class="ui-icon-button__badge" aria-hidden="true">2<\/span>/);

    const describedBy = markup.match(/aria-describedby="([^"]+)"/)?.[1].split(" ") ?? [];
    const tooltipId = markup.match(/role="tooltip" class="ui-tooltip" id="([^"]+)"/)?.[1];
    const badgeDescriptionId = markup.match(
      /id="([^"]+)" class="ui-visually-hidden">2 models need attention<\/span>/,
    )?.[1];
    assert.deepEqual(describedBy, ["external-description", tooltipId, badgeDescriptionId]);

    const derivedBadgeMarkup = renderToStaticMarkup(React.createElement(
      IconButton,
      { label: "Notifications", badge: 3 },
      "N",
    ));
    assert.match(derivedBadgeMarkup, /class="ui-visually-hidden">3<\/span>/);
    assert.match(derivedBadgeMarkup, /aria-describedby="[^"]+"/);
  } finally {
    await server.close();
  }
});

test("IconButton badge text meets small-text contrast in every theme", () => {
  const danger = legacyStyles.match(/--danger:\s*(#[0-9a-f]{6});/i)?.[1];
  const badge = menus.match(/\.ui-icon-button__badge\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  const foreground = badge.match(/color:\s*(#[0-9a-f]{3,6});/i)?.[1];
  assert.ok(danger && foreground, "badge foreground and danger colors must be explicit");

  const luminance = (hex) => {
    const normalized = hex.length === 4
      ? hex.slice(1).split("").map((digit) => digit.repeat(2)).join("")
      : hex.slice(1);
    const channels = normalized.match(/../g).map((value) => Number.parseInt(value, 16) / 255);
    const linear = channels.map((value) => (
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    ));
    return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
  };
  const contrast = (Math.max(luminance(danger), luminance(foreground)) + 0.05)
    / (Math.min(luminance(danger), luminance(foreground)) + 0.05);
  assert.ok(contrast >= 4.5, `expected at least 4.5:1 contrast, received ${contrast.toFixed(2)}:1`);
});

test("MenuSurface portals a labeled same-chain surface with menu semantics by default", () => {
  assert.match(menuSurface, /createPortal/);
  assert.match(menuSurface, /data-menu-chain=\{chainId\}/);
  assert.match(menuSurface, /surfaceRole\s*=\s*"menu"/);
  assert.match(menuSurface, /role=\{surfaceRole\}/);
  assert.match(menuSurface, /aria-label=\{label\}/);
});

test("MenuSurface delegates interaction and placement decisions to tested helpers", () => {
  for (const helper of [
    "computeMenuPlacement",
    "enabledMenuItemIndexes",
    "createPlacementRefreshScheduler",
    "getMenuKeyboardAction",
    "getRovingTabIndexes",
    "initialMenuFocusTarget",
    "menuPlacementChanged",
    "menuPlacementEvents",
    "observeGeometryChanges",
    "observeSubtreeContentChanges",
    "shouldAssignInitialMenuFocus",
    "shouldDismissMenuPointer",
    "shouldRenderMenu",
    "shouldRestoreMenuFocus",
  ]) {
    assert.match(menuSurface, new RegExp(`\\b${helper}\\b`));
  }
  assert.match(menuSurface, /shouldRestoreMenuFocus\(parentId, portalIds\)/);
  assert.doesNotMatch(menuSurface, /!open \|\| parentId != null/);
});

test("MenuSurface re-establishes roving state before search focus after every render", () => {
  const focusEffect = menuSurface.match(
    /useLayoutEffect\(\(\) => \{\s*if \(!open \|\| placement\.visibility !== "visible"\)[\s\S]*?\n  \}\);/,
  )?.[0] ?? "";
  assert.match(focusEffect, /applyRovingTabIndexes\(allItems, items, tabIndexes\);/);
  assert.doesNotMatch(focusEffect, /\.focus\(\)/);
  assert.match(menuSurface, /tabIndex=\{-1\}/);
});

test("MenuSurface measures unclipped content when recomputing placement", () => {
  assert.match(menuSurface, /const menuHeight = menu\.scrollHeight;/);
  assert.match(menuSurface, /placementRefresh\.refresh\(\);/);
  assert.match(menuSurface, /placementRefresh\.cancel\(\);/);
  assert.match(menuSurface, /document\.getElementById\(parentId\)/);
  assert.match(menuSurface, /\[anchorRef\.current, menuRef\.current, parentMenu\]/);
  assert.match(menuSurface, /observeGeometryChanges/);
  assert.match(menuSurface, /observeSubtreeContentChanges/);
  assert.match(menuSurface, /menuPlacementChanged/);
});

test("IconButton keeps child tooltips fixed, measured, and non-interactive", () => {
  assert.match(iconButton, /computeTooltipPlacement/);
  assert.match(iconButton, /observeGeometryChanges/);
  assert.match(menus, /\.ui-tooltip\s*\{[\s\S]*position:\s*fixed;/);
  assert.match(menus, /\.ui-tooltip\s*\{[\s\S]*pointer-events:\s*none;/);
});

test("the foundation uses native typography and the compact spacing scale", () => {
  assert.match(
    foundation,
    /--font-sans:\s*-apple-system,\s*BlinkMacSystemFont[^;]*;/,
  );
  assert.match(foundation, /--space-1:\s*4px;/);
  assert.match(foundation, /--space-2:\s*8px;/);
  assert.match(foundation, /--space-3:\s*12px;/);
  assert.match(foundation, /--space-4:\s*16px;/);
  assert.match(foundation, /--space-6:\s*24px;/);
});

test("the foundation defines compact control and motion tokens", () => {
  assert.match(foundation, /--control-height:\s*30px;/);
  assert.match(foundation, /--icon-size:\s*16px;/);
  assert.match(foundation, /--radius-control:\s*7px;/);
  assert.match(foundation, /--radius-panel:\s*10px;/);
  assert.match(foundation, /--motion-fast:\s*120ms;/);
});

test("the foundation preserves unmigrated legacy values", () => {
  assert.match(foundation, /--s1:\s*4px;/);
  assert.match(foundation, /--s2:\s*8px;/);
  assert.match(foundation, /--s3:\s*12px;/);
  assert.match(foundation, /--s4:\s*16px;/);
  assert.match(foundation, /--s5:\s*20px;/);
  assert.match(foundation, /--s6:\s*24px;/);
  assert.match(foundation, /--radius:\s*8px;/);
  assert.match(foundation, /--radius-card:\s*14px;/);
  assert.match(foundation, /--radius-lg:\s*18px;/);
});

test("interactive elements share fast color transitions", () => {
  assert.match(foundation, /:where\([^)]*\[role="menuitem"\][^)]*\)/);
  assert.match(foundation, /color\s+var\(--motion-fast\)\s+ease/);
  assert.match(foundation, /background-color\s+var\(--motion-fast\)\s+ease/);
  assert.match(foundation, /border-color\s+var\(--motion-fast\)\s+ease/);
  assert.match(foundation, /opacity\s+var\(--motion-fast\)\s+ease/);
});

test("the foundation respects reduced motion", () => {
  assert.match(reducedMotion, /animation-duration:/);
  assert.match(reducedMotion, /animation-iteration-count:/);
  assert.match(reducedMotion, /scroll-behavior:/);
  assert.match(reducedMotion, /transition-duration:/);
});

// ── Plan goal + step_advance contracts ──────────────────────────────────────

const planGoalModule = await readFile(
  new URL("../src/lib/chat-runtime/planGoal.mjs", import.meta.url),
  "utf8",
);
const stepAdvanceDisplayModule = await readFile(
  new URL("../src/lib/chat-runtime/stepAdvanceDisplay.mjs", import.meta.url),
  "utf8",
);
const messageStepAdvance = await readFile(
  new URL("../src/components/MessageStepAdvance.tsx", import.meta.url),
  "utf8",
);
const planStepPulseHook = await readFile(
  new URL("../src/components/usePlanStepPulse.ts", import.meta.url),
  "utf8",
);
const appTypes = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");

test("parsePlanGoal pins the **Goal**: line contract and stays robust without it", () => {
  assert.match(planGoalModule, /\^\\\*\\\*Goal\\\*\\\*:\\s\*\(\.\+\)\$\/m/);
  assert.match(planGoalModule, /export function parsePlanGoal\(markdown\)/);
  assert.match(chatPayloadParsers, /export \{ parsePlanGoal \} from "\.\.\/lib\/chat-runtime\/planGoal";/);
  assert.match(kernelProjectionPresenterModule, /parsePlanGoal/);
  assert.match(chatActivityProjectionHook, /workspacePlanGoal/);
  assert.doesNotMatch(chatActivityProjectionHook, /parsePlanGoal/);
  assert.doesNotMatch(chatView, /parsePlanGoal/);
});

test("parsePlanSteps keeps the backticked step id for step_advance matching", () => {
  assert.match(planStepsModule, /\(\?:\\\(\`\(\[\^`\]\*\)\`\\\)\)\?/);
  assert.match(chatPayloadParsers, /type PlanStep/);
  assert.match(kernelProjectionPresenterModule, /projectPlanSteps/);
  assert.doesNotMatch(chatActivityProjectionHook, /parsePlanSteps/);
});

test("the plan goal renders above the step list via the objective pattern", () => {
  assert.match(workspaceIslandSections, /planGoal: string \| null;/);
  assert.match(workspaceIslandSections, /chat\.planGoal/);
  assert.match(workspaceIslandSections, /projectObjective \?\? planGoal/);
  assert.match(workspaceIslandSections, /workspace-island-objective/);
  assert.match(chatWorkspaceDock, /planGoal=\{planGoal\}/);
  assert.match(chatView, /planGoal=\{workspacePlanGoal\}/);
  assert.doesNotMatch(chatView, /workspace-island-objective/);
});

test("the step_advance wire payload is typed end to end", () => {
  assert.match(coreBridge, /export interface StepAdvancePayload/);
  assert.match(coreBridge, /\{ type: "step_advance"; request_id: string; payload: StepAdvancePayload; seq\?: number \}/);
  assert.match(appTypes, /\{ type: "step_advance"; payload: StepAdvancePayload \}/);
  assert.match(appTypes, /StepAdvancePayload,/);
  assert.match(chatEventPartsImpl, /case "step_advance":/);
  assert.match(chatEventPartsImpl, /isValidStepAdvancePayload/);
  assert.match(appCoreMappers, /type === "step_advance"/);
});

test("step_advance display mapping owns the localized label selection", () => {
  assert.match(stepAdvanceDisplayModule, /export function stepAdvanceDisplay/);
  assert.match(stepAdvanceDisplayModule, /chat\.stepAdvance\.verified/);
  assert.match(stepAdvanceDisplayModule, /chat\.stepAdvance\.unverified/);
  assert.match(stepAdvanceDisplayModule, /chat\.stepAdvance\.unverifiedNoNote/);
  assert.match(stepAdvanceDisplayModule, /chat\.stepAdvance\.transition/);
});

test("step_advance events render as visible transcript notes", () => {
  assert.match(messageStepAdvance, /export function StepAdvanceNote/);
  assert.match(messageStepAdvance, /step-advance-note/);
  assert.match(messageStepAdvance, /stepAdvanceDisplay/);
  assert.match(assistantMessageBody, /from "\.\/MessageStepAdvance";/);
  assert.match(assistantMessageBody, /<StepAdvanceNote key=\{`step-advance-\$\{index\}`\} payload=\{part\.payload\}/);
  assert.doesNotMatch(chatView, /StepAdvanceNote/);
});

test("step_advance pulses the matching plan step in the island", () => {
  assert.match(planStepPulseHook, /export function usePlanStepPulse/);
  assert.match(planStepPulseHook, /listenChatStreamEvent/);
  assert.match(chatView, /usePlanStepPulse/);
  assert.match(chatView, /planStepPulseId=\{planStepPulseId\}/);
  assert.match(workspaceIslandSections, /plan-step-pulse/);
  assert.match(workspaceIslandStyles, /plan-step-pulse/);
});

test("the plan goal and step_advance labels are localized in every catalog", async () => {
  for (const lng of ["it", "en", "de", "es", "fr"]) {
    const catalog = JSON.parse(
      await readFile(new URL(`../src/i18n/locales/${lng}.json`, import.meta.url), "utf8"),
    );
    assert.ok(typeof catalog.chat.planGoal === "string" && catalog.chat.planGoal, `${lng}: chat.planGoal`);
    assert.ok(catalog.chat.stepAdvance.verified.includes("{{title}}"), `${lng}: verified label interpolates title`);
    assert.ok(catalog.chat.stepAdvance.unverified.includes("{{note}}"), `${lng}: unverified label interpolates note`);
    assert.ok(catalog.chat.stepAdvance.unverifiedNoNote.includes("{{title}}"), `${lng}: noteless label interpolates title`);
    assert.ok(catalog.chat.stepAdvance.transition.includes("{{from}}"), `${lng}: transition label interpolates from`);
    assert.ok(catalog.chat.stepAdvance.transition.includes("{{to}}"), `${lng}: transition label interpolates to`);
  }
});
