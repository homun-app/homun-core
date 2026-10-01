/** Chat agent montata sulle primitive assistant-ui e nutrita dal motore. */
import { HomunErrorNotice } from "@/components/HomunErrorNotice";

import { AgentChat } from "./AgentChat";
import { useChatStream } from "./useChatStream";

export function EngineAgentChat({
  conversationId,
}: {
  conversationId: string | undefined;
}) {
  const { messages, isRunning, error, send } = useChatStream(conversationId);
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <HomunErrorNotice
        error={error}
        className="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
      />
      <AgentChat messages={messages} isRunning={isRunning} onSend={send} />
    </div>
  );
}
