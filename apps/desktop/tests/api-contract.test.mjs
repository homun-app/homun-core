/**
 * API contract validation tests for the frontend <-> gateway interface.
 *
 * The contract is implicitly defined by the TypeScript interfaces in
 * `src/lib/coreBridge.ts` / `src/lib/chatApi.ts` and the Rust serde structs
 * in `crates/desktop-gateway/src/`. Any Rust-side serialization change can
 * silently break the frontend with no test catching it — these tests lock the
 * wire shape of the five most critical response payloads so a drift is caught
 * before it ships.
 *
 * Each fixture in `tests/fixtures/api-contracts/*.json` is a known-good response
 * body as the Rust gateway actually serializes it (snake_case via serde). The
 * shape descriptors below are derived from the authoritative TypeScript
 * interfaces (linked in each contract's comment) and tightened with `enum`
 * constraints where the TS type is a string-literal union.
 *
 * Lightweight by design: only Node.js built-ins (`node:test`, `node:assert`,
 * `node:fs`). No ajv/zod.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "api-contracts");

/** Read a fixture file ({ comment, payload }) and return its `payload`. */
function loadPayload(name) {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  return raw.payload;
}

// ── Lightweight shape validator ──────────────────────────────────────────────
//
// A *shape* is an object mapping field-name -> field-descriptor:
//   { type: "string" }                         // required, non-null
//   { type: "number", optional: true }          // may be absent
//   { type: "string", nullable: true }          // required, may be null
//   { type: "string", optional: true, nullable: true }  // absent OR null OK
//   { type: "array", items: <descriptor> }      // array of items
//   { type: "object", shape: <shape> }          // nested object
//   { type: "array", items: "any" }             // array, item types unchecked
//   { enum: ["a","b"] }                          // string that must be one of
//
// `optional` => field may be absent. An optional field is nullable by default
// (serde serializes `None` to `null`). Returns an array of human-readable
// error strings; an empty array means the value matches the shape.

function jsType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function primitiveOk(value, expectedType) {
  switch (expectedType) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && !Number.isNaN(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "any": return true;
    default: return false;
  }
}

