# ADR — Runtime Homun: Pydantic AI + DBOS

- **Date:** 2026-09-17
- **Status:** **Adopted** (product choice). Hardening backlog remains; this is not a temporary stack to replace.
- **Decision ID:** D-RUN-01 — closed
- **Versions that passed F0.2:** `pydantic-ai-slim` 2.44.0, `dbos` 3.0.0, Python 3.13, SQLite system DB

## Decision (Fabio, 2026-09-17)

**Pydantic AI + DBOS is the Homun 2 agent/runtime stack.** We build on it and improve it in place. We do not carry a parallel “plan B” orchestrator or plan to swap frameworks after F1.

Ownership split (unchanged):

- **Pydantic AI** — agent loop, typed outputs, model/tool adapters  
- **DBOS** — durable workflows, waits, crash/resume checkpoints  
- **Homun** — work/plan domain, permissions, budget, artifacts, receipts, peer policy  

Improvements (encryption of checkpoints, MCP/tools, packaging, retries policy) happen **behind Homun adapters**, not by replacing the runtime.

## Evidence from F0.2

Location: `experiments/engine/f0_2_runtime/`.

| Scenario | Script | Result |
|----------|--------|--------|
| Typed plan + human `recv` + kill + resume + contribution | `scripts/prove_kill_resume.sh` | **PASS** |
| External effect then step crash; retry reconciles once | `scripts/prove_uncertain_effect.sh` | **PASS** (`reconciled`, single receipt) |

Agent side used `TestModel` (no live LLM).

## Engineering rules that stay

1. No second orchestrator (do not add LangGraph on top of DBOS).  
2. Enable `retries_allowed` explicitly on steps that may fail after external I/O.  
3. External effects use Homun receipts / `command_id` — frameworks do not grant exactly-once alone.  
4. SQLite is fine for local desktop spike/dev; evaluate Postgres only for always-on hosts, without changing the Homun domain model.

## Hardening backlog (same stack)

These improve the adopted choice; they are not reopenings of D-RUN-01:

- [ ] Second agent profile + insert step mid-work without losing runs  
- [ ] Dynamic tool/MCP registration without losing active runs  
- [ ] Encryption / inspection of checkpoint DB and sensitive payloads (ties to D-CRYPTO-01)  
- [ ] Same proofs inside packaged Electron on a clean Mac (ties to D-DESK-01)  

## Historical note

Earlier drafts called this “provisional.” That wording is withdrawn: Homun will not treat Pydantic AI + DBOS as disposable scaffolding.
