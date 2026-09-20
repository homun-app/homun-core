import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  engineHomunScenario,
  initialScenarios,
  scenarioForWork,
} from "../apps/web/src/components/builder/conversation-scenarios.ts";

describe("scenarioForWork", () => {
  it("uses Homun chrome for engine-backed works even when scenario index is 0", () => {
    const chrome = scenarioForWork({ source: "engine", scenario: 0 }, initialScenarios);
    assert.equal(chrome.agent, "Homun");
    assert.equal(chrome, engineHomunScenario);
  });

  it("keeps demo agents for simulation works", () => {
    const chrome = scenarioForWork({ source: "simulation", scenario: 0 }, initialScenarios);
    assert.equal(chrome.agent, "Marta");
  });
});
