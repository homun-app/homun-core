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
): Promise<{ status: string; version: number }> {
  const response = await postEngineCommand({
    type: "work.start",
    payload: { work_id: workId, expected_version: expectedVersion, durable: false },
    actor: defaultLocalActor(),
  });
  const result = response.result as { status?: unknown; version?: unknown };
  return { status: String(result.status ?? ""), version: Number(result.version ?? expectedVersion) };
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

/** Raises or lowers the per-work model budget; only an explicit human act. */
export async function setEngineWorkBudget(
  workId: string,
  expectedVersion: number,
  modelAttempts: number,
): Promise<void> {
  await postEngineCommand({
    type: "work.set_budget",
    payload: {
      work_id: workId,
      expected_version: expectedVersion,
      caps: { model_attempts: modelAttempts },
    },
    actor: defaultLocalActor(),
  });
}

/** Adds or removes a plan phase; succeeded phases are historical and stay. */
export async function reviseEnginePlan(input: {
  workId: string;
  expectedVersion: number;
  insertAfterStepId?: string | null;
  newStep?: { title: string; assigneeId: string; capability?: string; outputExpected?: string };
  removeStepId?: string;
}): Promise<void> {
  await postEngineCommand({
    type: "plan.revise",
    payload: {
      work_id: input.workId,
      expected_version: input.expectedVersion,
      ...(input.newStep
        ? {
            new_step: {
              title: input.newStep.title,
              assignee_id: input.newStep.assigneeId,
              ...(input.newStep.capability ? { capability: input.newStep.capability } : {}),
              ...(input.newStep.outputExpected ? { output_expected: input.newStep.outputExpected } : {}),
            },
            ...(input.insertAfterStepId ? { insert_after_step_id: input.insertAfterStepId } : {}),
          }
        : {}),
      ...(input.removeStepId ? { remove_step_id: input.removeStepId } : {}),
    },
    actor: defaultLocalActor(),
  });
}

/** Sets or clears the person's deadline for a work (ISO date or null). */
export async function setEngineWorkDue(
  workId: string,
  expectedVersion: number,
  dueDate: string | null,
): Promise<void> {
  await postEngineCommand({
    type: "work.set_due",
    payload: { work_id: workId, expected_version: expectedVersion, due_date: dueDate },
    actor: defaultLocalActor(),
  });
}