function validateShape(value, shape, opts = {}) {
  const { path = "", allowExtra = false } = opts;
  const errors = [];
  const here = path || "<root>";

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${here}: expected object, got ${jsType(value)}`);
    return errors;
  }

  for (const [field, desc] of Object.entries(shape)) {
    const fieldPath = path ? `${path}.${field}` : field;
    const isOptional = desc.optional === true;
    // Optional fields are nullable by default (serde Option -> null). Required
    // fields are nullable only when explicitly marked.
    const isNullable = desc.nullable === true || (isOptional && desc.nullable !== false);

    if (!(field in value)) {
      if (!isOptional) {
        errors.push(`${fieldPath}: missing required field (expected ${desc.type ?? "enum"})`);
      }
      continue;
    }

    const v = value[field];

    if (v === null) {
      if (!isNullable) {
        errors.push(`${fieldPath}: expected ${desc.type ?? "enum"}, got null`);
      }
      continue;
    }

    // Enum constraint (implies string).
    if (desc.enum) {
      if (typeof v !== "string") {
        errors.push(`${fieldPath}: expected enum string, got ${jsType(v)}`);
      } else if (!desc.enum.includes(v)) {
        errors.push(`${fieldPath}: expected one of [${desc.enum.join(", ")}], got "${v}"`);
      }
      continue;
    }

    // Nested object.
    if (desc.type === "object" && desc.shape) {
      errors.push(...validateShape(v, desc.shape, { path: fieldPath, allowExtra }));
      continue;
    }

    // Array with item descriptor.
    if (desc.type === "array") {
      if (!Array.isArray(v)) {
        errors.push(`${fieldPath}: expected array, got ${jsType(v)}`);
        continue;
      }
      if (desc.items && desc.items !== "any") {
        const itemDesc = desc.items;
        v.forEach((item, i) => {
          if (item === null) {
            const itemNullable = itemDesc.nullable === true;
            if (!itemNullable) {
              errors.push(`${fieldPath}[${i}]: expected ${itemDesc.type ?? "enum"}, got null`);
            }
            return;
          }
          if (itemDesc.enum) {
            if (typeof item !== "string") {
              errors.push(`${fieldPath}[${i}]: expected enum string, got ${jsType(item)}`);
            } else if (!itemDesc.enum.includes(item)) {
              errors.push(`${fieldPath}[${i}]: expected one of [${itemDesc.enum.join(", ")}], got "${item}"`);
            }
            return;
          }
          if (itemDesc.type === "object" && itemDesc.shape) {
            errors.push(...validateShape(item, itemDesc.shape, { path: `${fieldPath}[${i}]`, allowExtra }));
          } else if (itemDesc.type && !primitiveOk(item, itemDesc.type)) {
            errors.push(`${fieldPath}[${i}]: expected ${itemDesc.type}, got ${jsType(item)}`);
          }
        });
      }
      continue;
    }

    if (!primitiveOk(v, desc.type)) {
      errors.push(`${fieldPath}: expected ${desc.type}, got ${jsType(v)}`);
    }
  }

  if (!allowExtra) {
    for (const key of Object.keys(value)) {
      if (!(key in shape)) {
        errors.push(`${path ? path + "." : ""}${key}: unexpected field (not in contract)`);
      }
    }
  }

  return errors;
}

// Deep-clone + single-field mutation helper for negative tests.
function without(obj, field) {
  const clone = JSON.parse(JSON.stringify(obj));
  delete clone[field];
  return clone;
}
function withField(obj, field, value) {
  const clone = JSON.parse(JSON.stringify(obj));
  clone[field] = value;
  return clone;
}

// ── Contract shape descriptors ──────────────────────────────────────────────
// Each descriptor is derived from the linked TypeScript interface and reflects
// the actual serde wire shape (snake_case, Options -> null when present).

// TS interface QueuedTurnResponse (src/lib/chatApi.ts).
// Rust: gateway_turn_broker.rs enqueue_turn — inline json! with snake_case keys.
const QUEUED_TURN_SHAPE = {
  turn_id: { type: "string" },
  thread_id: { type: "string" },
  request_id: { type: "string" },
  status: { enum: ["queued", "resumed"] },
  position_in_queue: { type: "number", optional: true },
  revision: { type: "number", optional: true },
  stream_from_seq: { type: "number", optional: true },
};

// Rust: HealthResponse (crates/desktop-gateway/src/gateway_health.rs).
// Serialized with default serde (struct fields are snake_case). No dedicated TS
// interface — this descriptor is the canonical wire contract.
const HEALTH_SHAPE = {
  ok: { type: "boolean" },
  service: { type: "string" },
  local_first: { type: "boolean" },
  auth_required: { type: "boolean" },
  recovered_stores: { type: "array", items: { type: "string" } },
  projection_worker_error: { type: "string", optional: true, nullable: true },
};

// TS interface CoreChatThreadSnapshot / CoreChatThread (src/lib/coreBridge.ts).
// Rust: ChatThreadSnapshot / ChatThread (crates/desktop-gateway/src/lib.rs).
const CHAT_THREAD_SHAPE = {
  thread_id: { type: "string" },
  workspace_id: { type: "string", optional: true, nullable: true },
  title: { type: "string" },
  subtitle: { type: "string" },
  status: { type: "string" },
  pinned: { type: "boolean" },
  computer_session_id: { type: "string" },
  task_id: { type: "string" },
  updated_at: { type: "string" },
  message_count: { type: "number" },
  source: { type: "string", optional: true, nullable: true },
  channel_recipient: { type: "string", optional: true, nullable: true },
};
const THREAD_SNAPSHOT_SHAPE = {
  active_thread_id: { type: "string" },
  threads: { type: "array", items: { type: "object", shape: CHAT_THREAD_SHAPE } },
};

// TS RecallEventPayload / RecallHitPayload (src/lib/coreBridge.ts), delivered as
// a CoreChatStreamEvent of type "recall" over the turn NDJSON stream.
const RECALL_HIT_SHAPE = {
  ref: { type: "string" },
  text: { type: "string" },
  score: { type: "number" },
  type: { type: "string" },
  source_workspace_id: { type: "string" },
  source_label: { type: "string" },
  collection: {
    enum: ["preferences", "profile", "knowledge", "decisions", "goals", "artifacts", "episodes"],
  },
  grant_id: { type: "string", nullable: true },
  policy_version: { type: "number", nullable: true },
  source_revision: { type: "string", optional: true, nullable: true },
  conflict: { type: "boolean" },
  graph_path: { type: "array", items: { type: "string" }, optional: true, nullable: true },
};
const RECALL_PAYLOAD_SHAPE = {
  query: { type: "string" },
  hits: { type: "array", items: { type: "object", shape: RECALL_HIT_SHAPE } },
  scope: { enum: ["personal", "project"] },
  status: { enum: ["ready", "empty", "degraded", "unavailable", "denied"], optional: true },
};
const RECALL_EVENT_SHAPE = {
  type: { enum: ["recall"] },
  request_id: { type: "string" },
  payload: { type: "object", shape: RECALL_PAYLOAD_SHAPE },
};

// TS StepAdvancePayload (src/lib/coreBridge.ts), delivered as a
// CoreChatStreamEvent of type "step_advance" over the turn NDJSON stream / WS.
const STEP_ADVANCE_PAYLOAD_SHAPE = {
  step_id: { type: "string" },
  title: { type: "string" },
  from: { type: "string", nullable: true },
  to: { type: "string" },
  verified: { type: "boolean", nullable: true },
  note: { type: "string", nullable: true },
};
const STEP_ADVANCE_EVENT_SHAPE = {
  type: { enum: ["step_advance"] },
  request_id: { type: "string" },
  payload: { type: "object", shape: STEP_ADVANCE_PAYLOAD_SHAPE },
};

// TS CorePromptExecutionPlan / CorePromptPlanStep (src/lib/coreBridge.ts).
const PLAN_STEP_SHAPE = {
  step_id: { type: "string" },
  title: { type: "string" },
  detail: { type: "string" },
  surface: { type: "string" },
  action_kind: { type: "string" },
  requires_user_approval: { type: "boolean" },
  target_url: { type: "string", optional: true, nullable: true },
};
const PLAN_SHAPE = {
  title: { type: "string" },
  summary: { type: "string" },
  risk_level: { type: "string" },
  steps: { type: "array", items: { type: "object", shape: PLAN_STEP_SHAPE } },
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("API contract: queued turn response (POST /api/chat/turns)", () => {
  const payload = loadPayload("queued-turn-response.json");

  it("matches the expected shape", () => {
    const errors = validateShape(payload, QUEUED_TURN_SHAPE);
    assert.deepEqual(errors, [], errors.join("\n"));
  });

  it("accepts the resumed variant with optional revision/stream_from_seq", () => {
    const resumed = { turn_id: "t1", thread_id: "th1", request_id: "r1", status: "resumed", revision: 2, stream_from_seq: 5 };
    assert.deepEqual(validateShape(resumed, QUEUED_TURN_SHAPE), []);
  });

  it("accepts absence of all optional fields", () => {
    const minimal = { turn_id: "t1", thread_id: "th1", request_id: "r1", status: "queued" };
    assert.deepEqual(validateShape(minimal, QUEUED_TURN_SHAPE), []);
  });

  it("rejects a missing required field", () => {
    const bad = without(payload, "turn_id");
    const errors = validateShape(bad, QUEUED_TURN_SHAPE);
    assert.ok(errors.some((e) => e.includes("turn_id") && e.includes("missing")), errors.join("\n"));
  });

  it("rejects a wrong type", () => {
    const bad = withField(payload, "position_in_queue", "zero");
    const errors = validateShape(bad, QUEUED_TURN_SHAPE);
    assert.ok(errors.some((e) => e.includes("position_in_queue")), errors.join("\n"));
  });

  it("rejects an unknown status enum value", () => {
    const bad = withField(payload, "status", "pending");
    const errors = validateShape(bad, QUEUED_TURN_SHAPE);
    assert.ok(errors.some((e) => e.includes("status") && e.includes("pending")), errors.join("\n"));
  });
});

describe("API contract: health response (GET /api/health)", () => {
  const payload = loadPayload("health-response.json");

  it("matches the expected shape", () => {
    const errors = validateShape(payload, HEALTH_SHAPE);
    assert.deepEqual(errors, [], errors.join("\n"));
  });

  it("accepts a non-empty recovered_stores array", () => {
    const degraded = withField(payload, "recovered_stores", ["desktop-gateway"]);
    degraded.ok = false;
    degraded.projection_worker_error = "projection stopped";
    assert.deepEqual(validateShape(degraded, HEALTH_SHAPE), []);
  });

  it("accepts projection_worker_error absent (legacy shape)", () => {
    const minimal = { ok: true, service: "local-first-desktop-gateway", local_first: true, auth_required: false, recovered_stores: [] };
    assert.deepEqual(validateShape(minimal, HEALTH_SHAPE), []);
  });

  it("rejects a missing required field", () => {
    const bad = without(payload, "ok");
    const errors = validateShape(bad, HEALTH_SHAPE);
    assert.ok(errors.some((e) => e.includes("ok") && e.includes("missing")), errors.join("\n"));
  });

  it("rejects a wrong type for recovered_stores", () => {
    const bad = withField(payload, "recovered_stores", "none");
    const errors = validateShape(bad, HEALTH_SHAPE);
    assert.ok(errors.some((e) => e.includes("recovered_stores")), errors.join("\n"));
  });

  it("rejects an unexpected extra field", () => {
    const bad = withField(payload, "version", "1.0");
    const errors = validateShape(bad, HEALTH_SHAPE);
    assert.ok(errors.some((e) => e.includes("version") && e.includes("unexpected")), errors.join("\n"));
  });
});

describe("API contract: thread snapshot (GET /api/chat/threads)", () => {
  const payload = loadPayload("thread-snapshot.json");

  it("matches the expected shape", () => {
    const errors = validateShape(payload, THREAD_SNAPSHOT_SHAPE);
    assert.deepEqual(errors, [], errors.join("\n"));
  });

  it("validates every thread item in the array", () => {
    assert.ok(payload.threads.length >= 2, "fixture should carry multiple threads");
    for (const thread of payload.threads) {
      assert.deepEqual(validateShape(thread, CHAT_THREAD_SHAPE), [], `thread ${thread.thread_id} failed`);
    }
  });

  it("accepts a thread with optional fields absent (legacy row)", () => {
    const legacy = {
      thread_id: "t_legacy",
      title: "Legacy",
      subtitle: "Old",
      status: "active",
      pinned: false,
      computer_session_id: "c1",
      task_id: "task_1",
      updated_at: "1700000000",
      message_count: 0,
    };
    assert.deepEqual(validateShape(legacy, CHAT_THREAD_SHAPE), []);
  });

  it("rejects a thread missing a required field", () => {
    const bad = without(payload.threads[0], "thread_id");
    const errors = validateShape(bad, CHAT_THREAD_SHAPE);
    assert.ok(errors.some((e) => e.includes("thread_id") && e.includes("missing")), errors.join("\n"));
  });

  it("rejects a wrong type for pinned", () => {
    const bad = withField(payload.threads[0], "pinned", "yes");
    const errors = validateShape(bad, CHAT_THREAD_SHAPE);
    assert.ok(errors.some((e) => e.includes("pinned")), errors.join("\n"));
  });

  it("rejects a snapshot with the wrong active_thread_id type", () => {
    const bad = withField(payload, "active_thread_id", 42);
    const errors = validateShape(bad, THREAD_SNAPSHOT_SHAPE);
    assert.ok(errors.some((e) => e.includes("active_thread_id")), errors.join("\n"));
  });
});

describe("API contract: memory recall event (turn stream, type 'recall')", () => {
  const payload = loadPayload("memory-recall-event.json");

  it("matches the expected shape", () => {
    const errors = validateShape(payload, RECALL_EVENT_SHAPE);
    assert.deepEqual(errors, [], errors.join("\n"));
  });

  it("validates every recall hit in the array", () => {
    assert.ok(payload.payload.hits.length >= 2, "fixture should carry multiple hits");
    for (const hit of payload.payload.hits) {
      assert.deepEqual(validateShape(hit, RECALL_HIT_SHAPE), [], `hit ${hit.ref} failed`);
    }
  });

  it("accepts a hit with graph_path absent (legacy event)", () => {
    const legacy = {
      ref: "mem_legacy",
      text: "old",
      score: 0.5,
      type: "preference",
      source_workspace_id: "__personal__",
      source_label: "Personale",
      collection: "preferences",
      grant_id: null,
      policy_version: null,
      conflict: false,
    };
    assert.deepEqual(validateShape(legacy, RECALL_HIT_SHAPE), []);
  });

  it("accepts a payload with status absent (legacy persisted event)", () => {
    const noStatus = without(payload.payload, "status");
    const errors = validateShape({ ...payload, payload: noStatus }, RECALL_EVENT_SHAPE);
    assert.deepEqual(errors, [], errors.join("\n"));
  });

  it("rejects a hit missing a required field", () => {
    const bad = without(payload.payload.hits[0], "ref");
    const errors = validateShape(bad, RECALL_HIT_SHAPE);
    assert.ok(errors.some((e) => e.includes("ref") && e.includes("missing")), errors.join("\n"));
  });

  it("rejects an invalid collection enum value", () => {
    const bad = withField(payload.payload.hits[0], "collection", "random_thoughts");
    const errors = validateShape(bad, RECALL_HIT_SHAPE);
    assert.ok(errors.some((e) => e.includes("collection") && e.includes("random_thoughts")), errors.join("\n"));
  });

  it("rejects an invalid scope enum value", () => {
    const badPayload = withField(payload.payload, "scope", "global");
    const errors = validateShape({ ...payload, payload: badPayload }, RECALL_EVENT_SHAPE);
    assert.ok(errors.some((e) => e.includes("scope") && e.includes("global")), errors.join("\n"));
  });
});

describe("API contract: plan state (CorePromptExecutionPlan)", () => {
  const payload = loadPayload("plan-state.json");

  it("matches the expected shape", () => {
    const errors = validateShape(payload, PLAN_SHAPE);
    assert.deepEqual(errors, [], errors.join("\n"));
  });

  it("validates every plan step in the array", () => {
    assert.ok(payload.steps.length >= 2, "fixture should carry multiple steps");
    for (const step of payload.steps) {
      assert.deepEqual(validateShape(step, PLAN_STEP_SHAPE), [], `step ${step.step_id} failed`);
    }
  });

  it("accepts a step with target_url absent", () => {
    const noTarget = {
      step_id: "s1",
      title: "Step",
      detail: "d",
      surface: "host",
      action_kind: "shell",
      requires_user_approval: false,
    };
    assert.deepEqual(validateShape(noTarget, PLAN_STEP_SHAPE), []);
  });

  it("accepts an empty steps array", () => {
    const empty = withField(payload, "steps", []);
    assert.deepEqual(validateShape(empty, PLAN_SHAPE), []);
  });

  it("rejects a step missing a required field", () => {
    const bad = without(payload.steps[0], "requires_user_approval");
    const errors = validateShape(bad, PLAN_STEP_SHAPE);
    assert.ok(errors.some((e) => e.includes("requires_user_approval") && e.includes("missing")), errors.join("\n"));
  });

  it("rejects a wrong type for requires_user_approval", () => {
    const bad = withField(payload.steps[0], "requires_user_approval", "yes");
    const errors = validateShape(bad, PLAN_STEP_SHAPE);
    assert.ok(errors.some((e) => e.includes("requires_user_approval")), errors.join("\n"));
  });

  it("rejects a plan missing the steps array", () => {
    const bad = without(payload, "steps");
    const errors = validateShape(bad, PLAN_SHAPE);
    assert.ok(errors.some((e) => e.includes("steps") && e.includes("missing")), errors.join("\n"));
  });
});

describe("API contract: plan step advance event (turn stream, type 'step_advance')", () => {
  const payload = loadPayload("step-advance-event.json");

  it("matches the expected shape", () => {
    const errors = validateShape(payload, STEP_ADVANCE_EVENT_SHAPE);
    assert.deepEqual(errors, [], errors.join("\n"));
  });

  it("accepts a first transition with from null (step had no prior status)", () => {
    const first = {
      ...payload,
      payload: { ...payload.payload, from: null, verified: null, to: "doing", note: null },
    };
    assert.deepEqual(validateShape(first, STEP_ADVANCE_EVENT_SHAPE), []);
  });

  it("accepts a failed verification carrying a note", () => {
    const failed = {
      ...payload,
      payload: { ...payload.payload, verified: false, to: "blocked", note: "checksum mismatch" },
    };
    assert.deepEqual(validateShape(failed, STEP_ADVANCE_EVENT_SHAPE), []);
  });

  it("rejects a payload missing the step_id", () => {
    const bad = { ...payload, payload: without(payload.payload, "step_id") };
    const errors = validateShape(bad, STEP_ADVANCE_EVENT_SHAPE);
    assert.ok(errors.some((e) => e.includes("step_id") && e.includes("missing")), errors.join("\n"));
  });

  it("rejects a wrong type for verified", () => {
    const bad = { ...payload, payload: withField(payload.payload, "verified", "yes") };
    const errors = validateShape(bad, STEP_ADVANCE_EVENT_SHAPE);
    assert.ok(errors.some((e) => e.includes("verified")), errors.join("\n"));
  });

  it("rejects an unexpected extra field in the payload", () => {
    const bad = { ...payload, payload: withField(payload.payload, "progress", 0.5) };
    const errors = validateShape(bad, STEP_ADVANCE_EVENT_SHAPE);
    assert.ok(errors.some((e) => e.includes("progress") && e.includes("unexpected")), errors.join("\n"));
  });
});
