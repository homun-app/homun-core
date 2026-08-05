import assert from "node:assert/strict";
import test from "node:test";

import { steeringPromptWithEdit } from "./chatSteeringPrompt.mjs";

test("steeringPromptWithEdit preserves hidden prompt prefix when visible prompt matches tail", () => {
  const row = {
    prompt: "Hidden orchestration\nUser request: original visible text",
    visible_prompt: "original visible text",
  };

  assert.equal(
    steeringPromptWithEdit(row, "edited visible text"),
    "Hidden orchestration\nUser request: edited visible text",
  );
});

test("steeringPromptWithEdit uses visible edit when no visible prompt was stored", () => {
  const row = {
    prompt: "previous full prompt",
    visible_prompt: "",
  };

  assert.equal(steeringPromptWithEdit(row, "edited visible text"), "edited visible text");
});

test("steeringPromptWithEdit uses visible edit when stored prompt no longer matches tail", () => {
  const row = {
    prompt: "Hidden orchestration\nUser request: original visible text\nextra suffix",
    visible_prompt: "original visible text",
  };

  assert.equal(steeringPromptWithEdit(row, "edited visible text"), "edited visible text");
});
