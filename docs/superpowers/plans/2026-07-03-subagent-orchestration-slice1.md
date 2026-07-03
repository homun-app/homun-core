# Subagent Orchestration — Slice 1 Implementation Plan (ADR 0025)

> Subagent-driven + TDD. Converges on the ONE guarded loop (ADR 0021) — delegation-as-a-tool, NOT a second
> engine. Behind flag `HOMUN_SUBAGENTS` (default-off), behavior-preserving until validated on a weak model.

**Goal:** A model-callable `spawn_subagent` tool that lets the manager (motore #1) fan out N **read/gather**
children over the task-runtime, joins their results in-turn, and synthesizes — children inheriting the
manager's memory scope + sandbox/approval envelope; the manager remains the single writer.

**Reuse map (do NOT rebuild — cite before touching):**
- `run_agentic_step` — `crates/orchestrator/src/agentic.rs:69` (bounded 16-round read/gather loop; enum tool
  choice + `fill_arguments`; **injected executor closure**).
- `SubagentTask` — `crates/subagents/src/types.rs:147` (`parent_task_id`, `permission_envelope`, `budgets`).
- `subagent_write_mode` / `validate_single_threaded_writes` — `crates/orchestrator/src/subagent_workflow.rs:166/185`.
- Task-runtime — `crates/task-runtime` (`TaskStore`, `TaskScheduler::ready_tasks`, `ResourceGovernor` cap
  `LlmInference`, `ApprovalGate`, leases).
- Memory — `MemoryRecallService` (`crates/memory/src/service.rs:178`), `MemoryScope::{Personal,Project,Thread}`
  (`schema.rs:34`), single-writer `MemoryFacade`.
- Envelope — process-global `resolved_sandbox_mode()` (`main.rs:18772`); the chokepoint `execute_chat_tool`
  (`main.rs:18945`).
- Visibility — `emit_stream_event` `activity`/`plan_update`; `/api/local-computer/live`.

**Build gates:** `cargo test -p local-first-orchestrator`, `-p local-first-desktop-gateway`, `cargo check`.
Weak-model eval: `python3 scripts/eval_suite.py gemma4:latest` (fan-out read/gather + synthesis). Do NOT touch
`apps/desktop/scripts/check-ui-contract.mjs`.

---

## Task 0 (Fase-0 seam): `spawn_subagent` tool schema + flag + stub — pure addition, behavior-preserving

**Files:** `crates/desktop-gateway/src/main.rs` (schema + `execute_chat_tool` branch + `base_tools` gated).

- [ ] **Step 1:** add `fn subagents_enabled() -> bool { std::env::var("HOMUN_SUBAGENTS").as_deref() == Ok("1") }`
  (mirror `tool_safety_enabled` style).
- [ ] **Step 2:** add `spawn_subagent_tool_schema()` — function tool `spawn_subagent`, args
  `{ "tasks": [{ "goal": string, "contract"?: string }], "budget"?: number }` (array so one call fans out N).
  Description: "Delegate independent read/gather sub-tasks to parallel subagents; each researches/gathers and
  returns findings. Use for parallelizable investigation. Children cannot write — you synthesize + act on their
  results." Push into `base_tools` ONLY when `subagents_enabled() && !read_only_channel` (so default-off = tool
  absent = zero behavior change).
