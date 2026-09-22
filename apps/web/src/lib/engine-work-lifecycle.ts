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
