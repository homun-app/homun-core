import assert from "node:assert/strict";
import test from "node:test";

import { buildProactivityChatSeed } from "./proactivityChatSeed.mjs";

function suggestion(overrides = {}) {
  return {
    scope: "__personal__",
    kind: "follow_up",
    title: "Fallback title",
    body: " Body question ",
    choices: null,
    ...overrides,
  };
}

test("buildProactivityChatSeed maps personal scope to the workspace id", () => {
  assert.equal(
    buildProactivityChatSeed(suggestion(), "local-workspace").workspaceId,
    "local-workspace",
  );
});

test("buildProactivityChatSeed preserves project scopes", () => {
  assert.equal(
    buildProactivityChatSeed(suggestion({ scope: "project-1" }), "local-workspace")
      .workspaceId,
    "project-1",
  );
});

test("buildProactivityChatSeed trims body and falls back to title", () => {
  assert.equal(buildProactivityChatSeed(suggestion()).question, "Body question");
  assert.equal(
    buildProactivityChatSeed(suggestion({ body: "   " })).question,
    "Fallback title",
  );
});

test("buildProactivityChatSeed emits choice prompt parts for non-empty choices", () => {
  assert.deepEqual(
    buildProactivityChatSeed(
      suggestion({ kind: "onboarding", choices: [" yes ", "", "no"] }),
      "local-workspace",
    ).seedEventParts,
    [
      {
        type: "choice_prompt",
        payload: {
          question: "",
          multi: false,
          options: ["yes", "no"],
          purpose: "onboarding",
        },
      },
    ],
  );
});

test("buildProactivityChatSeed omits choice prompt parts without options", () => {
  assert.deepEqual(
    buildProactivityChatSeed(suggestion({ choices: ["", "  "] }), "local-workspace")
      .seedEventParts,
    [],
  );
});