- [ ] **Step 3:** add the dispatch branch `} else if name == "spawn_subagent" {` — for now a STUB: if
  `!subagents_enabled()` return a "subagents are disabled" string (defensive; the tool isn't offered when off);
  else return `"‹‹ACT››👥 Spawning subagents‹‹/ACT›› (slice-1 wiring pending)"` and a clear model-facing note.
  This is the seam; Tasks 1-4 replace the stub body.
- [ ] **Step 4:** test `spawn_subagent_schema_shape` (args shape) + `subagents_enabled` env precedence
  (hermetic, `unsafe { set_var }` per the Rust-2024 convention). `cargo test` + `cargo check` clean. Commit
  `feat(gateway): spawn_subagent tool seam behind HOMUN_SUBAGENTS (ADR 0025)`.

## Task 1: child loop = `run_agentic_step` delegating to `execute_chat_tool`

**Files:** `main.rs` (a `ChatSubagentExecutor` impl of the agentic executor seam), reuse `agentic.rs`.

- [ ] **Step 1:** build an executor that `run_agentic_step` calls, whose tool-execution closure delegates to
  the gateway's real dispatch (`execute_chat_tool`) restricted to read/gather tools (Read/Draft) — so the child
  inherits the sandbox envelope for free and uses motore #1 native tool-calling (NOT `generate_json`). Confirm
  the read/gather restriction via `subagent_write_mode` (reject write tools).
- [ ] **Step 2:** unit-test the executor with a fake dispatch (no HTTP): child chooses a read tool, gathers,
  synthesizes; a write tool is rejected. Commit.

## Task 2: manager fan-out/join over the task-runtime

**Files:** `main.rs` (the `spawn_subagent` handler body), reuse task-runtime + `ResourceGovernor`.

- [ ] **Step 1:** the handler enqueues one `SubagentTask` per `goal` (`parent_task_id` = manager's task id,
  envelope derived from the manager's resolved policy — Task 3), under a per-manager child budget + the
  `LlmInference` governor (so naive fan-out doesn't starve). Await joined results (bounded by budget/timeout).
- [ ] **Step 2:** synthesize: return a single model-facing block summarizing each child's findings
  (`evidence=[…]`), so the manager can act on it in-turn. The manager remains the writer.
- [ ] **Step 3:** test the fan-out/join with fake children (2 tasks → 2 joined results → synthesized block);
  test governor serialization doesn't deadlock. Commit.

## Task 3: memory-scope threading + envelope inheritance (SECURITY-critical)

**Files:** `main.rs` (pass scope + derive envelope), reuse `MemoryScope`, `subagent_workflow.rs`.

- [ ] **Step 1:** thread the manager's `MemoryScope` (Thread{project,thread_id} or Project) into each child's
  `brief`/`recall`/`learn`. A child MUST NOT default to `Personal` or a different workspace. Derive each child's
  `permission_envelope` from the manager's resolved policy, fail-closed (`subagent_write_mode`).
- [ ] **Step 2:** SECURITY tests: (a) a child's recall/learn uses the manager's exact scope (no leakage to
  Personal / another workspace) — assert the scope passed to the facade equals the manager's; (b) a child
  cannot escalate its envelope beyond the manager's; (c) `validate_single_threaded_writes` rejects two parallel
  writers. These are the net-new leakage guards flagged in ADR 0025. Commit.

## Task 4: visibility + weak-model validation

- [ ] **Step 1:** emit each child's steps as `activity`/`plan_update` events on the manager's thread; reuse the
  activity panel. Any child side-effect approval → the manager's `ApprovalGate`.
- [ ] **Step 2:** VALIDATE on a weak model (caposaldo #2): `HOMUN_SUBAGENTS=1` + a fan-out prompt on
  `gemma4:latest` — assert the manager spawns read/gather children, they gather, the manager synthesizes a
  correct answer. Paste evidence. Only after this is green should the flag be considered for default-on.
- [ ] **Step 3:** docs: `architecture/subagents.md` (the delegation-as-a-tool shape + reuse map + envelope/scope
  inheritance + the read/gather-only invariant), STATO. Commit.

---

## Self-review
- Coverage: seam (T0) + child loop (T1) + fan-out/join (T2) + scope/envelope (T3, security) + visibility/eval (T4).
- The two-engine risk is mitigated by T1 (child delegates to `execute_chat_tool`, not the drive).
- The scope-leakage risk (net-new, security) is the crux → T3 tests it explicitly.
- Weak-model validation (T4) is mandatory before default-on (caposaldo #2).
- Deferred: agentic scope beyond read/gather (child writes single-threaded + approval) — a later slice once
  read/gather is a fixed point.
