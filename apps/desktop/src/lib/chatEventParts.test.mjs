import test from "node:test";
import assert from "node:assert/strict";
import { normalizeChatEventParts } from "./chatEventParts.mjs";
import { deriveTurnLifecycle } from "./chat-runtime/lifecycle.mjs";

test("typed_parts_render_after_reload_without_marker_text", () => {
  const parts = normalizeChatEventParts([
    {
      type: "actionable_card",
      kind: "CHOICES",
      payload: {
        question: "Scegli",
        multi: false,
        options: ["A", "B"],
      },
    },
  ]);

  assert.deepEqual(parts, [
    {
      type: "choice_prompt",
      payload: {
        question: "Scegli",
        multi: false,
        options: ["A", "B"],
        purpose: undefined,
      },
    },
  ]);
});

test("legacy_marker_messages_render_but_do_not_drive_current_turn", () => {
  const lifecycle = deriveTurnLifecycle({
    promptSubmitting: false,
    streamingAssistantId: null,
    projectedActiveTurn: null,
    projectedTurnStatus: "completed",
    projectionLoaded: true,
  });
  assert.equal(lifecycle.hasActiveTurn, false);
});
