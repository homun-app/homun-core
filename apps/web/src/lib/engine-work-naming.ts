import { defaultLocalActor, postEngineCommand } from "./engine-domain-client.ts";
export async function renameEngineWork(
  workId: string,
  title: string,
  expectedVersion: number,
): Promise<void> {
  await postEngineCommand({
    type: "work.rename",
    payload: { work_id: workId, title, expected_version: expectedVersion },
    actor: defaultLocalActor(),
  });
}
