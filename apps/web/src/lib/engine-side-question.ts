/** Side question (/btw) handler: queries an engine agent run without mutating the main transcript. */
import {
  listAgentRuns,
  sideQuestionAgentRun,
  type SideQuestionResult,
} from "./engine-agent-run-client.ts";

export async function askEngineSideQuestion(
  workId: string,
  question: string,
): Promise<SideQuestionResult> {
  const runs = await listAgentRuns(workId);
  if (!runs || runs.length === 0) {
    throw new Error(
      "Nessuna esecuzione attiva o recente trovata per questo lavoro. Avvia prima il lavoro per porre domande a margine (/btw).",
    );
  }
  // Prioritize active runs, otherwise take the latest run
  const activeRun =
    runs.find((r) =>
      ["running", "waiting_input", "waiting_external", "paused"].includes(r.status),
    ) ?? runs[runs.length - 1];

  if (!activeRun) {
    throw new Error("Nessuna esecuzione idonea per la domanda a margine.");
  }

  return await sideQuestionAgentRun(workId, activeRun.id, question);
}
