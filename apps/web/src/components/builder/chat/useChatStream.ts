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
  const [stream, setStream] = useState<{ runId: string; text: string } | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [toolEvents, setToolEvents] = useState<ChatToolEvent[]>([]);

  // bolle utente ottimistiche non ancora riechiate dal motore
  const pendingRef = useRef<{ id: string; text: string }[]>([]);
  // run attivi visti via SSE: i run già chiusi vengono riprodotti a connessione
  const activeRunsRef = useRef<Set<string>>(new Set());
  // attività tool già viste: alla riconnessione il motore ripete le osservazioni
  const seenToolsRef = useRef<Set<string>>(new Set());
  // numero di risposte assistente al momento dell'avvio del run corrente
  const assistantBaselineRef = useRef(0);
  // il prop definito viste finora: definito -> undefined = nuova conversazione
  const hadConversationRef = useRef(false);

  const refresh = useCallback(async (id: string) => {
    try {
      const transcript = await loadEngineTranscript(id);
      const next = transcript.map((m, index) => ({
        id: m.engineMessageId ?? `srv:${index}`,
        role: (m.who === "you" ? "user" : "assistant") as "user" | "assistant",
        content: m.text,
      }));
      // cala le bolle ottimistiche ormai presenti nella trascrizione
      const echoed = new Set(
        next.filter((m) => m.role === "user").map((m) => m.content.trim()),
      );
      pendingRef.current = pendingRef.current.filter(
        (p) => !echoed.has(p.text.trim()),
      );
      setPending([...pendingRef.current]);
      setServerMessages(next);
      // la risposta consegnata sostituisce la bolla in streaming
      const answers = next.filter((m) => m.role === "assistant").length;
      if (answers > assistantBaselineRef.current) {
        assistantBaselineRef.current = answers;
        setStream(null);
        setToolEvents([]);
      }
    } catch {
      /* la prossima riga SSE ritenterà l'allineamento */
    } finally {
      setHistoryLoading(false);
    }
  }, []);

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
    setPending([...pendingRef.current]);
  }, []);

  const messages = useMemo<ChatStreamMessage[]>(
    () => [
      ...serverMessages,
      ...pending.map((p) => ({ id: p.id, role: "user" as const, content: p.text })),
      ...(stream
        ? [{ id: `stream:${stream.runId}`, role: "assistant" as const, content: stream.text }]
        : []),
    ],
    [serverMessages, pending, stream],
  );

  return { messages, isRunning, historyLoading, toolEvents, noteUserSent };
}
