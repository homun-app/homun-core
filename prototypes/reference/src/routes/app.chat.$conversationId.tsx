import { createFileRoute } from "@tanstack/react-router";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/hooks/useWorkspace";
import { getPlugin } from "@/lib/plugins";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { HomunMark } from "@/components/brand/Wordmark";

export const Route = createFileRoute("/app/chat/$conversationId")({
  component: ChatThread,
});

const SUGGESTIONS = [
  "Cosa fanno i miei concorrenti in questo momento?",
  "Controlla questa pagina e dimmi cosa è cambiato",
  "Prepara un sollecito gentile per una fattura scaduta",
];

function ChatThread() {
  const { conversationId } = Route.useParams();
  const { activeProject, canWrite } = useWorkspace();
  const [initial, setInitial] = useState<UIMessage[] | null>(null);
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setInitial(null);
    void (async () => {
      const { data } = await supabase
        .from("messages")
        .select("id,external_id,role,parts")
        .eq("conversation_id", conversationId)
        .order("created_at");
      if (cancelled) return;
      setInitial(
        (data ?? []).map((row) => ({
          id: row.external_id ?? row.id,
          role: row.role as UIMessage["role"],
          parts: row.parts as UIMessage["parts"],
        }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: async () => {
          const { data } = await supabase.auth.getSession();
          return { Authorization: `Bearer ${data.session?.access_token ?? ""}` };
        },
        body: () => ({ projectId: activeProject?.id, conversationId }),
      }),
    [activeProject?.id, conversationId]
  );

  if (!initial) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Carico la conversazione…
      </div>
    );
  }

  return (
    <ChatSurface
      key={conversationId}
      conversationId={conversationId}
      initialMessages={initial}
      transport={transport}
      input={input}
      setInput={setInput}
      textareaRef={textareaRef}
      canWrite={canWrite}
    />
  );
}

function ChatSurface({
  conversationId,
  initialMessages,
  transport,
  input,
  setInput,
  textareaRef,
  canWrite,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
  transport: DefaultChatTransport<UIMessage>;
  input: string;
  setInput: (v: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  canWrite: boolean;
}) {
  const { messages, sendMessage, status } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
    onError: (error) =>
      toast.error("Il bot non ha risposto", {
        description: error.message.slice(0, 180),
      }),
  });

  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    if (!busy) textareaRef.current?.focus();
  }, [busy, conversationId, textareaRef]);

  const sentPendingRef = useRef(false);
  useEffect(() => {
    if (sentPendingRef.current || initialMessages.length > 0) return;
    const key = `homun.pendingPrompt.${conversationId}`;
    const pending = sessionStorage.getItem(key);
    if (!pending) return;
    sessionStorage.removeItem(key);
    sentPendingRef.current = true;
    void supabase
      .from("messages")
      .insert({ conversation_id: conversationId, role: "user", parts: [{ type: "text", text: pending }] })
      .then(() => sendMessage({ text: pending }));
  }, [conversationId, initialMessages.length, sendMessage]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");
    const first = messages.length === 0;
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      parts: [{ type: "text", text: trimmed }],
    });
    if (first) {
      await supabase
        .from("conversations")
        .update({ title: trimmed.slice(0, 60) })
        .eq("id", conversationId);
    }
    void sendMessage({ text: trimmed });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<HomunMark />}
              title="Come posso aiutarti?"
              description="Scrivi in italiano quello che ti serve: userò le funzioni installate nel progetto."
            >
              <div className="mt-4 flex flex-col gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="rounded-xl border border-border bg-background px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </ConversationEmptyState>
          ) : (
            messages.map((message) => (
              <Message key={message.id} from={message.role}>
                <MessageContent>
                  {message.parts.map((part, i) => {
                    if (part.type === "text") {
                      return <MessageResponse key={i}>{part.text}</MessageResponse>;
                    }
                    if (part.type.startsWith("tool-")) {
                      const toolPart = part as {
                        type: string;
                        state?: string;
                        input?: unknown;
                        output?: unknown;
                        errorText?: string;
                      };
                      const name = toolPart.type.replace("tool-", "");
                      return (
                        <Tool key={i} defaultOpen={false}>
                          <ToolHeader
                            type={friendlyToolName(name) as `tool-${string}`}
                            state={(toolPart.state ?? "output-available") as never}
                          />
                          <ToolContent>
                            <ToolInput input={toolPart.input} />
                            <ToolOutput
                              output={toolPart.output ? <ToolResult data={toolPart.output} /> : undefined}
                              errorText={toolPart.errorText}
                            />
                          </ToolContent>
                        </Tool>
                      );
                    }
                    return null;
                  })}
                </MessageContent>
              </Message>
            ))
          )}
          {status === "submitted" && (
            <div className="px-2 py-3">
              <Shimmer>Sto pensando…</Shimmer>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t border-border bg-card/60 px-4 py-4">
        <div className="mx-auto w-full max-w-3xl">
          <PromptInput
            onSubmit={(_message, event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            <PromptInputTextarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                canWrite
                  ? "Scrivi cosa ti serve…"
                  : "Hai accesso in sola lettura a questo progetto"
              }
              disabled={!canWrite}
            />
            <PromptInputFooter className="justify-end">
              <PromptInputSubmit status={status} disabled={!canWrite || !input.trim()} />
            </PromptInputFooter>
          </PromptInput>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Il bot usa solo le funzioni installate nel progetto e ti mostra cosa ha fatto.
          </p>
        </div>
      </div>
    </div>
  );
}

function friendlyToolName(name: string) {
  if (name.startsWith("stato_")) {
    const plugin = getPlugin(name.replace("stato_", ""));
    return `Controllo collegamento ${plugin?.name ?? ""}`.trim();
  }
  return name.replace(/_/g, " ");
}

function ToolResult({ data }: { data: unknown }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
      {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
    </pre>
  );
}
