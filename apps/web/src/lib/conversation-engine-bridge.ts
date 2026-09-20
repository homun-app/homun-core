/**
 * Pure bridge between engine domain records and simulation-era Work UI shapes.
 * Explicit source tagging — never treat engine rows as IndexedDB simulation data.
 */

import type { Phase, Work, ConversationMessage } from "../components/builder/conversation-types.ts";
import {
  defaultLocalActor,
  postEngineCommand,
  postEngineCommandStream,
  type EngineActor,
} from "./engine-domain-client.ts";
import { listEngineAgents } from "./engine-agents-client.ts";
import {
  formatInterpretationForUi,
  parseInterpretation,
  parseWorkPatchProposal,
  type MessageInterpretation,
  type WorkPatchProposal,
} from "./interpretation-display.ts";

export type EngineWorkRecord = {
  id: string;
  title: string;
  objective: string;
  status: string;
  version: number;
  primary_conversation_id: string;
  project_id?: string | null;
  requester_id?: string;
  reviewer_id?: string | null;
  current_plan_revision: number;
  current_artifact_version: number;
  pending_contribution?: {
    id: string;
    to_actor_id: string;
    need: string;
    status: string;
    step_id: string;
  } | null;
};

export function parseEngineWorkRecord(raw: Record<string, unknown>): EngineWorkRecord {
  const record: EngineWorkRecord = {
    id: String(raw["id"] ?? ""),
    title: String(raw["title"] ?? "Senza titolo"),
    objective: String(raw["objective"] ?? ""),
    status: String(raw["status"] ?? "draft"),
    version: typeof raw["version"] === "number" ? raw["version"] : 1,
    primary_conversation_id: String(raw["primary_conversation_id"] ?? ""),
    current_plan_revision:
      typeof raw["current_plan_revision"] === "number" ? raw["current_plan_revision"] : 0,
    current_artifact_version:
      typeof raw["current_artifact_version"] === "number" ? raw["current_artifact_version"] : 0,
  };
  if (raw["project_id"] != null) {
    record.project_id = String(raw["project_id"]);
  } else if ("project_id" in raw) {
    record.project_id = null;
  }
  if (raw["requester_id"] != null) {
    record.requester_id = String(raw["requester_id"]);
  }
  if (raw["reviewer_id"] != null) {
    record.reviewer_id = String(raw["reviewer_id"]);
  } else if ("reviewer_id" in raw) {
    record.reviewer_id = null;
  }
  const pending = raw["pending_contribution"];
  if (pending && typeof pending === "object") {
    const p = pending as Record<string, unknown>;
    record.pending_contribution = {
      id: String(p["id"] ?? ""),
      to_actor_id: String(p["to_actor_id"] ?? ""),
      need: String(p["need"] ?? ""),
      status: String(p["status"] ?? "pending"),
      step_id: String(p["step_id"] ?? ""),
    };
  }
  return record;
}

/** Map engine WorkStatus to the closest simulation Phase for chrome labels. */
export function mapEngineStatusToPhase(status: string): Phase {
  switch (status) {
    case "draft":
      return "proposal";
    case "ready":
    case "running":
    case "paused":
      return "ready";
    case "waiting_input":
      return "waiting";
    case "waiting_approval":
    case "review":
      return "review";
    case "completed":
      return "approved";
    case "failed":
    case "cancelled":
      return "approved";
    default:
      return "proposal";
  }
}

export function isEngineBackedWork(work: Work | null | undefined): boolean {
  return work?.source === "engine";
}

export function engineWorkToUiWork(
  record: EngineWorkRecord,
  messages?: ConversationMessage[],
): Work {
  const statusLine = `Fonte motore · stato ${record.status} · v${record.version}`;
  const objectiveLine = record.objective
    ? `Obiettivo: ${record.objective}`
    : "Obiettivo non ancora specificato.";
  const seeded: ConversationMessage[] =
    messages !== undefined
      ? messages
      : [
          {
            who: "agent",
            sender: "Homun",
            text: `${statusLine}\n${objectiveLine}\nQuesto lavoro è sul dominio SQLite del motore. Le azioni di simulazione restano disabilitate.`,
          },
        ];
  const work: Work = {
    id: record.id,
    title: record.title,
    scenario: 0,
    phase: mapEngineStatusToPhase(record.status),
    due: "",
    messages: seeded,
    files: [],
    contribution: "",
    revision: record.version,
    feedback: "",
    source: "engine",
    engineConversationId: record.primary_conversation_id,
    engineStatus: record.status,
    engineObjective: record.objective,
    enginePlanRevision: record.current_plan_revision,
    engineArtifactVersion: record.current_artifact_version,
    requester: "Fabio",
    reviewer: "Fabio",
  };
  if (record.project_id) {
    work.projectId = record.project_id;
  }
  if (record.pending_contribution) {
    work.engineContributionRequestId = record.pending_contribution.id;
    work.request = {
      to:
        record.pending_contribution.to_actor_id === "person_fabio"
          ? "Fabio"
          : record.pending_contribution.to_actor_id,
      need: record.pending_contribution.need,
      status: record.pending_contribution.status === "pending" ? "pending" : "resolved",
    };
  }
  return work;
}

