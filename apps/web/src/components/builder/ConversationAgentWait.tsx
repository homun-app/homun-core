/**
 * Honest in-transcript wait state for a model turn: phase label + elapsed
 * seconds. No fake percentages — it only states what is true: which phase the
 * engine is in and how long the person has been waiting.
 */
import { useEffect, useState } from "react";
import type { AgentWaitPhase } from "./conversation-types";
import "./conversation-agent-wait.css";

const PHASE_LABELS: Record<AgentWaitPhase, string> = {
  reading: "Homun sta leggendo il messaggio…",
  preparing: "Homun sta preparando la proposta di accordo…",
};

export function ConversationAgentWait({
  phase,
  startedAt,
}: {
  phase: AgentWaitPhase;
  startedAt: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <p className="cw-agent-wait" role="status">
      <span className="cw-agent-wait-label">{PHASE_LABELS[phase]}</span>
      <span className="cw-agent-wait-elapsed">{elapsed} s</span>
      {elapsed >= 45 && (
        <span className="cw-agent-wait-note">Il modello può impiegare circa un minuto.</span>
      )}
    </p>
  );
}
