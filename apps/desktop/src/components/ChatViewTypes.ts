import type {
  ChatAttachmentInput,
  CoreUncertainEffectOutcome,
  RoutingBindingInput,
} from "../lib/coreBridge";
import type {
  ApprovelItem,
  ChatAttachment,
  ChatMessage,
  ChatThread,
  UncertainEffectItem,
} from "../types";

export interface ChatViewProps {
  // When the sidebar is collapsed, the chat header hosts the reopen + search controls (as
  // no-drag children of the drag titlebar, so their clicks aren't swallowed).
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  onOpenSearch?: () => void;
  onOpenUsageSettings: () => void;
  approvals: ApprovelItem[];
  approvalBusyId: string | null;
  uncertainEffects: UncertainEffectItem[];
  effectResolutionBusyId: string | null;
  effectResolutionError: string | null;
  computerSessionId: string;
  messages: ChatMessage[];
  thread: ChatThread;
  onMessagesChange: (
    messages: ChatMessage[],
    options?: { advanceActivity?: boolean },
  ) => void;
  onResolveEffect: (
    effect: UncertainEffectItem,
    outcome: CoreUncertainEffectOutcome,
  ) => void;
  onApproveApprovel: (
    approvalId: string,
    options?: {
      scope?: "once" | "always";
      browser_visibility?: "auto" | "visible" | "headless";
    },
  ) => void;
  onRejectApprovel: (approvalId: string) => void;
  onRuntimeChanged: () => void | Promise<void>;
  onThreadChanged: () => void | Promise<void>;
  onStreamingChange?: (busy: boolean) => void;
  islandRefreshNonce?: number;
  // Bumps the island projection refresh nonce (owned by App). Used by the
  // streaming cancel closures to re-fetch the activity projection after the
  // cancel DELETE settles. Unlike the activity nonce, it never opens the island.
  bumpIslandRefreshNonce?: () => void;
  runtimeContextRevision: number;
  incomingBackgroundTurn?: {
    turnId: string;
    threadId: string;
    userMessageId: string;
    assistantMessageId: string;
  } | null;
  seed?: { text: string; nonce: number } | null;
  autoSubmit?: ChatAutoSubmit | null;
  onAutoSubmitConsumed?: (id: string) => void;
}

export interface ReplyContext {
  messageId: string;
  role: ChatMessage["role"];
  preview: string;
}

export type MessageFeedback = NonNullable<ChatMessage["feedback"]>;

export interface ChatAutoSubmit {
  id: string;
  threadId: string;
  prompt: string;
  visibleText: string;
  attachments: ChatAttachmentInput[];
  visibleAttachments?: ChatAttachment[];
  mode?: string;
  // S2: deterministic routing binding for a plugin workflow launch (e.g. "Use
  // template"). Rides only this first auto-submitted turn — the gateway persists
  // it thread-scoped, so later turns in the thread don't resend it.
  routingBinding?: RoutingBindingInput;
}
