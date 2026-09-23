# Agent controls implementation plan

Goal: persistent steering, redirection, pause/resume/cancel in the production native loop.
Architecture: application/agent_control.py owns transactions and queued control messages;
agent_run_execution fences model/tool publication; DBOS carries epoch; HTTP/client/UI expose controls.
Tech stack: Python/Pydantic/SQLite/DBOS, React/TypeScript.

- [x] Write engine/tests/test_agent_controls.py: pending two-tool batch + steering must retain both results before next model call; redirect during generation must discard old final; pause/restart/resume must retain pending call; cancelled stale workflow cannot execute or fail a successor; duplicate command ID yields one correction and changed body conflicts; non-owner denied.
- [x] Run with engine/.venv/bin/python -m pytest -q engine/tests/test_agent_controls.py and establish RED before implementation.
- [x] Implement control(ctx, actor, work_id, run_id, body), control_in_store and consume_steering in application/agent_control.py. Use existing cached/save, require_work_access, authority, domain work.pause/work.cancel/plan.accept/work.start. Persist corrections in canonical user messages only after outstanding tool calls have results; redirect closes pending calls with explicit cancelled/unknown outcomes and a reminder to reconsider incomplete tasks.
- [x] Add epoch argument to advance/_claim and DBOS workflow; stale epoch returns superseded, never executes tools or fails current run. Revalidate lease immediately before dispatch, record active call, fence late results.
- [x] Intercept post_message admission for unique active native work owned by sender, enqueue steering and mark followup completed transactionally. Preserve ordinary interpretation for other chats and never route ambiguous active works.
- [x] Add POST /works/{work_id}/agent-runs/{run_id}/control with typed action/text/version, refresh OpenAPI. Wire client + separate EngineAgentControls panel and preserve runtime errors.
- [x] Verify focused control/native/HTTP tests, web typecheck/client tests, full engine suite, independent review, local commit. Update parity matrix without claiming full parity.

Evidence and remaining physical-cancellation limits: [verification report](../../research/2026-09-23-agent-controls-verifica.md).
