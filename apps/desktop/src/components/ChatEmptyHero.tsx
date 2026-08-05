import { useState } from "react";
import { useTranslation } from "react-i18next";
import { greetingPeriod, selectGreetingKey } from "../lib/chatGreeting";
import { useSetting } from "../lib/settingsStore";
import type { ChatThread } from "../types";
import { ChatUsageOverview } from "./ChatUsageOverview";

export function ChatEmptyHero({
  thread,
  sessionSeed,
  onOpenUsageSettings,
  onUseForTask,
}: {
  thread: ChatThread;
  sessionSeed: string;
  onOpenUsageSettings: () => void;
  onUseForTask: (providerId: string, modelId: string) => void;
}) {
  const { t } = useTranslation();
  const [displayName] = useSetting("displayName", "");
  const [{ greetingKey, period }] = useState(() => {
    const hour = new Date().getHours();
    return {
      greetingKey: selectGreetingKey({
        hour,
        hasName: Boolean(displayName.trim()),
        hasProject: Boolean(thread.workspaceId && thread.workspaceId !== "local-workspace"),
        seed: `${sessionSeed}:${thread.threadId}`,
      }),
      period: greetingPeriod(hour),
    };
  });
  const interpolation = {
    name: displayName.trim(),
    salutation: t(`chat.greetings.period.${period}`),
  };
  const greetingHeadline = t(`${greetingKey}.headline`, interpolation);
  const greetingPrompt = t(`${greetingKey}.prompt`, interpolation);
  return (
    <div className="chat-hero">
      <div className="chat-hero-welcome">
        <h1 className="chat-hero-headline">{greetingHeadline}</h1>
        <p className="chat-hero-prompt">{greetingPrompt}</p>
      </div>
      <ChatUsageOverview
        threadId={thread.threadId}
        onOpenUsageSettings={onOpenUsageSettings}
        onUseForTask={onUseForTask}
      />
    </div>
  );
}
