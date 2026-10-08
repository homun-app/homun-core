/** Client for persistent goals and quality gates (H25). */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import { domainFetch } from "./engine-domain-client.ts";
import { homunErrorFromHttp } from "./homun-errors.ts";

export type GoalContract = {
  outcome?: string;
  verification?: string;
  constraints?: string;
  boundaries?: string;
  stop_when?: string;
};

export type GoalGate = {
  gate_id: string;
  command: string;
  description?: string;
  max_retries?: number;
  retries_used?: number;
  passed?: boolean;
};

export type GoalState = {
  session_id: string;
  goal: string;
  status: "active" | "cleared" | "completed" | "failed";
  turns_used: number;
  max_turns?: number | null;
  subgoals?: string[];
  contract?: GoalContract;
  gates?: GoalGate[];
  waiting_on_pid?: number | null;
  waiting_on_session?: string | null;
  waiting_until?: number | null;
  updated_at?: number | null;
};

export async function listEngineGoals(): Promise<GoalState[]> {
  const response = await domainFetch(
    "/v1/goals",
    {
      headers: { Accept: "application/json" },
    },
    ENGINE_DEFAULT_BASE_URL,
    30000
  );
  const result = await response.json();
  if (!response.ok) {
    throw homunErrorFromHttp(response.status, result, "Impossibile recuperare gli obiettivi");
  }
  return result.goals || [];
}

export async function getEngineGoal(sessionId: string): Promise<GoalState> {
  const response = await domainFetch(
    `/v1/goals/${encodeURIComponent(sessionId)}`,
    {
      headers: { Accept: "application/json" },
    },
    ENGINE_DEFAULT_BASE_URL,
    30000
  );
  const result = await response.json();
  if (!response.ok) {
    throw homunErrorFromHttp(response.status, result, "Obiettivo non trovato");
  }
  return result;
}

export async function deleteEngineGoal(sessionId: string): Promise<void> {
  const response = await domainFetch(
    `/v1/goals/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      headers: { Accept: "application/json" },
    },
    ENGINE_DEFAULT_BASE_URL,
    30000
  );
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw homunErrorFromHttp(response.status, result, "Impossibile eliminare l'obiettivo");
  }
}
