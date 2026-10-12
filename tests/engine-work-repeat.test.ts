import { test } from "node:test";
import assert from "node:assert/strict";
import {
  engineRepeatDecision,
  repeatEngineWork,
  routineCreatorFor,
} from "../apps/web/src/lib/engine-work-repeat.ts";

const agentPlan = [{ title: "Confronta i listini", assignee_id: "agent_ada" }];
const personPlan = [{ title: "Chat", assignee_id: "person_fabio" }];

test("a completed engine work with a roster-agent plan opens the routine creator", () => {
  assert.deepEqual(
    engineRepeatDecision({
      source: "engine",
      engineStatus: "completed",
      title: "Confronto",
      enginePlan: agentPlan,
    }),
    { kind: "creator" },
  );
});

test("works that are not completed explain what is missing, in product language", () => {
  for (const engineStatus of ["draft", "running", "review"]) {
    const decision = engineRepeatDecision({
      source: "engine",
      engineStatus,
      title: "In corso",
      enginePlan: agentPlan,
    });
    assert.equal(decision.kind, "unsupported");
    assert.match(decision.reason, /complet|consegna/i);
    assert.doesNotMatch(decision.reason, /errore|slice|exception/i);
  }
});

test("works without a roster-agent plan say why they cannot repeat", () => {
  const noPlan = {
    source: "engine" as const,
    engineStatus: "completed" as const,
    title: "Senza piano",
  };
  for (const work of [
    {
      source: "engine" as const,
      engineStatus: "completed" as const,
      title: "Con persona",
      enginePlan: personPlan,
    },
    noPlan,
  ]) {
    const decision = engineRepeatDecision(work);
    assert.equal(decision.kind, "unsupported");
    assert.match(decision.reason, /piano|passagg|agente/i);
  }
});

test("non-engine works never reach the engine creator", () => {
  const decision = engineRepeatDecision({
    source: "simulation",
    title: "Demo",
    enginePlan: agentPlan,
  });
  assert.equal(decision.kind, "unsupported");
});

test("routineCreatorFor eligibility is exactly engineRepeatDecision's, over the whole work table", () => {
  const create = async () => {};
  const works: Parameters<typeof engineRepeatDecision>[0][] = [
    { source: "simulation", title: "Demo" },
    { source: "engine", engineStatus: "running", title: "In corso", enginePlan: agentPlan },
    { source: "engine", engineStatus: "completed", title: "Con persona", enginePlan: personPlan },
    { source: "engine", engineStatus: "completed", title: "Confronto", enginePlan: agentPlan },
  ];
  for (const work of works) {
    assert.equal(
      routineCreatorFor(work, create) !== undefined,
      engineRepeatDecision(work).kind === "creator",
      `eligibility mismatch for ${JSON.stringify(work)}`,
    );
  }
  assert.equal(routineCreatorFor(works[3]!, create), create);
});

test("the repeat action opens Automazioni on the work, or surfaces the reason as a notice", () => {
  const opened: unknown[][] = [];
  const notices: string[] = [];
  repeatEngineWork(
    {
      id: "work_1",
      source: "engine",
      engineStatus: "completed",
      title: "Confronto",
      enginePlan: agentPlan,
    },
    (...args: unknown[]) => opened.push(args),
    (notice: string) => notices.push(notice),
  );
  assert.deepEqual(opened, [["Automazioni", "work_1"]]);
  repeatEngineWork(
    {
      id: "work_2",
      source: "engine",
      engineStatus: "draft",
      title: "Bozza",
      enginePlan: agentPlan,
    },
    () => {},
    (notice: string) => notices.push(notice),
  );
  assert.equal(notices.length, 1);
});
