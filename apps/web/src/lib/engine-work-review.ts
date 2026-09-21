/** Human review of a submitted artifact: approve concludes the work (Fonte=motore). */
import { defaultLocalActor, postEngineCommand } from "./engine-domain-client.ts";

import { HomunClientError } from "./homun-errors.ts";

export type WorkReviewDecision = "approve" | "request_changes";

export function reviewEngineWork(input: {
  workId: string;
  expectedVersion: number;
  artifactVersionId: string;
  decision: WorkReviewDecision;
  comment?: string;
  commandId?: string;
}): Promise<{ status: string; version: number }> {
  const comment = input.comment?.trim();
  if (input.decision === "request_changes" && !comment) {
    throw new HomunClientError("validation_error", "Descrivi le correzioni richieste");
  }
  return postEngineCommand({
    type: "work.review",
    payload: {
      work_id: input.workId,
      expected_version: input.expectedVersion,
      artifact_version_id: input.artifactVersionId,
      decision: input.decision,
      ...(comment ? { comment } : {}),
    },
    ...(input.commandId ? { commandId: input.commandId } : {}),
    actor: defaultLocalActor(),
  }).then((result) => ({
    status: String(result.result["status"] ?? ""),
    version: typeof result.result["version"] === "number" ? result.result["version"] : input.expectedVersion,
  }));
}
