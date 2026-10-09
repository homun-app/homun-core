import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isRoutineAgentAssignee,
  routineTemplateFromWork,
  workSupportsRoutineTemplate,
} from "../apps/web/src/lib/engine-routines-client.ts";

describe("routine template contract", () => {
  it("accepts plans whose steps are roster agents", () => {
    const work = {
      title: "Confronto listini",
      engineObjective: "Confronta i listini",
      enginePlan: [
        {
          title: "Confronta",
          assignee_id: "agent_ada",
          capability: "compare_csv",
          output_expected: "Report",
        },
      ],
    };
    assert.equal(workSupportsRoutineTemplate(work), true);
    assert.deepEqual(routineTemplateFromWork(work), {
      title: "Confronto listini",
      objective: "Confronta i listini",
      plan_steps: [
        {
          title: "Confronta",
          assignee_id: "agent_ada",
          capability: "compare_csv",
          output_expected: "Report",
        },
      ],
    });
  });

  it("rejects planless works and person-owned steps", () => {
    assert.equal(workSupportsRoutineTemplate({ title: "Vuoto" }), false);
    assert.equal(
      workSupportsRoutineTemplate({
        title: "Con Homun",
        enginePlan: [{ title: "Chat", assignee_id: "person_fabio", capability: "general" }],
      }),
      false,
    );
    assert.equal(isRoutineAgentAssignee("person_fabio"), false);
    assert.equal(isRoutineAgentAssignee(""), false);
    assert.throws(
      () =>
        routineTemplateFromWork({
          title: "Con Homun",
          enginePlan: [{ title: "Chat", assignee_id: "person_fabio", capability: "general" }],
        }),
      /roster agent/,
    );
  });
});
