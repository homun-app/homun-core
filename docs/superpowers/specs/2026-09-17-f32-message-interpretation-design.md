# F3.2 — Message interpretation (model-first, Ollama-ready)

**Date:** 2026-09-17  
**Status:** accepted (implemented F3.2 slice B)  
**Depends on:** F3.1 (ModelRegistry, openai_compatible, fake)  
**Out of scope here:** plan draft/execution (F3.3), streaming (F3.5), memory (F3.5a), secret encryption (D-CRYPTO-01)

## Goal

When **Fonte=motore**, every user chat message is interpreted by the **active model provider** into a typed result. The UI shows a reply, a clarification, or a **non-executed** command proposal (plus ambiguous `@` candidates). Simulation stays untouched. No silent mix of sim ↔ engine.

Multilingual: intent comes from the model, not keyword/regex routing. Deterministic rules are **post-validation guardrails only** (e.g. reject invented IDs), never the preferred NLU path.

## Decisions (approved in conversation)

| Decision | Choice |
|----------|--------|
| Slice | **B** — engine interpret + wire ConversationWorkspace (Fonte=motore). Not A-then-replace. |
| Authority | Engine owns interpret + persistence; UI renders structured result. |
| Provider | Reuse `openai_compatible` with Ollama preset (`http://127.0.0.1:11434/v1`). |
| Structured output | Pydantic AI `Agent` + `output_type=MessageInterpretation` in the engine package. |
| Fake / CI | Same schema via fake or Pydantic AI `TestModel`; live Ollama tests are manual/optional, separate from CI. |
| Commands | Proposals only in F3.2 — domain does **not** apply plan patches yet (F3.3). |

## Architecture

```text
UI (Fonte=motore)          Engine                         Provider
─────────────────          ──────                         ────────
post message ───────────►  conversation.post_message
                           interpret(message, context)
                                │
                                ├─ Pydantic AI Agent
                                │    output_type=MessageInterpretation
                                ▼
                           guardrails (ID existence, mention cardinality)
                           persist assistant/system payload + usage
                           ◄──────────────────────────────── complete/structured
render reply / clarify /
command_proposal + @ UI
```

### Modules

| Module | Responsibility |
|--------|----------------|
| `homun/models/interpretation.py` | Pydantic models: `MessageInterpretation`, mention candidates, command proposal stub |
| `homun/models/interpret_agent.py` | Build Pydantic AI agent; map registry provider → model; run interpret |
| `homun/models/guardrails.py` | Thin post-checks: drop unknown IDs; force clarification if mention ≠ 1 match |
| `homun/routes/models.py` | `POST /v1/models/interpret` (testable without chat) |
| Domain post_message path | After save user message, call interpret, save typed assistant turn / event |
| `useEngineWorkspace.postMessage` | Replace F3 placeholder with engine interpretation payload |
| Thin UI | Show clarification / candidates / “proposta (non applicata)” — no new god-file growth in ConversationWorkspace |

### Schema (sketch)

```python
class MentionResolution(BaseModel):
    raw: str
    candidates: list[MentionCandidate]  # id + display + kind
    # 0 or >1 candidates → UI must choose; never auto-assign

class CommandProposal(BaseModel):
    type: str           # domain command type string
    payload: dict       # unvalidated draft for F3.3
    summary: str        # human-readable preview

class MessageInterpretation(BaseModel):
    kind: Literal["reply", "clarification", "command_proposal"]
    text: str | None = None
    command: CommandProposal | None = None
    mentions: list[MentionResolution] = []
    ambiguity: str | None = None
    language_hint: str | None = None  # optional; not used for routing
```

### Ollama preset

- Default local profile in registry / UI models panel: base URL `http://127.0.0.1:11434/v1`, model e.g. `llama3.2` (configurable, never hardcoded in domain).
- API key: accept explicit placeholder (`ollama` / `local`) so verify/complete work without a real OpenAI key.
- Active provider can be switched to `openai_compatible` for local testing; fake remains default for fresh installs and CI.

### Guardrails (after model)

1. Any `candidate.id` not in workspace roster → strip / fail that mention.
2. If any mention has `len(candidates) != 1` and the interpretation assumed a single assignee → rewrite to `clarification` or keep `command_proposal` with unresolved mentions for UI.
3. Invalid/empty structured output → typed engine error (`HomunClientError`), no invented reply text.

## UI behavior (Fonte=motore)

1. User sends text → existing `conversation.post_message`.
2. Engine returns (or follow-up read includes) interpretation.
3. Overlay/messages show:
   - **reply:** agent text
   - **clarification:** question + optional mention candidates
   - **command_proposal:** summary + honest “non applicata” copy (no Apply that mutates domain in F3.2)
4. Errors: `HomunErrorNotice`; never fall back to simulation copy.

**Request shape (first slice):** interpret runs **synchronously** inside the post-message / interpret path so the UI gets user turn + interpretation in one round-trip (or a single command result payload). Async jobs deferred to F3.5.

**Model context:** pass a compact roster of known people/agents (`id`, `display_name`, `kind`) into the agent prompt so mentions resolve to IDs from the list only — never free-invented IDs.

## Testing

| Layer | What |
|-------|------|
| Unit | Schema + guardrails (invented ID rejected; ambiguous @ → clarification) |
| Engine HTTP | `POST /v1/models/interpret` with fake/TestModel |
| Engine chat path | post_message yields interpretation payload in response or subsequent messages/events |
| Web | postMessage mapping; no placeholder string; simulation untouched |
| Manual | Ollama running → verify → send IT and EN message → structured reply or clarification |

## Explicit follow-ups (“sistemiamo dopo”)

- F3.3: validate model output → plan draft / same versioned patch as manual edits
- F3.5: streaming, partial message, timeout/retry
- Richer models settings UI
- D-CRYPTO-01 for secrets file
- Optional dedicated `ollama` provider kind (only if openai_compatible gaps appear)

## Non-goals

- Regex/keyword intent classification as primary path
- Executing command proposals in F3.2
- Claiming encryption or memory capabilities
- Growing ConversationWorkspace with interpret logic (extract hook/panel)

## Success criteria

1. With fake provider, CI proves interpret returns valid `MessageInterpretation` and guardrails hold.
2. With Ollama local + Fonte=motore, a free-form message (IT or EN) produces a visible reply or clarification — not the F3 placeholder.
3. Ambiguous `@` never becomes a silent person/agent assignment.
4. Capabilities remain honest; failures surface as typed errors.
