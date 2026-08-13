import test from "node:test";
import assert from "node:assert/strict";
import { projectKernelThreadView } from "./kernelProjectionPresenter.mjs";

function projection(overrides = {}) {
  return {
    thread_id: "thread-1",
    revision: 1,
    turn: {
      active_turn_id: null,
      status: "idle",
      last_event_seq: 0,
      terminal_reason: null,
      failure_text: null,
      updated_at: 0,
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
    ...overrides,
  };
}

test("terminal_projection_clears_active_thinking", () => {
  const view = projectKernelThreadView({
    projectionLoaded: true,
    projection: projection({
      turn: {
        active_turn_id: null,
        status: "completed",
        last_event_seq: 2,
        terminal_reason: "canonical_completed",
        failure_text: null,
        updated_at: 100,
      },
      actions: {
        can_stop: false,
        composer_mode: "new_turn",
      },
    }),
    isStreaming: false,
    liveActivitySteps: [],
    livePlanMarkdown: null,
    streamOwnerTurnId: null,
  });

  assert.equal(view.turnUiState.hasActiveTurn, false);
  assert.equal(view.turnUiState.workInProgress, false);
  assert.equal(view.turnUiState.canStop, false);
  assert.equal(view.turnUiState.isStreaming, false);
  assert.equal(view.turnUiState.terminalTurnAtRest, true);
  assert.equal(view.composerMode, "new_turn");
});

test("runtime_view_model_uses_projection_not_marker_tail_after_projection_load", () => {
  const view = projectKernelThreadView({
    projectionLoaded: true,
    projection: projection({
      turn: {
        active_turn_id: null,
        status: "completed",
        last_event_seq: 2,
        terminal_reason: "canonical_completed",
        failure_text: null,
        updated_at: 100,
      },
    }),
    isStreaming: false,
    liveActivitySteps: [],
    livePlanMarkdown: null,
    streamOwnerTurnId: null,
  });

  assert.equal(view.turnUiState.turnAwaitingUser, false);
  assert.equal(view.turnUiState.hasActiveTurn, false);
  assert.equal(view.turnUiState.workInProgress, false);
});

test("runtime_view_model_keeps_marker_tail_display_only_before_projection_load", () => {
  const view = projectKernelThreadView({
    projectionLoaded: false,
    projection: null,
    isStreaming: false,
    liveActivitySteps: [],
    livePlanMarkdown: null,
    streamOwnerTurnId: null,
  });

  assert.equal(view.turnUiState.turnAwaitingUser, false);
  assert.equal(view.turnUiState.hasActiveTurn, false);
  assert.equal(view.turnUiState.workInProgress, false);
});

test("missing_kernel_projection_does_not_fallback_to_marker_plan_or_activity", () => {
  const view = projectKernelThreadView({
    projectionLoaded: false,
    projection: null,
    isStreaming: false,
    liveActivitySteps: [],
    livePlanMarkdown: null,
    streamOwnerTurnId: null,
  });

  assert.equal(view.conversationPlan, null);
  assert.deepEqual(view.conversationActivity, []);
});

test("durable_plan_projection_wins_over_marker_and_stream_gap", () => {
  const view = projectKernelThreadView({
    projectionLoaded: true,
    projection: projection({
      turn: {
        active_turn_id: "turn-1",
        status: "running",
        last_event_seq: 4,
        terminal_reason: null,
        failure_text: null,
        updated_at: 200,
      },
      plan: {
        goal: "trova un treno",
        revision: 3,
        markdown: "**Goal**: trova un treno\n\n- [-] **Leggi risultati** (`s2`): in corso",
        steps: [
          { id: "s1", title: "Cerca risultati", status: "done", detail: "ok" },
          { id: "s2", title: "Leggi risultati", status: "doing", detail: "in corso" },
        ],
      },
      actions: {
        can_stop: true,
        composer_mode: "steer_active_turn",
      },
    }),
    isStreaming: true,
    liveActivitySteps: [],
    livePlanMarkdown: null,
    streamOwnerTurnId: "turn-1",
  });

  assert.equal(
    view.conversationPlan,
    "**Goal**: trova un treno\n\n- [-] **Leggi risultati** (`s2`): in corso",
  );
  assert.equal(view.workspacePlanGoal, "trova un treno");
  assert.deepEqual(
    view.workspacePlanSteps.map((step) => [step.id, step.status]),
    [["s1", "done"], ["s2", "doing"]],
  );
});

test("read_uncertain_effect_does_not_render_verification_attention", () => {
  const view = projectKernelThreadView({
    projectionLoaded: true,
    projection: projection({
      attention: {
        awaiting_user: true,
        approvals: [],
        uncertain_effects: [
          {
            receipt_ref: "read-ref",
            execution_id: "turn-1",
            operation: "browser.extract",
            effect_class: "read",
          },
        ],
      },
    }),
    isStreaming: false,
    liveActivitySteps: [],
    livePlanMarkdown: null,
    streamOwnerTurnId: null,
  });

  assert.deepEqual(view.attentionItems, []);
  assert.equal(view.turnUiState.turnAwaitingUser, false);
});

test("write_uncertain_effect_renders_attention", () => {
  const view = projectKernelThreadView({
    projectionLoaded: true,
    projection: projection({
      attention: {
        awaiting_user: true,
        approvals: [],
        uncertain_effects: [
          {
            receipt_ref: "write-ref",
            execution_id: "turn-1",
            operation: "calendar.create_event",
            effect_class: "external_write",
          },
        ],
      },
    }),
    isStreaming: false,
    liveActivitySteps: [],
    livePlanMarkdown: null,
    streamOwnerTurnId: null,
  });

  assert.deepEqual(view.attentionItems, [
    {
      kind: "uncertain_effect",
      id: "write-ref",
      operation: "calendar.create_event",
      effectClass: "external_write",
    },
  ]);
  assert.equal(view.turnUiState.turnAwaitingUser, true);
});

test("plugin_loaded_tools_do_not_change_liveness", () => {
  const view = projectKernelThreadView({
    projectionLoaded: true,
    projection: projection({
      capability_runtime: {
        loaded_tools: ["make_deck", "mcp__calendar__list"],
        armed_sensitive_domains: ["calendar"],
        pending_capability: null,
        blocked_capabilities: [],
      },
    }),
    isStreaming: false,
    liveActivitySteps: [],
    livePlanMarkdown: null,
    streamOwnerTurnId: null,
  });

  assert.equal(view.turnUiState.hasActiveTurn, false);
  assert.equal(view.turnUiState.workInProgress, false);
  assert.deepEqual(view.capabilityRuntime.loadedTools, ["make_deck", "mcp__calendar__list"]);
});

test("browser_active_without_done_stays_active", () => {
  const view = projectKernelThreadView({
    projectionLoaded: true,
    projection: projection({
      browser: {
        state: "active",
        target_id: "browser-1",
        latest_progress: "Loaded search results",
        failure_reason: null,
        snapshot_verified: false,
      },
    }),
    isStreaming: false,
    liveActivitySteps: [],
    livePlanMarkdown: null,
    streamOwnerTurnId: null,
  });

  assert.deepEqual(view.browserStatus, {
    active: true,
    done: false,
    failed: false,
    state: "active",
    snapshotVerified: false,
    failureReason: null,
    latestProgress: "Loaded search results",
  });
});

test("browser_failure_reason_is_typed_state_not_activity_text", () => {
  const view = projectKernelThreadView({
    projectionLoaded: true,
    projection: projection({
      activity: [],
      browser: {
        state: "failed",
        target_id: "browser-1",
        latest_progress: null,
        failure_reason: "no_progress",
        snapshot_verified: false,
      },
    }),
    isStreaming: false,
    liveActivitySteps: [],
    livePlanMarkdown: null,
    streamOwnerTurnId: null,
  });

  assert.equal(view.browserStatus.failed, true);
  assert.equal(view.browserStatus.failureReason, "no_progress");
  assert.deepEqual(view.conversationActivity, []);
});

test("grounded_browser_partial_terminal_keeps_plan_visible_without_attention", () => {
  const view = projectKernelThreadView({
    projectionLoaded: true,
    projection: projection({
      turn: {
        active_turn_id: null,
        status: "completed",
        last_event_seq: 16,
        terminal_reason: "canonical_completed",
        failure_text: null,
        updated_at: 1723360020,
      },
      plan: {
        goal: "Trovare opzioni treno Milano-Roma",
        revision: 4,
        markdown: "- [x] Apri ricerca treni\n- [x] Leggi risultati\n- [x] Rispondi con fonti",
        steps: [
          { id: "s1", title: "Apri ricerca treni", status: "done", detail: "Risultati caricati" },
          { id: "s2", title: "Leggi risultati", status: "done", detail: "Opzioni osservate" },
          { id: "s3", title: "Rispondi con fonti", status: "done", detail: "Risposta completata" },
        ],
      },
      browser: {
        state: "done",
        target_id: null,
        latest_progress: "Found 3 train options and source URLs",
        failure_reason: null,
        snapshot_verified: true,
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
    }),
    isStreaming: false,
    liveActivitySteps: [],
    livePlanMarkdown: null,
    streamOwnerTurnId: null,
  });

  assert.equal(view.conversationPlan, "- [x] Apri ricerca treni\n- [x] Leggi risultati\n- [x] Rispondi con fonti");
  assert.equal(view.workspacePlanGoal, "Trovare opzioni treno Milano-Roma");
  assert.deepEqual(
    view.workspacePlanSteps.map((step) => [step.id, step.status]),
    [["s1", "done"], ["s2", "done"], ["s3", "done"]],
  );
  assert.deepEqual(view.attentionItems, []);
  assert.equal(view.turnUiState.hasActiveTurn, false);
  assert.equal(view.turnUiState.workInProgress, false);
  assert.equal(view.turnUiState.terminalTurnAtRest, true);
  assert.equal(view.browserStatus.done, true);
  assert.equal(view.browserStatus.active, false);
  assert.equal(view.composerMode, "new_turn");
});
