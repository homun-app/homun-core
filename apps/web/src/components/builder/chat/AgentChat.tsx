/** Thread della chat su assistant-ui primitives — messaggi e avanzamento.

    Il composer è `StudioChatInput` (selettore modello, autonomia, menzioni):
    la stessa esperienza della chat precedente. Qui si renderizza lo storico
    con markdown, bolle, indicatore di digitazione e — come in Hermes —
    l'avanzamento tool DENTRO la finestra di chat, non sotto il prompt. */
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

import { chatToolLabel } from "./chatToolLabels";
import type { ChatStreamMessage, ChatToolEvent } from "./useChatStream";

const REMARK_PLUGINS = [remarkGfm];

export function AgentChat({
  messages,
  isRunning,
  toolEvents,
  onCancel,
}: {
  messages: ChatStreamMessage[];
  isRunning: boolean;
  toolEvents: ChatToolEvent[];
  onCancel: (() => void) | undefined;
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
      content: [
        ...(msg.reasoning
          ? [{ type: "reasoning" as const, text: msg.reasoning }]
          : []),
        { type: "text" as const, text: msg.content },
      ],
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
          {(isRunning || toolEvents.length > 0) && (
            <ToolProgress events={toolEvents} isRunning={isRunning} onCancel={onCancel} />
          )}
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

/** Avanzamento del run dentro il thread, come i tool chip di Hermes/ChatGPT. */
function ToolProgress({
  events,
  isRunning,
  onCancel,
}: {
  events: ChatToolEvent[];
  isRunning: boolean;
  onCancel: (() => void) | undefined;
}) {
  const visible = events.slice(-3);
  return (
    <div className="mb-6" role="status" aria-live="polite">
      {events.length === 0 && (
        <p className="flex items-center gap-2 py-1 text-xs text-[#9db3ad]">
          <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#9db3ad]" />
          Homun sta riflettendo sul tuo messaggio…
        </p>
      )}
      {visible.map((event) => (
        <p key={event.id} className="flex items-center gap-2 py-0.5 text-xs text-[#5a6b60]">
          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#e8f0ea] text-[9px] text-[#235940]">
            ✓
          </span>
          <span className="font-medium text-[#263832]">{chatToolLabel(event.tool)}</span>
          {event.message ? <span className="min-w-0 truncate">{event.message.slice(0, 90)}</span> : null}
        </p>
      ))}
      {events.length > 3 && (
        <p className="py-0.5 pl-6 text-[11px] text-[#9db3ad]">
          +{events.length - 3} strumenti precedenti
        </p>
      )}
      {isRunning && (
        <p className="mt-1 flex items-center gap-2 text-xs text-[#263832]">
          <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#5c8a75]" />
          Homun sta lavorando…
          {onCancel && (
            <button type="button" className="cs-link ml-1" onClick={onCancel}>
              Annulla
            </button>
          )}
        </p>
      )}
    </div>
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
            components={{ Text: MarkdownText as never, Reasoning: ReasoningBlock as never }}
          />
        </MessagePrimitive.If>
      </div>
    </MessagePrimitive.Root>
  );
}

function ReasoningBlock({ text, state }: { text?: string; state?: { status?: string } }) {
  const running = state?.status === "running";
  return (
    <details className="group mb-1 rounded-lg border border-[#e4ebe4] bg-[#fafcfa] px-3 py-1.5">
      <summary className="cursor-pointer list-none text-[10px] font-medium tracking-wide text-[#8ba39a] uppercase select-none">
        <span className="inline-flex items-center gap-1.5">
          {running && <i className="h-1 w-1 animate-pulse rounded-full bg-[#8ba39a]" />}
          {running ? "Sta ragionando" : "Ragionamento"}
        </span>
      </summary>
      <p className="mt-1.5 max-h-56 overflow-y-auto text-xs whitespace-pre-wrap text-[#6d7f74] italic">
        {text}
      </p>
    </details>
  );
}

function MarkdownText() {
  // remark-gfm: tabelle, liste di controllo, testo barrato — come Hermes.
  // Il testo arriva dal contesto della parte (come MarkdownTextPrimitive nudo).
  return <MarkdownTextPrimitive remarkPlugins={REMARK_PLUGINS} />;
}
