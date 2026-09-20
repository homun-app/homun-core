# F3.4 — Versioned work patch (chat + manual, preview then confirm)

**Date:** 2026-09-18  
**Status:** accepted  
**Depends on:** F3.2 (interpret + guardrails), F3.3 (PlanDraft → `plan.propose`)  
**Out of scope here:** Homun intake / agent staffing suggestions (product direction C), streaming (F3.5), memory (F3.5a), step execution (F4), simulation Marta routing, YOLO / permanent allowlists  
**First-cut fields:** `objective`, `owner_id`, `step_assignee` (required). `step_title` included only if validation stays trivial in the same PR; otherwise deferred.

## Goal

When **Fonte=motore**, changes to a work’s **objective**, **owner**, or **plan step assignees/titles** — whether proposed from chat or built in the manual UI — must produce the **same versioned patch**, with a **readable preview**, applied only after explicit **Conferma** (or discarded with **Annulla**).

No silent jump to an agent chat. No inventing roster IDs. Simulation stays isolated.

## Decisions (approved in conversation)

| Decision | Choice |
|----------|--------|
| Product slice | **B** — engine + chat path for «cambia obiettivo…» / «assegna a @…» with preview → confirm |
| Confirm UX | **Card buttons** Conferma / Annulla (Hermes-style once/deny; not free-text «sì» alone) |
| Architecture | **Unified `WorkPatch`** — one preview + one apply used by chat and manual UI |
| Inspiration | [Hermes Agent](https://hermes-agent.nousresearch.com/) approval flow and observable changes — adapted to Homun’s work/plan model, not shell YOLO |
| Interpret kind | Dedicated `patch_proposal` after engine `preview_patch` (not raw unvalidated `command_proposal`) |
| Pending state | Ephemeral: proposal lives on the assistant message / event payload — **no** pending_patch table in F3.4 |
| Annulla | Chat ack only (no domain mutation); optional audit event later |

## Architecture

```text
UI (Fonte=motore)                 Engine                         Provider
─────────────────                 ──────                         ────────
user: «assegna passo 1 a @Vera»
  post_message ────────────────►  interpret → patch intent
                                  work.preview_patch(changes)
                                  append assistant turn + patch payload
                                  ◄─────────────────────────────
render PatchPreviewCard
  [Conferma] [Annulla]
Conferma ──────────────────────►  work.apply_patch(same changes,
                                    expected_version)
                                  bump work.version (+ plan.revise if needed)
                                  append confirmation turn
Annulla ───────────────────────►  work.discard_patch (or chat-only ack)
                                  no domain mutation
```

Manual panel builds the same `changes[]` and calls the same `preview_patch` / `apply_patch` (no second code path).

### Modules (keep small — no ConversationWorkspace growth)

| Module | Responsibility |
|--------|----------------|
| `homun/domain/patch.py` | `WorkPatchChange`, `WorkPatchProposal`, validate against work + roster + plan |
| `homun/domain/service.py` | Commands `work.preview_patch`, `work.apply_patch` |
| `homun/models/interpretation.py` + `interpret.py` | `kind: patch_proposal` + draft changes; engine runs `preview_patch` before UI |
| `homun/models/guardrails.py` | Reject unknown IDs; force clarification if `@` ≠ 1 candidate |
| Thin UI | `WorkPatchPreviewCard` + wire confirm/cancel in engine postMessage overlay |
| Fake provider | Deterministic patch proposals for CI |

### Schema (sketch)

```python
PatchField = Literal[
    "objective",
    "owner_id",
    "step_assignee",
    "step_title",  # first cut only if trivial; else omit
]

class WorkPatchChange(BaseModel):
    field: PatchField
    from_value: str | None = None
    to_value: str | None = None
    step_id: str | None = None  # required for step_* fields

class WorkPatchProposal(BaseModel):
    work_id: str
    base_version: int
    changes: list[WorkPatchChange]
    summary_lines: list[str]  # Italian (or user language) for the card
    missing_or_ambiguous: list[str] = []  # if non-empty → no apply, show clarify
```

### Commands

| Command | Mutates? | Behavior |
|---------|----------|----------|
| `work.preview_patch` | No | Validate `changes` against current work/plan/roster; fill `from_value` + `summary_lines`; return proposal |
| `work.apply_patch` | Yes | Require `expected_version == work.version`; apply all changes atomically; bump version; if any plan field → new plan revision (reuse `plan.revise` internals or equivalent); emit `work.patched` |
| (Annulla) | No | UI acknowledges; no `apply_patch`. Domain unchanged. |

Conflict → **409** with typed code; UI asks to refresh and re-preview.

### Chat interpretation

- New interpret kind: `patch_proposal` (draft changes only).
- On `post_message`, if kind is patch and work exists: engine runs **`preview_patch`** then attaches the validated `WorkPatchProposal` to the assistant turn (never show unvalidated `to` IDs).
- Ambiguous `@` → `clarification` (existing F3.2), not a patch card.
- First message that creates work remains F3.3 plan propose path; F3.4 applies to **existing** engine-backed work.

### UI

- Card shows each `summary_lines` entry (e.g. `Obiettivo: «…» → «…»`, `Passo “Bozza”: person_fabio → agent_vera`).
- **Conferma** / **Annulla** only (no permanent “always allow” in F3.4).
- After apply: short Homun turn + refresh work/plan from engine.
- Manual edit panel (minimal): same card + buttons when user edits objective/owner/assignee in the side panel.

### Fake / tests

- Fake: fixed phrases map to objective / step_assignee changes.
- Tests: preview fills `from_value`; apply bumps version; second apply with stale version → 409; chat confirm path equals direct API apply; unknown assignee rejected.
- Live Ollama optional, not CI.

## Non-goals (explicit)

- Auto-open Marta / assignee chat after patch.
- Creating new agents from «serve un agente che…» (later intake slice).
- Merging unrelated interpret replies into the same patch without user confirm.
- Streaming partial patch cards (F3.5).

## Gate

1. Fake: chat «cambia obiettivo a X» → preview card → Conferma → `work.objective == X` and version +1.  
2. Fake: «assegna [passo] a @Vera» with unique roster hit → apply → step assignee updated via new plan revision.  
3. Manual UI builds identical `changes` → same `apply_patch` result.  
4. Ambiguous `@` → clarification, no mutation.  
5. Stale `expected_version` → 409, no partial apply.

## Resolved for first cut

- Pending proposal: **message/event payload only** (survives reload if messages are reloaded from engine; no pending table).
- `step_title`: include in schema; implement in the same PR only if cheap — otherwise leave unimplemented and document in the plan.
