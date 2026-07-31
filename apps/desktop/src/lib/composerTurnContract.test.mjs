import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveModelFromGateway,
  latestAssistantEffectiveModel,
  selectedModelAfterSubmission,
} from "./composerTurnContract.mjs";

test("every accepted submission consumes its next-turn model override", () => {
  assert.equal(selectedModelAfterSubmission("provider::manual-model", true), null);
  assert.equal(
    selectedModelAfterSubmission("provider::manual-model", false),
    "provider::manual-model",
  );
});

test("missing gateway effective_model never falls back to requested or global models", () => {
  const requestedModel = "provider::requested-model";
  const globalModel = "global-fallback-model";
  const effectiveModel = effectiveModelFromGateway(undefined);

  assert.equal(effectiveModel, null);
  assert.notEqual(effectiveModel, requestedModel);
  assert.notEqual(effectiveModel, globalModel);
});

test("latest assistant without provenance stays unavailable instead of reusing an older model", () => {
  const messages = [
    { role: "assistant", model: "proved-old-model" },
    { role: "user" },
    { role: "assistant" },
  ];

  assert.equal(latestAssistantEffectiveModel(messages), null);
  assert.equal(
    latestAssistantEffectiveModel([...messages, { role: "assistant", model: "proved-new-model" }]),
    "proved-new-model",
  );
});
