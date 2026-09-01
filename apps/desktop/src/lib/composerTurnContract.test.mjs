import assert from "node:assert/strict";
import test from "node:test";

import {
  autoModelResolutionLabel,
  composerModelButtonLabel,
  effectiveModelFromGateway,
  latestAssistantEffectiveModel,
  modelLabelFromSelection,
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

test("model button labels display the next-turn selection instead of unavailable provenance", () => {
  assert.equal(modelLabelFromSelection("provider-410c::deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(modelLabelFromSelection("plain-model"), "plain-model");
  assert.equal(
    composerModelButtonLabel("Unavailable", "provider-410c::deepseek-v4-pro", "Unavailable", "Auto"),
    "deepseek-v4-pro",
  );
  assert.equal(
    composerModelButtonLabel("Unavailable", null, "Unavailable", "Auto"),
    "Auto",
  );
  assert.equal(
    composerModelButtonLabel("Unavailable", "Unavailable", "Unavailable", "Auto"),
    "Auto",
  );
});

test("auto model button label exposes the resolved runtime route when available", () => {
  assert.equal(
    autoModelResolutionLabel({
      role: "chat",
      provider: "ollama",
      effective_model: "qwen3.5:4b",
    }, "Auto"),
    "Auto -> chat -> ollama/qwen3.5:4b",
  );
  assert.equal(
    composerModelButtonLabel("Unavailable", null, "Unavailable", "Auto", {
      role: "chat",
      provider: "ollama",
      effective_model: "qwen3.5:4b",
    }),
    "Auto -> chat -> ollama/qwen3.5:4b",
  );
  assert.equal(autoModelResolutionLabel({ effective_model: "qwen3.5:4b" }, "Auto"), "Auto -> qwen3.5:4b");
  assert.equal(autoModelResolutionLabel({}, "Auto"), "Auto");
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
