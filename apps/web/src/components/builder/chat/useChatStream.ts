/** Stato chat del motore: trascrizione autorizzata + streaming SSE + bolle ottimistiche.

    L'invio NON passa di qui: la pipeline esistente (`handleEngineSend` ->
    `engine.postMessage`) gestisce allegati, autonomia, modello e first-message.
    Qui arrivano solo i suoi effetti: l'eco utente e la risposta via SSE. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ENGINE_DEFAULT_BASE_URL } from "@/lib/engine-client";
import { loadEngineTranscript } from "@/lib/engine-transcript-client";

export type ChatStreamMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  /** Attività tool del run che ha prodotto questo messaggio (solo live). */
  tools?: ChatToolEvent[];
};

/** Attività tool del run attivo, mostrata come avanzamento live. */
export type ChatToolEvent = {
  id: string;
  tool: string;
  message: string;
};

const ACTIVE_RUN_STATUSES = new Set([
  "running",
  "queued",
  "proposed",
  "waiting_input",
  "waiting_external",
  "waiting_automation",
]);

/**
 * Messaggi e streaming di una conversazione del motore.
 *
 * `conversationId` è quello esposto dal work; quando manca (primo messaggio,
 * prima che il work venga aperto) non c'è stream: l'eco arriva appena la
 * conversazione esiste. Quando il prop torna `undefined` dopo essere stato
 * definito (Nuova conversazione) lo stato locale si azzera.
 */
