import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTINUE_RESPONSE_PROMPT,
  buildAssistantFollowUpPrompt,
  buildComposerPromptDecorators,
  buildReplyContextPrompt,
  buildSteeringPrompt,
} from "./chatPromptAssembly.mjs";

test("buildComposerPromptDecorators keeps plain prompts unaugmented", () => {
  assert.deepEqual(buildComposerPromptDecorators({}), {
    skillPrefix: "",
    contextPrefix: "",
    augmented: false,
  });
});

test("buildComposerPromptDecorators creates hidden skill and context prefixes", () => {
  assert.deepEqual(
    buildComposerPromptDecorators({
      forcedSkillsId: "browser:control",
      contextText: "File context",
    }),
    {
      skillPrefix: "Use the skill `browser:control` to fulfill this request.\n\n",
      contextPrefix: "File context\n\n",
      augmented: true,
    },
  );
});

test("buildSteeringPrompt keeps active-task reply context separate from user instruction", () => {
  assert.equal(
    buildSteeringPrompt({
      skillPrefix: "Use skill\n\n",
      contextPrefix: "Context\n\n",
      prompt: "refine this",
      replyRoleLabel: "Assistant",
      replyPreview: "quoted answer",
    }),
    [
      "Use skill\n\n",
      "Context\n\n",
      "Apply this instruction to the active task while keeping the quoted context.",
      "Quoted message (Assistant):",
      "quoted answer",
      "",
      "User instruction:",
      "refine this",
    ].join("\n"),
  );
});

test("buildSteeringPrompt falls back to the augmented raw prompt without reply context", () => {
  assert.equal(
    buildSteeringPrompt({
      skillPrefix: "Use skill\n\n",
      contextPrefix: "Context\n\n",
      prompt: "run it",
    }),
    "Use skill\n\nContext\n\nrun it",
  );
});

test("buildReplyContextPrompt keeps quoted reply context separate from the visible request", () => {
  assert.equal(
    buildReplyContextPrompt({
      skillPrefix: "",
      contextPrefix: "Context\n\n",
      prompt: "answer this",
      replyRoleLabel: "User",
      replyPreview: "quoted question",
    }),
    [
      "",
      "Context\n\n",
      "Reply to the quoted message keeping the context.",
      "Quoted message (User):",
      "quoted question",
      "",
      "User request:",
      "answer this",
    ].join("\n"),
  );
});

test("buildAssistantFollowUpPrompt preserves instruction and previous response boundary", () => {
  assert.equal(
    buildAssistantFollowUpPrompt({
      instruction: "Expand",
      previousResponse: "Existing answer",
    }),
    [
      "Expand",
      "Keep the same language as the user.",
      "",
      "Previous response:",
      "Existing answer",
    ].join("\n"),
  );
});

test("CONTINUE_RESPONSE_PROMPT is the canonical terse continuation instruction", () => {
  assert.match(CONTINUE_RESPONSE_PROMPT, /Do not repeat already written parts/);
});
