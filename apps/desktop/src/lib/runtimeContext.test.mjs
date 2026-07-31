import assert from "node:assert/strict";
import test from "node:test";
import { runtimeContextView } from "./runtimeContext.mjs";

const unavailableContributions = {
  conversation: null,
  compacted_summary: null,
  files_artifacts: null,
  authorized_memory: null,
  system_tools: null,
};

test("effective model is independent from next-turn selection", () => {
  const view = runtimeContextView({
    effective_model: "used-model",
    used_input_tokens: 8_000,
    context_window: 32_000,
    contributions: unavailableContributions,
  }, "next-model");

  assert.equal(view.effectiveModel, "used-model");
  assert.equal(view.selectedNextModel, "next-model");
  assert.equal(view.percent, 25);
});

test("missing values remain unavailable rather than zero", () => {
  const view = runtimeContextView({
    effective_model: null,
    used_input_tokens: null,
    context_window: null,
    contributions: { ...unavailableContributions, authorized_memory: null },
  }, null);

  assert.equal(view.usedTokens, null);
  assert.equal(view.contextWindow, null);
  assert.equal(view.percent, null);
  assert.equal(view.contributions.authorizedMemory, null);
});

test("percentage requires a finite numerator and positive denominator and clamps to 0-100", () => {
  const response = { contributions: unavailableContributions };
  assert.equal(runtimeContextView({ ...response, used_input_tokens: 1, context_window: 0 }, null).percent, null);
  assert.equal(runtimeContextView({ ...response, used_input_tokens: null, context_window: 10 }, null).percent, null);
  assert.equal(runtimeContextView({ ...response, used_input_tokens: -5, context_window: 10 }, null).percent, 0);
  assert.equal(runtimeContextView({ ...response, used_input_tokens: 15, context_window: 10 }, null).percent, 100);
});

test("contribution estimates preserve their provenance", () => {
  const view = runtimeContextView({
    contributions: {
      ...unavailableContributions,
      conversation: { estimated_tokens: 120, source: "prompt_snapshot_estimate" },
      system_tools: { estimated_tokens: 40, source: "provider_reported" },
    },
  }, null);

  assert.deepEqual(view.contributions.conversation, {
    estimatedTokens: 120,
    source: "prompt_snapshot_estimate",
  });
  assert.deepEqual(view.contributions.systemTools, {
    estimatedTokens: 40,
    source: "provider_reported",
  });
});

test("view exposes only the redacted runtime contract", () => {
  const view = runtimeContextView({
    run_id: "run-secret",
    turn_id: "turn-secret",
    effective_model: "model",
    provider: "provider",
    locality: "local",
    role: "coding",
    context_window: 4_096,
    used_input_tokens: 1_024,
    compacted: true,
    contributions: unavailableContributions,
    prompt: "secret prompt",
    path: "/secret/path",
    memory: "secret memory",
    price: 99,
    hash: "secret hash",
    base_url: "https://secret.example",
  }, "next-model");

  assert.deepEqual(Object.keys(view).sort(), [
    "compacted",
    "contextWindow",
    "contributions",
    "effectiveModel",
    "locality",
    "percent",
    "provider",
    "role",
    "selectedNextModel",
    "usedTokens",
  ]);
  assert.doesNotMatch(JSON.stringify(view), /secret|run-secret|turn-secret/);
});
