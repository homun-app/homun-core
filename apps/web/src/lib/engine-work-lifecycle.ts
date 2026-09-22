import { defaultLocalActor, postEngineCommand } from "./engine-domain-client.ts";

/**
 * Closes an agreed work without executing it (engine transition to CANCELLED).
 * The agreement and the conversation stay in the archive; nothing is deleted.
 */
export async function closeEngineWork(
  workId: string,
  expectedVersion: number,
): Promise<void> {
  await postEngineCommand({
    type: "work.cancel",
    payload: { work_id: workId, expected_version: expectedVersion },
    actor: defaultLocalActor(),
  });
}

/**
 * Starts the accepted plan's first pending step (engine transition to RUNNING).
 * Supervised by design: only the person triggers it, never the engine.
 */
export async function startEngineWork(
  workId: string,
  expectedVersion: number,
): Promise<void> {
  await postEngineCommand({
    type: "work.start",
    payload: { work_id: workId, expected_version: expectedVersion, durable: false },
    actor: defaultLocalActor(),
  });
}

/**
 * Delivers the final result of the work (engine transition to REVIEW):
 * the human review that follows is the honest closure with an outcome.
 */
export async function submitEngineArtifact(
  workId: string,
  expectedVersion: number,
  title: string,
  content: string,
): Promise<void> {
  await postEngineCommand({
    type: "work.submit_artifact",
    payload: { work_id: workId, expected_version: expectedVersion, title, content },
    actor: defaultLocalActor(),
  });
}
