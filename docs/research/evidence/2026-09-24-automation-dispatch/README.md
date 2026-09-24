# Evidence: H26/H27 automation → agent_run (2026-09-24)

## Gap closed
- `inject_due_automation` feeds due heartbeat and loop prompts into `run["_steering"]`
  during `agent_run_execution._claim`, before `consume_steering`.
- Human `waiting_input` and pending tools preempt heartbeat.
- Active goals preempt loop ticks (Hermes precedence).

## Commands
```bash
cd engine && .venv/bin/python -m pytest tests/test_automation_dispatch.py -q
```

## Residual
- Background wake of idle queued runs (daemon poll) still open.
- Loop `complete_tick` after assistant response not yet hooked on finish.