export async function createEngineConversationAndWork(input: {
  title: string;
  objective: string;
  actor?: EngineActor;
}): Promise<{ conversationId: string; workId: string; record: EngineWorkRecord }> {
  const actor = input.actor ?? defaultLocalActor();
  const title = input.title.trim() || "Conversazione motore";
  const objective = input.objective.trim() || title;
  const created = await postEngineCommand({
    type: "conversation.create",
    payload: { title },
    actor,
  });
  const conversationId = String(created.result["conversation_id"] ?? "");
  if (!conversationId) {
    throw new Error("Engine did not return conversation_id");
  }
  const workResult = await postEngineCommand({
    type: "work.create",
    payload: {
      conversation_id: conversationId,
      title,
      objective,
    },
    actor,
  });
  const workId = String(workResult.result["work_id"] ?? "");
  if (!workId) {
    throw new Error("Engine did not return work_id");
  }
  return {
    conversationId,
    workId,
    record: {
      id: workId,
      title,
      objective,
      status: String(workResult.result["status"] ?? "draft"),
      version: typeof workResult.result["version"] === "number" ? workResult.result["version"] : 1,
      primary_conversation_id: conversationId,
      current_plan_revision: 0,
      current_artifact_version: 0,
    },
  };
}

export async function postEngineConversationMessage(input: {
  conversationId: string;
  text: string;
  actor?: EngineActor;
  roster?: Array<{ id: string; display_name: string; kind: "person" | "agent" | "other" }>;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  onPhase?: (phase: string) => void;
}): Promise<{
  messageId: string;
  assistantMessageId: string;
  interpretation: MessageInterpretation | null;
  assistantText: string;
  patchProposal: WorkPatchProposal | null;
}> {
  const actor = input.actor ?? defaultLocalActor();
  let roster = input.roster;
  if (!roster) {
    const person = {
      id: actor.id,
      display_name: actor.displayName?.trim() || actor.id,
      kind: "person" as const,
    };
    try {
      const agents = await listEngineAgents();
      roster = [
        person,
        ...agents
          .filter((agent) => agent.status === "active" || agent.status === "draft")
          .map((agent) => ({
            id: agent.id,
            display_name: agent.name,
            kind: "agent" as const,
          })),
      ];
    } catch {
      roster = [person];
    }
  }
  const commandInput = {
    type: "conversation.post_message",
    payload: {
      conversation_id: input.conversationId,
      text: input.text,
      roster,
    },
    actor,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const result =
    input.onToken || input.onPhase
      ? await postEngineCommandStream(commandInput, {
          ...(input.onToken ? { onToken: input.onToken } : {}),
          ...(input.onPhase ? { onPhase: input.onPhase } : {}),
        })
      : await postEngineCommandStream(commandInput);
  const interpretation = parseInterpretation(result.result["interpretation"]);
  const patchProposal = parseWorkPatchProposal(result.result["patch_proposal"]);
  const assistantText =
    typeof result.result["assistant_text"] === "string"
      ? result.result["assistant_text"]
      : interpretation
        ? formatInterpretationForUi(interpretation)
        : "Interpretazione non disponibile dal motore.";
  return {
    messageId: String(result.result["message_id"] ?? ""),
    assistantMessageId: String(result.result["assistant_message_id"] ?? ""),
    interpretation,
    assistantText,
    patchProposal,
  };
}

export async function applyEngineWorkPatch(input: {
  workId: string;
  expectedVersion: number;
  changes: WorkPatchProposal["changes"];
  actor?: EngineActor;
  signal?: AbortSignal;
}): Promise<{ version: number }> {
  const actor = input.actor ?? defaultLocalActor();
  const result = await postEngineCommand({
    type: "work.apply_patch",
    payload: {
      work_id: input.workId,
      expected_version: input.expectedVersion,
      changes: input.changes,
    },
    actor,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    version: typeof result.result["version"] === "number" ? result.result["version"] : input.expectedVersion + 1,
  };
}

/** Map a completed engine reply into the shared conversation message shape. */
export function assistantFromPosted(posted: {
  assistantMessageId?: string;
  assistantText: string;
  patchProposal: WorkPatchProposal | null;
}): ConversationMessage {
  return {
    who: "agent",
    sender: "Homun",
    ...(posted.assistantMessageId ? { engineMessageId: posted.assistantMessageId } : {}),
    text: posted.assistantText,
    ...(posted.patchProposal
      ? {
          patchProposal: {
            work_id: posted.patchProposal.work_id,
            base_version: posted.patchProposal.base_version,
            changes: posted.patchProposal.changes,
            summary_lines: posted.patchProposal.summary_lines,
          },
        }
      : {}),
  };
}

