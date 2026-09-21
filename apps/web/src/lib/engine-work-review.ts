/** Human review of a submitted artifact: approve concludes the work (Fonte=motore). */
import { defaultLocalActor, postEngineCommand } from "./engine-domain-client.ts";

export type WorkReviewDecision = "approve" | "request_changes";

export function reviewEngineWork(input: {
  workId: string;
  expectedVersion: number;
  artifactVersionId: string;
  decision: WorkReviewDecision;
  comment?: string;
  commandId?: string;
}): Promise<{ status: string; version: number }> {
  return postEngineCommand({
    type: "work.review",
    payload: {
      work_id: input.workId,
      expected_version: input.expectedVersion,
      artifact_version_id: input.artifactVersionId,
      decision: input.decision,
      ...(input.comment ? { comment: input.comment } : {}),
    },
    ...(input.commandId ? { commandId: input.commandId } : {}),
    actor: defaultLocalActor(),
  }).then((result) => ({
    status: String(result.result["status"] ?? ""),
    version: typeof result.result["version"] === "number" ? result.result["version"] : input.expectedVersion,
  }));
}
