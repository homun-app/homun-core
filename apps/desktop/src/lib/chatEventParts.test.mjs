import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeChatEventParts,
  threadTailAwaitsUser,
} from "./chatEventParts.mjs";
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
  assert.equal(
    threadTailAwaitsUser([{ role: "assistant", text: "", eventParts: parts }]),
    true,
  );
});

test("malformed_marker_fragments_cannot_affect_liveness", () => {
  assert.equal(
    threadTailAwaitsUser([{ role: "assistant", text: "‹‹AWA", eventParts: [] }]),
    false,
  );
  assert.equal(
    threadTailAwaitsUser([{ role: "assistant", text: "‹‹AWAIT_USER››", eventParts: [] }]),
    false,
    "a marker opening without a close is stream debris, not durable liveness",
  );
});

test("legacy_marker_messages_render_but_do_not_drive_current_turn", () => {
  const legacyTail = threadTailAwaitsUser([
    {
      role: "assistant",
      text: "‹‹CHOICES››{\"question\":\"Scegli\",\"options\":[\"A\"]}‹‹/CHOICES››",
      eventParts: [],
    },
  ]);
  assert.equal(legacyTail, true);

  const lifecycle = deriveTurnLifecycle({
    promptSubmitting: false,
    streamingAssistantId: null,
    projectedActiveTurn: null,
    projectedTurnStatus: "completed",
    projectionLoaded: true,
    threadTailAwaitsHitl: legacyTail,
  });
  assert.equal(lifecycle.threadTailAwaitsHitl, false);
  assert.equal(lifecycle.hasActiveTurn, false);
});
