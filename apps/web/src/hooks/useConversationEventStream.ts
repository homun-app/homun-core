/** Consuma il flusso SSE della conversazione: la chat in streaming a parti. */
import { useEffect, useRef, useState } from "react";
import { ENGINE_DEFAULT_BASE_URL } from "@/lib/engine-client.ts";
import { DEFAULT_WORKSPACE_ID, defaultLocalActor } from "@/lib/engine-domain-client.ts";

export type StreamToolEvent = {
  tool: string;
  message: string;
};

export type ConversationStreamState = {
  connected: boolean;
  /** testo completo dell'ultimo turno in streaming (think incluso) */
  answerText: string;
  /** blocco <think> separato */
  thinking: string;
  /** risposta visibile senza il thinking */
  visibleText: string;
  tools: StreamToolEvent[];
  runActive: boolean;
  runStatus: string | null;
};

const EMPTY: ConversationStreamState = {
  connected: false, answerText: "", thinking: "", visibleText: "",
  tools: [], runActive: false, runStatus: null,
};

function splitThink(text: string): { thinking: string; visible: string } {
  // il run puo' lasciare il solo tag di chiusura: tutto ciò che lo precede è ragionamento
  const orphanClose = text.indexOf("</think>");
  if (orphanClose !== -1) {
    const before = text.slice(0, orphanClose);
    const after = splitThink(text.slice(orphanClose + 8));
    const beforeParts = splitThink(before.replace(/<think>/g, ""));
    return {
      thinking: (beforeParts.thinking + beforeParts.visible + after.thinking).trim(),
      visible: after.visible,
    };
  }
  const open = text.indexOf("<think>");
  if (open === -1) return { thinking: "", visible: text };
  const rest = splitThink(text.slice(open + 7));
  return { thinking: (text.slice(0, open) + rest.thinking).trim(), visible: rest.visible };
}

export function useConversationEventStream(
  conversationId: string | null | undefined,
  { onNewMessage }: { onNewMessage?: () => void } = {},
): ConversationStreamState {
  const [state, setState] = useState<ConversationStreamState>(EMPTY);
  const onNewMessageRef = useRef(onNewMessage);
  onNewMessageRef.current = onNewMessage;

  useEffect(() => {
    if (!conversationId) {
      setState(EMPTY);
      return;
    }
    const actor = defaultLocalActor().id;
    const source = new EventSource(
      `${ENGINE_DEFAULT_BASE_URL}/v1/workspaces/${DEFAULT_WORKSPACE_ID}` +
        `/chat-agent/${encodeURIComponent(conversationId)}/events?actor=${encodeURIComponent(actor)}`,
    );
    let answer = "";
    let tools: StreamToolEvent[] = [];
    let runActive = false;
    let runStatus: string | null = null;

    const recompute = (connected: boolean) =>
      setState((prev) => {
        const { thinking, visible } = splitThink(answer);
        return { connected, answerText: answer, thinking, visibleText: visible,
                 tools: [...tools], runActive, runStatus: runStatus ?? prev.runStatus };
      });

    source.onopen = () => recompute(true);
    source.addEventListener("run_started", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { status: string };
      runActive = true;
      runStatus = data.status;
      answer = "";
      tools = [];
      recompute(true);
    });
    source.addEventListener("text_delta", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { delta: string };
      answer += data.delta;
      recompute(true);
    });
    source.addEventListener("tool_result", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as StreamToolEvent;
      tools = [...tools, { tool: data.tool ?? "?", message: data.message ?? "" }];
      recompute(true);
    });
    source.addEventListener("run_finished", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { status: string };
      runActive = false;
      runStatus = data.status;
      recompute(true);
    });
    source.addEventListener("message", (event) => {
      recompute(true);
      onNewMessageRef.current?.();
    });
    source.onerror = () => {
      // il server chiuso o rete giù: EventSource riprova da solo
      setState((prev) => ({ ...prev, connected: false }));
    };
    return () => source.close();
  }, [conversationId]);

  return state;
}
