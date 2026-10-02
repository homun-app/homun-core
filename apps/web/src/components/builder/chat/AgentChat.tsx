/** Thread della chat sugli elementi ufficiali assistant-ui, presi così come sono.

    Il composer resta `StudioChatInput` (selettore modello, autonomia,
    menzioni): la stessa esperienza Homun, sotto il thread. Qui il rendering
    è quello ufficiale — reasoning collassabile con shimmer, gruppi di
    chiamate tool, markdown con tabelle, azioni copia/rigenera. */
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";

import { Thread } from "@/components/assistant-ui/elements/thread.aui";

import { chatToolLabel } from "./chatToolLabels";
import type { ChatStreamMessage } from "./useChatStream";

function convertMessage(msg: ChatStreamMessage): ThreadMessageLike {
  return {
    id: msg.id,
    role: msg.role,
    content: [
      ...(msg.reasoning
        ? [{ type: "reasoning" as const, text: msg.reasoning }]
        : []),
      ...(msg.tools ?? []).map((tool) => ({
        type: "tool-call" as const,
        toolCallId: tool.id,
        toolName: chatToolLabel(tool.tool),
        result: tool.message || undefined,
      })),
      { type: "text" as const, text: msg.content },
    ],
  };
}

/** Il composer integrato del Thread è sostituito da `StudioChatInput` fuori dal thread. */
const NoComposer = () => null;

export function AgentChat({
  messages,
  isRunning,
}: {
  messages: ChatStreamMessage[];
  isRunning: boolean;
}) {
  const runtime = useExternalStoreRuntime<ChatStreamMessage>({
    isRunning,
    messages,
    onNew: async () => {
      /* l'invio vive nel composer esterno (pipeline engine completa) */
    },
    convertMessage,
    adapters: {},
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread components={{ Composer: NoComposer }} />
    </AssistantRuntimeProvider>
  );
}
