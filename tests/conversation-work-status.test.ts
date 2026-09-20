import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDemoMode } from "../apps/web/src/components/builder/conversation-demo-query.ts";
import {
  isCompletedNoticeForViewer,
  isPendingForViewer,
  workStatusLabel,
} from "../apps/web/src/components/builder/conversation-work-status.ts";
import { initialScenarios } from "../apps/web/src/components/builder/conversation-scenarios.ts";
import type { Work } from "../apps/web/src/components/builder/conversation-types.ts";

function sampleWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "w1",
    title: "Test",
    scenario: 0,
    phase: "waiting",
    due: "",
    messages: [],
    files: [],
    contribution: "",
    revision: 0,
    feedback: "",
    ...overrides,
  };
}

describe("resolveDemoMode", () => {
  it("detects busy and materials modes", () => {
    assert.equal(resolveDemoMode("?work-demo=busy").storageKey, "busy");
    assert.equal(resolveDemoMode("?work-demo=busy&edition=complete").storageKey, "complete");
    assert.equal(resolveDemoMode("?materials-demo=large").storageKey, "materials");
    assert.equal(resolveDemoMode("").storageKey, "normal");
  });
});

describe("workStatusLabel", () => {
  it("reports pending contribution request", () => {
    const label = workStatusLabel(
      sampleWork({ request: { to: "Fabio", need: "listini", status: "pending" } }),
      initialScenarios,
      undefined,
    );
    assert.equal(label, "Aspetta Fabio");
  });

  it("uses phase text for agent work", () => {
    assert.equal(
      workStatusLabel(sampleWork({ phase: "review" }), initialScenarios, undefined),
      "Da verificare",
    );
  });
});

describe("notification helpers", () => {
  it("marks waiting work pending for requester", () => {
    assert.equal(
      isPendingForViewer(
        sampleWork({ phase: "waiting", requester: "Fabio" }),
        "Fabio",
        initialScenarios,
        undefined,
      ),
      true,
    );
  });

  it("surfaces completed result notices once", () => {
    assert.equal(
      isCompletedNoticeForViewer(
        sampleWork({ phase: "approved", requester: "Fabio" }),
        "Fabio",
        true,
        [],
      ),
      true,
    );
    assert.equal(
      isCompletedNoticeForViewer(
        sampleWork({ phase: "approved", requester: "Fabio" }),
        "Fabio",
        true,
        ["Fabio:w1"],
      ),
      false,
    );
  });
});