export function useChatStream(conversationId: string | undefined) {
  const [serverMessages, setServerMessages] = useState<ChatStreamMessage[]>([]);
  const [pending, setPending] = useState<{ id: string; text: string }[]>([]);
  const [stream, setStream] = useState<{ runId: string; text: string; reasoning?: string } | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [toolEvents, setToolEvents] = useState<ChatToolEvent[]>([]);

  // bolle utente ottimistiche non ancora riechiate dal motore
  const pendingRef = useRef<{ id: string; text: string }[]>([]);
  // l'eco del motore prende l'id della bolla ottimistica che la rappresenta:
  // il runtime external store aggiorna il nodo esistente invece di creare un
  // branch fantasma (i messaggi rimossi restano nel repository dei branch)
  const echoPendingIdsRef = useRef<Map<string, string[]>>(new Map());
  // run attivi visti via SSE: i run già chiusi vengono riprodotti a connessione
  const activeRunsRef = useRef<Set<string>>(new Set());
  // attività tool già viste: alla riconnessione il motore ripete le osservazioni
  const seenToolsRef = useRef<Set<string>>(new Set());
  // numero di risposte assistente al momento dell'avvio del run corrente
  const assistantBaselineRef = useRef(0);
  // il prop definito viste finora: definito -> undefined = nuova conversazione
  const hadConversationRef = useRef(false);
  // id della bolla streaming corrente: la risposta consegnata lo eredita
  const streamEchoIdRef = useRef<string | null>(null);
  // id stabili assegnati ai messaggi del motore (engineMessageId -> id del nodo)
  const stableIdsRef = useRef<Map<string, string>>(new Map());

  const refresh = useCallback(async (id: string) => {
    try {
      const transcript = await loadEngineTranscript(id);
      // il primo refresh consegna gli id stabili (pending/stream); i refresh
      // successivi ricostruiscono la lista e li riprendono da questo mapping
      const stableIds = stableIdsRef.current;
      const rawEngineIds: (string | null)[] = [];
      const next = transcript.map((m, index) => {
        const role = (m.who === "you" ? "user" : "assistant") as "user" | "assistant";
        const engineId = m.engineMessageId ?? null;
        rawEngineIds.push(engineId);
        let messageId = m.engineMessageId ?? `srv:${index}`;
        if (engineId && stableIds.has(engineId)) {
          messageId = stableIds.get(engineId) as string;
        } else if (role === "user") {
          const queue = echoPendingIdsRef.current.get(m.text.trim());
          if (queue && queue.length > 0) {
            messageId = queue.shift() as string;
            if (engineId) stableIds.set(engineId, messageId);
          }
        }
        return { id: messageId, role, content: m.text };
      });
      // cala le bolle ottimistiche ormai presenti nella trascrizione
      const echoed = new Set(
        next.filter((m) => m.role === "user").map((m) => m.content.trim()),
      );
      pendingRef.current = pendingRef.current.filter(
        (p) => !echoed.has(p.text.trim()),
      );
      setPending([...pendingRef.current]);
      // la risposta consegnata sostituisce la bolla in streaming
      const answers = next.filter((m) => m.role === "assistant").length;
      if (answers > assistantBaselineRef.current) {
        // la prima risposta nuova prende l'id della bolla streaming: il nodo
        // del runtime si aggiorna invece di lasciare un branch fantasma
        const streamId = streamEchoIdRef.current;
        if (streamId) {
          let seen = answers - assistantBaselineRef.current;
          for (let i = next.length - 1; i >= 0 && seen > 0; i--) {
            const message = next[i] as ChatStreamMessage | undefined;
            if (!message || message.role !== "assistant") continue;
            seen -= 1;
            if (seen === 0) {
              next[i] = { ...message, id: streamId };
              const engineId = rawEngineIds[i];
              if (engineId) stableIds.set(engineId, streamId);
            }
          }
          streamEchoIdRef.current = null;
        }
        assistantBaselineRef.current = answers;
        setStream(null);
        setToolEvents([]);
      }
      setServerMessages(next);
    } catch {
      /* la prossima riga SSE ritenterà l'allineamento */
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // la bolla streaming vive finché il run non consegna: il suo id passa alla
  // risposta della trascrizione perché il runtime aggiorni lo stesso nodo
  useEffect(() => {
    streamEchoIdRef.current = stream ? `stream:${stream.runId}` : null;
  }, [stream]);

  // Nuova conversazione: il prop torna undefined dopo essere stato definito.
  useEffect(() => {
    if (conversationId) {
      hadConversationRef.current = true;
      return;
    }
    if (!hadConversationRef.current) return;
    hadConversationRef.current = false;
    pendingRef.current = [];
    activeRunsRef.current.clear();
    seenToolsRef.current.clear();
    assistantBaselineRef.current = 0;
    echoPendingIdsRef.current.clear();
    stableIdsRef.current.clear();
    setPending([]);
    setStream(null);
    setServerMessages([]);
    setIsRunning(false);
    setToolEvents([]);
  }, [conversationId]);

  // trascrizione iniziale al (ri)collegamento della conversazione
  useEffect(() => {
    if (!conversationId) return;
    assistantBaselineRef.current = 0;
    pendingRef.current = [];
    seenToolsRef.current.clear();
    echoPendingIdsRef.current.clear();
    stableIdsRef.current.clear();
    setPending([]);
    setStream(null);
    setServerMessages([]);
    setToolEvents([]);
    setHistoryLoading(true);
    void refresh(conversationId);
  }, [conversationId, refresh]);

  // stream SSE: parti del run (testo, fine run) e messaggi consegnati
  useEffect(() => {
    if (!conversationId) return;
    const es = new EventSource(
      `${ENGINE_DEFAULT_BASE_URL}/v1/workspaces/ws_local/chat-agent/${encodeURIComponent(conversationId)}/events?actor=person_fabio`,
    );
    es.addEventListener("open", () => {
      void refresh(conversationId);
    });
    es.addEventListener("run_started", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        run_id: string;
        status: string | null;
      };
      if (!data.run_id || ACTIVE_RUN_STATUSES.has(String(data.status))) {
        activeRunsRef.current.add(data.run_id);
        setIsRunning(true);
        setStream({ runId: data.run_id, text: "" });
        // nuovo turno: l'avanzamento tool riparte pulito
        seenToolsRef.current.clear();
        setToolEvents([]);
      }
    });
    es.addEventListener("tool_result", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        run_id: string;
        tool: string | null;
        message: string | null;
      };
      if (!activeRunsRef.current.has(data.run_id)) return;
      const tool = String(data.tool || "tool");
      const message = String(data.message || "");
      const id = `${data.run_id}:${tool}:${message}`;
      if (seenToolsRef.current.has(id)) return;
      seenToolsRef.current.add(id);
      setToolEvents((current) => [...current, { id, tool, message }]);
    });
    es.addEventListener("stream_state", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        run_id: string;
        reasoning: string;
        text: string;
      };
      if (!activeRunsRef.current.has(data.run_id)) return;
      setStream((current) =>
        current && current.runId === data.run_id
          ? { ...current, text: data.text, reasoning: data.reasoning }
          : { runId: data.run_id, text: data.text, reasoning: data.reasoning },
      );
    });
    es.addEventListener("text_delta", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        run_id: string;
        delta: string;
        reset?: boolean;
      };
      if (!activeRunsRef.current.has(data.run_id)) return;
      setStream((current) => {
        if (data.reset) return { runId: data.run_id, text: data.delta };
        return current && current.runId === data.run_id
          ? { ...current, text: current.text + data.delta }
          : { runId: data.run_id, text: data.delta };
      });
    });
    es.addEventListener("message", () => {
      void refresh(conversationId);
    });
    es.addEventListener("run_finished", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        run_id: string;
        status: string | null;
      };
      activeRunsRef.current.delete(data.run_id);
      setIsRunning(false);
      if (data.status === "failed") setStream(null);
      void refresh(conversationId);
    });
    return () => es.close();
  }, [conversationId, refresh]);

  /** Bolla utente istantanea: l'eco del motore la cala appena arriva. */
  const noteUserSent = useCallback((text: string) => {
    const entry = { id: `pending:${Date.now()}`, text: text.trim() };
    if (!entry.text) return;
    pendingRef.current = [...pendingRef.current, entry];
    const queue = echoPendingIdsRef.current.get(entry.text) ?? [];
    echoPendingIdsRef.current.set(entry.text, [...queue, entry.id]);
    setPending([...pendingRef.current]);
  }, []);

  const messages = useMemo<ChatStreamMessage[]>(
    () => [
      ...serverMessages,
      ...pending.map((p) => ({ id: p.id, role: "user" as const, content: p.text })),
      // la bolla in streaming compare solo quando ha qualcosa da mostrare:
      // prima del primo token l'attività è indicata dall'hint sotto il thread
      ...(stream && (stream.text || stream.reasoning || toolEvents.length)
        ? [{
            id: `stream:${stream.runId}`,
            role: "assistant" as const,
            content: stream.text,
            ...(stream.reasoning ? { reasoning: stream.reasoning } : {}),
            tools: toolEvents,
          }]
        : []),
    ],
    [serverMessages, pending, stream, toolEvents],
  );

  return {
    messages,
    isRunning,
    historyLoading,
    toolEvents,
    reasoning: stream?.reasoning ?? "",
    noteUserSent,
  };
}
