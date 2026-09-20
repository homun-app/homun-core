import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyBoardMove,
  boardMoveSuccessMessage,
  validateBoardMove,
} from "../apps/web/src/components/builder/conversation-board-move.ts";
import { initialScenarios } from "../apps/web/src/components/builder/conversation-scenarios.ts";
import type { Work } from "../apps/web/src/components/builder/conversation-types.ts";

function sampleWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "w1",
    title: "Test",
    scenario: 0,
    phase: "review",
    due: "",
    messages: [],
    files: [],
    contribution: "",
    revision: 0,
    feedback: "",
    requester: "Fabio",
    reviewer: "Fabio",
    ...overrides,
  };
}

describe("validateBoardMove", () => {
  it("blocks pending contribution requests", () => {
    const message = validateBoardMove({
      target: sampleWork({
        request: { to: "Vera", need: "listini", status: "pending" },
      }),
      phase: "approved",
      viewer: "Fabio",
      scenarios: initialScenarios,
      removedPeople: undefined,
      profiles: undefined,
    });
    assert.match(message || "", /Vera/);
  });

  it("allows review to approved for the supervisor", () => {
    assert.equal(
      validateBoardMove({
        target: sampleWork(),
        phase: "approved",
        viewer: "Fabio",
        scenarios: initialScenarios,
        removedPeople: undefined,
        profiles: undefined,
      }),
      null,
    );
  });
});

describe("applyBoardMove", () => {
  it("records approval message and clears autoDelivered", () => {
    const next = applyBoardMove(sampleWork({ autoDelivered: true }), "approved", "Fabio");
    assert.equal(next.phase, "approved");
    assert.equal(next.autoDelivered, false);
    assert.equal(next.approvedBy, "Fabio");
    assert.equal(boardMoveSuccessMessage("approved"), "Risultato approvato. Nessuna azione esterna.");
  });
});
