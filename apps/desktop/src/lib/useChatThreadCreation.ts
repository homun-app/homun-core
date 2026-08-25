import type { Dispatch, SetStateAction } from "react";
import {
  coreBridge,
  type ChatAttachmentInput,
  type ProactivitySuggestion,
  type RoutingBindingInput,
  type TemplateCatalogEntry,
} from "./coreBridge";
import {
  currentTimestampSeconds,
  mapCoreChatMessage,
  mapCoreChatThread,
  pendingChatAttachmentFromInput,
  summarizeThreadTitle,
} from "./appCoreMappers";
import { buildProactivityChatSeed } from "./proactivityChatSeed";
import { buildTemplateWorkflowAutoSubmit } from "./templateWorkflowPrompt";
import type { ChatAttachment, ChatMessage, ChatThread, ViewId } from "../types";

// Owns every path that creates or seeds a chat thread from outside the transcript.
export interface PendingTemplateAutoSubmit {
  id: string;
  threadId: string;
  prompt: string;
  visibleText: string;
  attachments: ChatAttachmentInput[];
  visibleAttachments?: ChatAttachment[];
  mode?: string;
  routingBinding?: RoutingBindingInput;
}

export function useChatThreadCreation({
  personalWorkspaceId,
  setChatThreads,
  setThreadMessages,
  setActiveThreadId,
  setActiveView,
  setThreadMessagesFromBackend,
  setPendingTemplateAutoSubmit,
}: {
  personalWorkspaceId: string;
  setChatThreads: Dispatch<SetStateAction<ChatThread[]>>;
  setThreadMessages: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>;
  setActiveThreadId: Dispatch<SetStateAction<string>>;
  setActiveView: (view: ViewId) => void;
  setThreadMessagesFromBackend: (
    threadId: string,
    incomingMessages: ChatMessage[],
    options?: { force?: boolean },
  ) => void;
  setPendingTemplateAutoSubmit: Dispatch<
    SetStateAction<PendingTemplateAutoSubmit | null>
  >;
}) {
  async function handleCreateteChatThread(workspaceId?: string) {
    try {
      const targetWorkspace = workspaceId?.trim();
      if (targetWorkspace) {
        await coreBridge.selectWorkspace(targetWorkspace);
        const created = mapCoreChatThread(
          await coreBridge.createChatThread(targetWorkspace),
        );
        await coreBridge.selectChatThread(created.threadId);
        window.location.reload();
        return;
      }
      const created = mapCoreChatThread(await coreBridge.createChatThread());
      const messages = await coreBridge.chatMessages(created.threadId);
      setChatThreads((current) => [
        created,
        ...current.filter((thread) => thread.threadId !== created.threadId),
      ]);
      setThreadMessages((current) => ({
        ...current,
        [created.threadId]: messages.messages.map(mapCoreChatMessage),
      }));
      setActiveThreadId(created.threadId);
      setActiveView("chat");
    } catch (error) {
      console.warn("create_chat_thread unavailable", error);
    }
  }

  async function handleOpenSuggestion(suggestion: ProactivitySuggestion) {
    const { workspaceId, question, seedEventParts } = buildProactivityChatSeed(
      suggestion,
      personalWorkspaceId,
    );
    try {
      await coreBridge.selectWorkspace(workspaceId);
      const created = mapCoreChatThread(
        await coreBridge.createChatThread(workspaceId),
      );
      const seeded = await coreBridge.seedAssistantMessage(
        created.threadId,
        question,
        seedEventParts,
      );
      setChatThreads((current) => [
        created,
        ...current.filter((thread) => thread.threadId !== created.threadId),
      ]);
      setThreadMessages((current) => ({
        ...current,
        [created.threadId]: seeded.messages.map(mapCoreChatMessage),
      }));
      setActiveThreadId(created.threadId);
      setActiveView("chat");
    } catch (error) {
      console.warn("open_suggestion unavailable", error);
    }
  }

  async function handleStartTemplateWorkflow(input: {
    template: TemplateCatalogEntry;
    attachment?: ChatAttachmentInput;
  }) {
    const workflow = buildTemplateWorkflowAutoSubmit(input);
    try {
      const created = mapCoreChatThread(await coreBridge.createChatThread());
      const messages = await coreBridge.chatMessages(created.threadId);
      const timestamp = currentTimestampSeconds();
      setChatThreads((current) => [
        {
          ...created,
          title: summarizeThreadTitle(workflow.visiblePrompt),
          messageCount: Math.max(created.messageCount, messages.messages.length),
          updatedAt: timestamp,
        },
        ...current.filter((thread) => thread.threadId !== created.threadId),
      ]);
      setThreadMessagesFromBackend(
        created.threadId,
        messages.messages.map(mapCoreChatMessage),
      );
      setActiveThreadId(created.threadId);
      setActiveView("chat");
      setPendingTemplateAutoSubmit({
        id: `template_auto_submit_${created.threadId}_${Date.now()}`,
        threadId: created.threadId,
        prompt: workflow.operativePrompt,
        visibleText: workflow.visiblePrompt,
        attachments: input.attachment ? [input.attachment] : [],
        visibleAttachments: input.attachment
          ? [pendingChatAttachmentFromInput(input.attachment)]
          : undefined,
        mode: "plan",
        routingBinding: workflow.routingBinding,
      });
    } catch (error) {
      console.warn("start_template_workflow unavailable", error);
    }
  }

  return {
    handleCreateteChatThread,
    handleOpenSuggestion,
    handleStartTemplateWorkflow,
  };
}
