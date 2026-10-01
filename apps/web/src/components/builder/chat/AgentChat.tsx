/** Thread della chat su assistant-ui primitives — solo i messaggi.

    Il composer è `StudioChatInput` (selettore modello, autonomia, menzioni):
    la stessa esperienza della chat precedente. Qui si renderizza lo storico
    con markdown, bolle e indicatore di digitazione. */
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

import type { ChatStreamMessage } from "./useChatStream";

const REMARK_PLUGINS = [remarkGfm];

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
    convertMessage: (msg) => ({
      id: msg.id,
      role: msg.role,
      content: [{ type: "text" as const, text: msg.content }],
    }),
    adapters: {},
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
        <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto">
          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage }}
          />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mb-4 flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[#182b26] px-4 py-2.5 text-sm text-[#f4f1ee]">
        <MessagePrimitive.Content />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mb-6">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-medium tracking-wide text-[#9db3ad] uppercase">
          Homun
        </span>
      </div>
      <div className="mt-1 rounded-2xl rounded-bl-md border border-[#dce4d5] bg-white px-4 py-3 text-sm text-[#263832] [&_a]:text-[#235940] [&_a]:underline [&_code]:rounded [&_code]:bg-[#f6f8f3] [&_code]:px-1 [&_code]:font-mono [&_code]:text-[11px] [&_pre]:mt-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[#dce4d5] [&_pre]:bg-[#f6f8f3] [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[11px] [&_table]:w-full [&_table]:text-xs [&_th]:border [&_th]:border-[#dce4d5] [&_th]:bg-[#f6f8f3] [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-[#dce4d5] [&_td]:px-2 [&_td]:py-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_strong]:font-semibold">
        <MessagePrimitive.If hasContent={false}>
          <span className="inline-flex items-center gap-1 py-1" aria-label="Homun sta scrivendo">
            <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#9db3ad]" />
            <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#9db3ad] [animation-delay:150ms]" />
            <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#9db3ad] [animation-delay:300ms]" />
          </span>
        </MessagePrimitive.If>
        <MessagePrimitive.If hasContent>
          <MessagePrimitive.Content
            components={{ Text: MarkdownText as never }}
          />
        </MessagePrimitive.If>
      </div>
    </MessagePrimitive.Root>
  );
}

function MarkdownText() {
  // remark-gfm: tabelle, liste di controllo, testo barrato — come Hermes.
  // Il testo arriva dal contesto della parte (come MarkdownTextPrimitive nudo).
  return <MarkdownTextPrimitive remarkPlugins={REMARK_PLUGINS} />;
}
