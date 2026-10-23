/**
 * Avvio ed esecuzione di un lavoro confermato (Fonte=motore).
 *
 * La UI non sceglie mai l'esecutore: chiede al motore di avviare il lavoro
 * («start», con la modalità di autonomia) e legge un'unica vista dello stato.
 * Sintesi, lettura, confronto o run adattivo li decide il motore dall'accordo.
 */
import type { AutonomyLevel } from "@/components/builder/conversation-preferences";
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import {
  DEFAULT_WORKSPACE_ID,
  defaultLocalActor,
  domainFetch,
  postEngineCommand,
} from "./engine-domain-client.ts";
import { homunErrorFromHttp } from "./homun-errors.ts";

export type ExecutionStatus =
  | "not_started"
  | "pending_approval"
  | "queued"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export type ExecutionArtifact = { id: string; version: number; title: string; content: string };

export type WorkExecution = {
  work_id: string;
  work_status: string;
  work_version: number;
  agreement_status: string | null;
  id: string | null;
  kind: string | null;
  status: ExecutionStatus;
  digest: string | null;
  expected_version: number | null;
  error_code: string | null;
  material_ids: string[];
  artifact: ExecutionArtifact | null;
};

export type ExecutionView = {
  id: string;
  kind: string;
  status: ExecutionStatus;
  digest?: string;
  expected_version?: number;
  error_code?: string;
  auto_started?: boolean;
};

/** Stati in cui il motore sta lavorando: la UI rilegge finché non cambiano. */
export const EXECUTION_IN_FLIGHT: readonly ExecutionStatus[] = ["queued", "running"];

async function request<T>(
  workId: string,
  suffix: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await domainFetch(
    `/v1/workspaces/${DEFAULT_WORKSPACE_ID}/works/${encodeURIComponent(workId)}${suffix}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Homun-Actor-Id": defaultLocalActor().id,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    },
    ENGINE_DEFAULT_BASE_URL,
    60_000,
  );
  const result = await response.json();
  if (!response.ok)
    throw homunErrorFromHttp(response.status, result, "Esecuzione del lavoro non disponibile");
  return result as T;
}

export function getWorkExecution(workId: string, signal?: AbortSignal): Promise<WorkExecution> {
  return request(workId, "/execution", undefined, signal);
}

/** Il motore sceglie come eseguire il lavoro; la modalità decide se parte subito. */
export function startWork(
  workId: string,
  mode: AutonomyLevel,
  commandId: string = crypto.randomUUID(),
): Promise<ExecutionView> {
  return request(workId, "/start", { command_id: commandId, mode });
}

/** «Avvia» su un'esecuzione in attesa del via libera, qualunque esecutore sia. */
export function approveExecution(
  workId: string,
  execution: { id: string; digest: string; expected_version: number },
  commandId: string = crypto.randomUUID(),
): Promise<ExecutionView> {
  return request(workId, `/executions/${encodeURIComponent(execution.id)}/approve`, {
    command_id: commandId,
    digest: execution.digest,
    expected_version: execution.expected_version,
  });
}

/** Revisione del risultato: approvazione o richiesta di correzione motivata. */
export async function reviewWorkResult(input: {
  workId: string;
  expectedVersion: number;
  artifactId: string;
  decision: "approve" | "request_changes";
  comment?: string;
}): Promise<void> {
  await postEngineCommand({
    type: "work.review",
    payload: {
      work_id: input.workId,
      expected_version: input.expectedVersion,
      artifact_version_id: input.artifactId,
      decision: input.decision,
      comment: input.comment ?? "",
    },
    actor: defaultLocalActor(),
  });
}
