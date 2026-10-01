/** Stato chat del motore: trascrizione autorizzata + streaming SSE + invio turni.

    Fonte unica: il motore. Nessun fallback di simulazione — gli errori sono
    tipizzati (`HomunClientError`) e salgono alla UI come notice. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createEngineConversationAndWork, postEngineConversationMessage } from "@/lib/conversation-engine-bridge";
import { ENGINE_DEFAULT_BASE_URL } from "@/lib/engine-client";
import { defaultLocalActor } from "@/lib/engine-domain-client";
import { loadEngineTranscript } from "@/lib/engine-transcript-client";
import { HomunClientError, isHomunClientError } from "@/lib/homun-errors";

export type ChatStreamMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const ACTIVE_RUN_STATUSES = new Set([
  "running",
  "queued",
  "proposed",
  "waiting_input",
  "waiting_external",
  "waiting_automation",
]);

const ENGINE_BASE = ENGINE_DEFAULT_BASE_URL;

/**
 * Turni chat di una conversazione del motore.
 *
 * `conversationId` è quello esposto dal work; quando manca (primo messaggio di
 * una chat nuova) la conversazione viene creata qui e usata subito, così lo
 * streaming SSE parte dal primo turno senza aspettare il refresh del work.
 */
export function useChatStream(conversationId: string | undefined) {
  const [serverMessages, setServerMessages] = useState<ChatStreamMessage[]>([]);
  const [pending, setPending] = useState<{ id: string; text: string }[]>([]);
  const [stream, setStream] = useState<{ runId: string; text: string } | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<HomunClientError | null>(null);
  const [localConversationId, setLocalConversationId] = useState<string>();
  const effectiveId = conversationId ?? localConversationId;

  // bolle utente ottimistiche non ancora riechiate dal motore
  const pendingRef = useRef<{ id: string; text: string }[]>([]);
  // run attivi visti via SSE: i run già chiusi vengono riprodotti a connessione
  const activeRunsRef = useRef<Set<string>>(new Set());
  // numero di risposte assistente al momento dell'avvio del run corrente
  const assistantBaselineRef = useRef(0);

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
      }
    } catch {
      /* la prossima riga SSE ritenterà il allineamento */
    }
  }, []);

  // trascrizione iniziale al (ri)collegamento della conversazione
  useEffect(() => {
    if (!effectiveId) return;
    assistantBaselineRef.current = 0;
    pendingRef.current = [];
    setPending([]);
    setStream(null);
    setServerMessages([]);
    void refresh(effectiveId);
  }, [effectiveId, refresh]);

  // stream SSE: parti del run (testo, fine run) e messaggi consegnati
  useEffect(() => {
    if (!effectiveId) return;
    const es = new EventSource(
      `${ENGINE_BASE}/v1/workspaces/ws_local/chat-agent/${encodeURIComponent(effectiveId)}/events?actor=person_fabio`,
    );
    es.addEventListener("open", () => {
      void refresh(effectiveId);
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
      }
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
    es.addEventListener("message", (event) => {
      void refresh(effectiveId);
    });
    es.addEventListener("run_finished", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        run_id: string;
        status: string | null;
      };
      activeRunsRef.current.delete(data.run_id);
      setIsRunning(false);
      if (data.status === "failed") setStream(null);
      void refresh(effectiveId);
    });
    return () => es.close();
  }, [effectiveId, refresh]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setError(null);
      const pendingId = `pending:${Date.now()}`;
      pendingRef.current = [...pendingRef.current, { id: pendingId, text: trimmed }];
      setPending([...pendingRef.current]);
      setIsRunning(true);
      try {
        let cid = effectiveId;
        if (!cid) {
          const created = await createEngineConversationAndWork({
            title: trimmed.slice(0, 40) || "Nuova richiesta",
            objective: trimmed,
            actor: defaultLocalActor(),
          });
          cid = created.conversationId;
          setLocalConversationId(cid);
        }
        await postEngineConversationMessage({
          conversationId: cid,
          text: trimmed,
          actor: defaultLocalActor(),
        });
      } catch (err) {
        setIsRunning(false);
        pendingRef.current = pendingRef.current.filter((p) => p.id !== pendingId);
        setPending([...pendingRef.current]);
        setError(
          isHomunClientError(err)
            ? err
            : new HomunClientError("engine_unavailable", "Invio fallito verso il motore", {
                cause: err,
              }),
        );
      }
    },
    [effectiveId],
  );

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

  return { messages, isRunning, error, send, conversationId: effectiveId };
}
