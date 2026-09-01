import assert from "node:assert/strict";
import test from "node:test";
import { runtimeContextView, runtimeIntegrityView } from "./runtimeContext.mjs";

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

test("runtime integrity view summarizes observability gaps without exposing refs", () => {
  const view = runtimeIntegrityView({
    runtime: {
      integrity_ok: true,
      error_count: 0,
      warning_count: 8,
      observability: {
        summary: { diagnostic_gaps: 3 },
        diagnostic_gaps: [
          {
            code: "run_missing_model_attribution",
            severity: "warning",
            owner: "model_routing",
            summary: "agent run lacks role/model/provider",
            ref: "run-secret",
          },
          {
            code: "turn_without_turn_events",
            owner: "turn_executor",
            summary: "turn lacks durable events",
          },
        ],
      },
    },
  }, 1);

  assert.equal(view.available, true);
  assert.equal(view.healthy, false);
  assert.equal(view.diagnosticGapCount, 3);
  assert.equal(view.visibleDiagnosticGaps.length, 1);
  assert.equal(view.hiddenDiagnosticGapCount, 2);
  assert.deepEqual(view.visibleDiagnosticGaps[0], {
    code: "run_missing_model_attribution",
    severity: "warning",
    owner: "model_routing",
    summary: "agent run lacks role/model/provider",
  });
  assert.doesNotMatch(JSON.stringify(view), /run-secret/);
});

test("runtime integrity view treats missing audit as unavailable", () => {
  const view = runtimeIntegrityView(null);

  assert.equal(view.available, false);
  assert.equal(view.healthy, false);
  assert.equal(view.diagnosticGapCount, 0);
  assert.deepEqual(view.visibleDiagnosticGaps, []);
});
