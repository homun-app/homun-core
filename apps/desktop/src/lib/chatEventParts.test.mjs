import test from "node:test";
import assert from "node:assert/strict";
import { normalizeChatEventParts } from "./chatEventParts.mjs";
import { projectKernelThreadView } from "./chat-runtime/kernelProjectionPresenter.mjs";

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
  const view = projectKernelThreadView({
    projectionLoaded: true,
    projection: {
      thread_id: "thread-1",
      revision: 1,
      turn: {
        active_turn_id: null,
        status: "completed",
        last_event_seq: 2,
        terminal_reason: "canonical_completed",
        failure_text: null,
        updated_at: 100,
      },
      plan: null,
      activity: [],
      browser: {
        state: "idle",
        target_id: null,
        latest_progress: null,
        failure_reason: null,
        snapshot_verified: false,
      },
      capability_runtime: {
        loaded_tools: [],
        armed_sensitive_domains: [],
        pending_capability: null,
        blocked_capabilities: [],
      },
      attention: {
        awaiting_user: false,
        approvals: [],
        uncertain_effects: [],
      },
      actions: {
        can_stop: false,
        composer_mode: "new_turn",
      },
    },
    isStreaming: false,
    liveActivitySteps: [],
    livePlanMarkdown: null,
    streamOwnerTurnId: null,
  });
  assert.equal(view.turnUiState.hasActiveTurn, false);
});
