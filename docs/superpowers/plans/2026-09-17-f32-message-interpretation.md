# F3.2 Message Interpretation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Fonte=motore, each user message is interpreted by the active model into a typed `MessageInterpretation`, validated by thin guardrails, persisted/returned by the engine, and shown in chat (reply / clarification / non-executed command proposal) — with Ollama via `openai_compatible` and fake/TestModel for CI.

**Status:** Implemented (2026-09-17). Engine 31 tests + web 106 tests green.

**Architecture:** Pydantic AI Agent with `output_type=MessageInterpretation` for live providers; FakeProvider returns the same schema without network. After `conversation.post_message`, the engine runs interpret synchronously, applies mention/ID guardrails, emits `message.interpreted`, stores a display assistant message, and returns the structured payload. UI replaces the F3 placeholder. Simulation path unchanged.

**Tech Stack:** Python 3.12+, FastAPI, Pydantic v2, `pydantic-ai` (OpenAI-compatible → Ollama), React/TS web client, pytest + node:test.

**Spec:** `docs/superpowers/specs/2026-09-17-f32-message-interpretation-design.md`

**Commits:** Only when the user explicitly asks — do not auto-commit.

---

## File map

| File | Responsibility |
|------|----------------|
| `engine/pyproject.toml` | Add `pydantic-ai` dependency |
| `engine/src/homun/models/interpretation.py` | Schema: `MessageInterpretation`, mentions, command proposal |
| `engine/src/homun/models/guardrails.py` | Post-model ID/mention validation |
| `engine/src/homun/models/interpret.py` | Orchestrate fake vs Pydantic AI interpret |
| `engine/src/homun/models/fake.py` | Add deterministic `interpret(...)` (same schema; no intent-regex as product NLU) |
| `engine/src/homun/models/openai_compat.py` | Allow placeholder API keys (`ollama`, `local`); optional Ollama notes |
| `engine/src/homun/models/registry.py` | `interpret(...)`, Ollama preset helper, wire fake/openai |
| `engine/src/homun/routes/models.py` | `POST /v1/models/interpret` + Ollama preset endpoint |
| `engine/src/homun/domain/service.py` | After post_message → interpret → return + event |
| `engine/tests/test_interpret_f32.py` | Schema, guardrails, HTTP, post_message path |
| `apps/web/src/lib/engine-models-client.ts` | `interpretMessage`, Ollama preset client helpers |
| `apps/web/src/lib/conversation-engine-bridge.ts` | `postEngineConversationMessage` returns interpretation |
| `apps/web/src/hooks/useEngineWorkspace.ts` | Render interpretation instead of placeholder |
| `apps/web/src/components/EngineModelsPanel.tsx` | “Usa Ollama locale” button |
| `engine/README.md`, piano, roadmap | Mark F3.2 progress / Ollama curl |

---

### Task 1: Interpretation schema + guardrails (TDD)

**Files:**
- Create: `engine/src/homun/models/interpretation.py`
- Create: `engine/src/homun/models/guardrails.py`
- Create: `engine/tests/test_interpret_f32.py`

- [ ] **Step 1: Write failing tests for schema + guardrails**

```python
# engine/tests/test_interpret_f32.py
from __future__ import annotations

from homun.models.guardrails import apply_interpretation_guardrails
from homun.models.interpretation import (
    CommandProposal,
    MentionCandidate,
    MentionResolution,
    MessageInterpretation,
    RosterEntry,
)


def test_message_interpretation_roundtrip() -> None:
    raw = MessageInterpretation(
        kind="reply",
        text="Ciao",
        mentions=[],
    )
    assert MessageInterpretation.model_validate(raw.model_dump()).kind == "reply"


def test_guardrails_strip_unknown_candidate_ids() -> None:
    roster = [
        RosterEntry(id="person_fabio", display_name="Fabio", kind="person"),
        RosterEntry(id="agent_vera", display_name="Vera", kind="agent"),
    ]
    interp = MessageInterpretation(
        kind="command_proposal",
        text="Assegna a Vera",
        command=CommandProposal(
            type="work.assign",
            payload={"assignee_id": "agent_invented"},
            summary="Assegna a qualcuno",
        ),
        mentions=[
            MentionResolution(
                raw="@Vera",
                candidates=[
                    MentionCandidate(id="agent_vera", display_name="Vera", kind="agent"),
                    MentionCandidate(id="agent_ghost", display_name="Ghost", kind="agent"),
                ],
            )
        ],
    )
    fixed = apply_interpretation_guardrails(interp, roster)
    assert all(c.id != "agent_ghost" for m in fixed.mentions for c in m.candidates)
    assert fixed.mentions[0].candidates[0].id == "agent_vera"


def test_guardrails_ambiguous_mention_becomes_clarification() -> None:
    roster = [
        RosterEntry(id="a1", display_name="Alex", kind="person"),
        RosterEntry(id="a2", display_name="Alex", kind="agent"),
    ]
    interp = MessageInterpretation(
        kind="command_proposal",
        text="Chiedi ad Alex",
        command=CommandProposal(type="work.assign", payload={}, summary="Assegna"),
        mentions=[
            MentionResolution(
                raw="@Alex",
                candidates=[
                    MentionCandidate(id="a1", display_name="Alex", kind="person"),
                    MentionCandidate(id="a2", display_name="Alex", kind="agent"),
                ],
            )
        ],
    )
    fixed = apply_interpretation_guardrails(interp, roster)
    assert fixed.kind == "clarification"
    assert fixed.command is None
    assert len(fixed.mentions[0].candidates) == 2
```

- [ ] **Step 2: Run tests — expect import/fail**

Run: `cd engine && .venv/bin/pytest tests/test_interpret_f32.py -q`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement schema + guardrails**

```python
# engine/src/homun/models/interpretation.py
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class RosterEntry(BaseModel):
    id: str
    display_name: str
    kind: Literal["person", "agent", "other"] = "person"


class MentionCandidate(BaseModel):
    id: str
    display_name: str
    kind: Literal["person", "agent", "other"] = "person"


class MentionResolution(BaseModel):
    raw: str
    candidates: list[MentionCandidate] = Field(default_factory=list)


class CommandProposal(BaseModel):
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    summary: str


class MessageInterpretation(BaseModel):
    kind: Literal["reply", "clarification", "command_proposal"]
    text: str | None = None
    command: CommandProposal | None = None
    mentions: list[MentionResolution] = Field(default_factory=list)
    ambiguity: str | None = None
    language_hint: str | None = None
```

```python
# engine/src/homun/models/guardrails.py
from __future__ import annotations

from homun.models.interpretation import (
    MentionResolution,
    MessageInterpretation,
    RosterEntry,
)


def apply_interpretation_guardrails(
    interpretation: MessageInterpretation,
    roster: list[RosterEntry],
) -> MessageInterpretation:
    allowed = {entry.id for entry in roster}
    cleaned_mentions: list[MentionResolution] = []
    for mention in interpretation.mentions:
        candidates = [c for c in mention.candidates if c.id in allowed]
        cleaned_mentions.append(MentionResolution(raw=mention.raw, candidates=candidates))

    data = interpretation.model_copy(deep=True)
    data.mentions = cleaned_mentions

    ambiguous = [m for m in cleaned_mentions if len(m.candidates) != 1]
    if ambiguous and data.kind == "command_proposal":
        names = ", ".join(m.raw for m in ambiguous)
        data.kind = "clarification"
        data.command = None
        data.ambiguity = data.ambiguity or f"Ambiguous mention(s): {names}"
        data.text = data.text or (
            f"Non posso assegnare senza una scelta univoca per: {names}. "
            "Seleziona il candidato in elenco."
        )
    return data
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd engine && .venv/bin/pytest tests/test_interpret_f32.py -q`  
Expected: PASS (3 tests)

---

### Task 2: Fake interpret + registry.interpret (no live LLM)

**Files:**
- Modify: `engine/src/homun/models/fake.py`
- Modify: `engine/src/homun/models/registry.py`
- Modify: `engine/src/homun/models/__init__.py`
- Modify: `engine/tests/test_interpret_f32.py`

- [ ] **Step 1: Add failing test for fake interpret**

```python
def test_fake_interpret_is_structured_reply() -> None:
    from homun.models.fake import FakeProvider
    from homun.models.interpretation import RosterEntry

    provider = FakeProvider()
    roster = [RosterEntry(id="person_fabio", display_name="Fabio", kind="person")]
    result = provider.interpret("Prepara il catalogo", roster=roster)
    assert result.kind in ("reply", "clarification", "command_proposal")
    assert result.text
    # Exact @Name with one roster hit → single candidate
    mentioned = provider.interpret("Ciao @Fabio", roster=roster)
    assert any(m.raw == "@Fabio" and len(m.candidates) == 1 for m in mentioned.mentions)
```

Note: matching `@DisplayName` against the **roster list** is ID resolution, not multilingual intent classification.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `FakeProvider.interpret`**

```python
# Add to fake.py
import re
from homun.models.interpretation import MentionCandidate, MentionResolution, MessageInterpretation, RosterEntry

_MENTION = re.compile(r"@([^\s@]+)")

def interpret(self, text: str, *, roster: list[RosterEntry]) -> MessageInterpretation:
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]
    mentions: list[MentionResolution] = []
    for raw_name in _MENTION.findall(text):
        raw = f"@{raw_name}"
        candidates = [
            MentionCandidate(id=e.id, display_name=e.display_name, kind=e.kind)
            for e in roster
            if e.display_name.casefold() == raw_name.casefold() or e.id == raw_name
        ]
        mentions.append(MentionResolution(raw=raw, candidates=candidates))
    return MessageInterpretation(
        kind="reply",
        text=(
            f"[fake-interpret:{digest}] Ricevuto. "
            "Modalità fake: risposta strutturata deterministica (nessun LLM)."
        ),
        mentions=mentions,
    )
```

- [ ] **Step 4: Add `ModelRegistry.interpret`**

```python
def interpret(
    self,
    text: str,
    *,
    roster: list[RosterEntry],
    provider_id: str | None = None,
) -> MessageInterpretation:
    from homun.models.guardrails import apply_interpretation_guardrails
    from homun.models.interpret import run_interpret

    pid = provider_id or self.active_provider_id
    raw = run_interpret(self, text, roster=roster, provider_id=pid)
    return apply_interpretation_guardrails(raw, roster)
```

For Task 2 only, `run_interpret` may live temporarily as:

```python
# engine/src/homun/models/interpret.py
def run_interpret(registry, text, *, roster, provider_id):
    if provider_id == "fake":
        return registry._fake.interpret(text, roster=roster)
    raise RuntimeError("Live interpret not wired yet")
```

- [ ] **Step 5: Tests PASS for fake path**

---

### Task 3: Pydantic AI live interpret + Ollama-friendly credentials

**Files:**
- Modify: `engine/pyproject.toml` — add `"pydantic-ai>=1.0.0"`
- Create/finish: `engine/src/homun/models/interpret.py`
- Modify: `engine/src/homun/models/openai_compat.py`
- Modify: `engine/src/homun/models/registry.py`
- Shell: reinstall engine deps

- [ ] **Step 1: Add dependency and reinstall**

```toml
# engine/pyproject.toml dependencies list — add:
"pydantic-ai>=1.0.0",
```

Run: `cd engine && uv pip install -e ".[dev]" --python .venv/bin/python`

- [ ] **Step 2: Allow placeholder API keys for local gateways**

In `OpenAICompatibleProvider.verify_connection` / `complete` / `_api_key`: treat missing key as `"ollama"` when `base_url` host is localhost/127.0.0.1 **or** accept stored keys `ollama` / `local` as valid. Prefer: if no key and base_url looks local, use `Bearer ollama`.

```python
def _api_key(self) -> str | None:
    key = self._secrets.get(SECRET_KEY)
    if key:
        return key
    host = self.base_url.lower()
    if "127.0.0.1" in host or "localhost" in host:
        return "ollama"
    return None
```

Update verify message accordingly. Adjust F3.1 test that required missing-key failure for remote URLs — keep remote-without-key failing.

- [ ] **Step 3: Implement live `run_interpret` with Pydantic AI**

```python
# engine/src/homun/models/interpret.py
from __future__ import annotations

from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from homun.models.interpretation import MessageInterpretation, RosterEntry
from homun.models.registry import ModelRegistry

INSTRUCTIONS = """You classify the user message for a work chat product.
Return ONLY the structured MessageInterpretation.
kind:
- reply: answer or acknowledge without changing work structure
- clarification: need info or ambiguous @mention
- command_proposal: user wants a domain change (summarize; do not claim it was executed)
Mentions: only propose candidate IDs from the provided roster. Never invent IDs.
Language: respond in the user's language.
"""

def run_interpret(
    registry: ModelRegistry,
    text: str,
    *,
    roster: list[RosterEntry],
    provider_id: str,
) -> MessageInterpretation:
    if provider_id == "fake":
        return registry._fake.interpret(text, roster=roster)

    if provider_id != "openai_compatible":
        raise KeyError(f"Unknown provider for interpret: {provider_id}")

    provider = registry._openai
    api_key = provider._api_key()
    if not api_key:
        raise RuntimeError("openai_compatible provider has no API key configured")

    model = OpenAIChatModel(
        provider.default_model,
        provider=OpenAIProvider(base_url=provider.base_url, api_key=api_key),
    )
    agent: Agent[None, MessageInterpretation] = Agent(
        model,
        output_type=MessageInterpretation,
        instructions=INSTRUCTIONS,
    )
    roster_lines = "\n".join(
        f"- {e.id} | {e.display_name} | {e.kind}" for e in roster
    ) or "(empty roster)"
    prompt = f"Roster:\n{roster_lines}\n\nUser message:\n{text}"
    result = agent.run_sync(prompt)
    return result.output
```

If import paths differ in installed pydantic-ai version, adjust to the package’s current OpenAI-compatible constructors (check Context7 / installed docs). Keep `output_type=MessageInterpretation`.

- [ ] **Step 4: Unit test with `TestModel` (optional but preferred)**

```python
def test_interpret_agent_with_test_model() -> None:
    from pydantic_ai.models.test import TestModel
    from pydantic_ai import Agent
    from homun.models.interpretation import MessageInterpretation

    agent = Agent(
        TestModel(),
        output_type=MessageInterpretation,
        instructions="test",
    )
    # TestModel generates valid structured output for the type
    out = agent.run_sync("hello").output
    assert isinstance(out, MessageInterpretation)
```

- [ ] **Step 5: `registry.apply_ollama_preset(model: str = "llama3.2")`**

Sets `openai_compatible` base_url to `http://127.0.0.1:11434/v1`, default_model, stores api_key `ollama`, sets active provider to `openai_compatible`.

- [ ] **Step 6: Engine tests still green**

Run: `npm run engine:test`  
Expected: all PASS (including prior F3.1)

---

### Task 4: HTTP `POST /v1/models/interpret` + Ollama preset route

**Files:**
- Modify: `engine/src/homun/routes/models.py`
- Modify: `engine/tests/test_interpret_f32.py`

- [ ] **Step 1: Failing HTTP test**

```python
def test_http_interpret_fake(tmp_path) -> None:
    from fastapi.testclient import TestClient
    from homun.app import create_app
    from homun.context import create_context, reset_context_for_tests

    db_path = tmp_path / "ws_local.sqlite3"
    reset_context_for_tests(
        create_context(workspace_id="ws_local", db_path=db_path, data_dir=tmp_path, for_tests=True)
    )
    app = create_app()
    with TestClient(app) as client:
        reset_context_for_tests(
            create_context(workspace_id="ws_local", db_path=db_path, data_dir=tmp_path, for_tests=True)
        )
        response = client.post(
            "/v1/models/interpret",
            json={
                "text": "Ciao @Fabio",
                "roster": [
                    {"id": "person_fabio", "display_name": "Fabio", "kind": "person"}
                ],
                "provider_id": "fake",
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["kind"] in ("reply", "clarification", "command_proposal")
        assert body["text"]
```

- [ ] **Step 2: Implement route**

```python
class InterpretRequest(BaseModel):
    text: str
    roster: list[RosterEntry] = Field(default_factory=list)
    provider_id: str | None = None

class OllamaPresetRequest(BaseModel):
    model: str = "llama3.2"

@router.post("/interpret")
def interpret_message(body: InterpretRequest) -> dict[str, Any]:
    ctx = get_context()
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail={"code": "validation_error", "message": "text required"})
    try:
        result = ctx.models.interpret(text, roster=body.roster, provider_id=body.provider_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": str(exc)}) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail={"code": "provider_unavailable", "message": str(exc)}) from exc
    return result.model_dump(mode="json")

@router.post("/providers/openai_compatible/ollama_preset")
def apply_ollama_preset(body: OllamaPresetRequest) -> dict[str, Any]:
    ctx = get_context()
    ctx.models.apply_ollama_preset(model=body.model)
    return {
        "ok": True,
        "active_provider_id": ctx.models.active_provider_id,
        "base_url": "http://127.0.0.1:11434/v1",
        "default_model": body.model,
    }
```

- [ ] **Step 3: Tests PASS**

---

### Task 5: Wire `conversation.post_message` → interpret (sync)

**Files:**
- Modify: `engine/src/homun/domain/service.py` — inject optional interpret callback **or** interpret at HTTP/route layer to avoid domain→models coupling

**Preferred (keep domain pure):** interpret in the **domain HTTP route** after successful command, not inside `DomainService._conversation_post_message`.

- [ ] **Step 1: Locate domain command route** (e.g. `engine/src/homun/routes/domain.py`) where commands are dispatched.

- [ ] **Step 2: After successful `conversation.post_message`, if models capability available:**

```python
# Pseudocode in domain route handler
result = service.handle(...)
if command_type == "conversation.post_message":
    text = payload["text"]
    roster = payload.get("roster") or default_roster_from_actor(actor)
    interpretation = ctx.models.interpret(text, roster=roster_entries)
    # Persist assistant display message via a small helper on service or second command
    assistant = service.append_system_message(
        conversation_id=...,
        author_id="homun_engine",
        text=format_interpretation_for_chat(interpretation),
        actor=actor,
        command_id=f"{command_id}:interpret",
    )
    result["interpretation"] = interpretation.model_dump(mode="json")
    result["assistant_message_id"] = assistant["message_id"]
    # emit event message.interpreted with interpretation payload
```

If `append_system_message` does not exist, add a focused method on `DomainService` that only appends a message + event (no interpret logic inside domain).

```python
def format_interpretation_for_chat(interp: MessageInterpretation) -> str:
    if interp.kind == "reply":
        return interp.text or "(vuoto)"
    if interp.kind == "clarification":
        base = interp.text or "Serve un chiarimento."
        if interp.mentions:
            opts = "; ".join(
                f"{m.raw}: " + ", ".join(f"{c.display_name} ({c.id})" for c in m.candidates)
                or "nessun candidato"
                for m in interp.mentions
            )
            return f"{base}\nCandidati: {opts}"
        return base
    # command_proposal
    summary = interp.command.summary if interp.command else (interp.text or "Proposta")
    return f"{summary}\n(Proposta non applicata — F3.3)"
```

- [ ] **Step 3: Test via TestClient: create conversation, post_message, assert `interpretation` in command result**

```python
def test_post_message_includes_interpretation(tmp_path) -> None:
    # setup client + context as other domain tests
    # POST conversation.create, then conversation.post_message with text
    # assert result["interpretation"]["kind"] exists
    # assert a second message exists in store or events include message.interpreted
```

Follow existing domain test patterns in `engine/tests/` for headers `X-Homun-Actor-*`.

- [ ] **Step 4: Tests PASS**

---

### Task 6: Web client + Fonte=motore chat wire

**Files:**
- Modify: `apps/web/src/lib/conversation-engine-bridge.ts`
- Modify: `apps/web/src/hooks/useEngineWorkspace.ts`
- Modify: `apps/web/src/lib/engine-models-client.ts`
- Modify: `apps/web/src/components/EngineModelsPanel.tsx`
- Create if needed: `apps/web/src/lib/interpretation-display.ts` (pure formatter, keep Workspace thin)
- Test: `tests/engine-client.test.ts` or new `tests/interpretation-display.test.ts`

- [ ] **Step 1: Types + display helper**

```typescript
// apps/web/src/lib/interpretation-display.ts
export type MessageInterpretation = {
  kind: "reply" | "clarification" | "command_proposal";
  text?: string | null;
  command?: { type: string; payload: Record<string, unknown>; summary: string } | null;
  mentions: Array<{
    raw: string;
    candidates: Array<{ id: string; display_name: string; kind: string }>;
  }>;
  ambiguity?: string | null;
};

export function formatInterpretationForUi(interp: MessageInterpretation): string {
  if (interp.kind === "reply") return interp.text?.trim() || "(Risposta vuota)";
  if (interp.kind === "clarification") {
    const bits = [interp.text?.trim() || "Serve un chiarimento."];
    for (const m of interp.mentions) {
      const opts = m.candidates.map((c) => `${c.display_name} (${c.id})`).join(", ");
      bits.push(`${m.raw}: ${opts || "nessun candidato"}`);
    }
    return bits.join("\n");
  }
  const summary = interp.command?.summary ?? interp.text ?? "Proposta comando";
  return `${summary}\n(Proposta non applicata — F3.3)`;
}
```

- [ ] **Step 2: Change `postEngineConversationMessage` to return `{ messageId, interpretation }`**

Parse `result.result.interpretation` from command response; throw typed error if engine errors (existing client path).

Pass default roster:

```typescript
roster: [{ id: actor.id, display_name: actor.name ?? actor.id, kind: "person" }],
```

in the command payload.

- [ ] **Step 3: Update `useEngineWorkspace.postMessage`**

Replace placeholder agent message with `formatInterpretationForUi(interpretation)`.

- [ ] **Step 4: EngineModelsPanel — button “Usa Ollama locale”**

Calls `POST /v1/models/providers/openai_compatible/ollama_preset` then refresh providers.

- [ ] **Step 5: Unit test for `formatInterpretationForUi`**

- [ ] **Step 6: `npm run typecheck && npm test && npm run build` + `npm run engine:test`**

Expected: all green.

---

### Task 7: Docs

**Files:**
- Modify: `engine/README.md` — Ollama preset + interpret curl + note chat Fonte=motore
- Modify: `docs/development/2026-09-17-piano-sviluppo.md` — check F3.2
- Modify: `roadmap.md` — F3.2 done / in progress as accurate
- Modify: spec status line to `accepted`

- [ ] **Step 1: README snippet**

```bash
# Ollama preset (engine must reach 127.0.0.1:11434)
curl -sS -X POST http://127.0.0.1:8765/v1/models/providers/openai_compatible/ollama_preset \
  -H 'Content-Type: application/json' -d '{"model":"llama3.2"}'

curl -sS -X POST http://127.0.0.1:8765/v1/models/interpret \
  -H 'Content-Type: application/json' \
  -d '{"text":"Prepare a catalog","roster":[{"id":"person_fabio","display_name":"Fabio","kind":"person"}]}'
```

- [ ] **Step 2: Mark F3.2 `[x]` in piano when implementation verified**

---

## Spec coverage checklist

| Spec item | Task |
|-----------|------|
| B: engine + chat wire | 5, 6 |
| Pydantic AI structured output | 3 |
| Ollama via openai_compatible | 3, 4, 6 |
| Fake/CI same schema | 2, 4 |
| Guardrails / no invented IDs | 1 |
| Ambiguous @ → clarification | 1 |
| Commands not executed | 5, 6 display copy |
| Sync interpret | 5 |
| Roster in context | 3, 5, 6 |
| No ConversationWorkspace god growth | 6 (hook + pure helper) |
| Docs | 7 |

## Placeholder / consistency review

- Types named `MessageInterpretation`, `RosterEntry`, `apply_interpretation_guardrails`, `run_interpret`, `apply_ollama_preset` consistently across tasks.
- No TBD steps; pydantic-ai import paths may need a one-line adjust to installed version — verify during Task 3 against package docs.
- Domain stays free of LLM calls; route layer orchestrates (Task 5).

---

## Manual verify (after Task 6)

1. `ollama serve` + `ollama pull llama3.2`
2. `npm run engine:dev`
3. UI: Usa Ollama locale → verify provider
4. Fonte=motore → new conversation → send Italian and English messages
5. Confirm no F3 placeholder; clarification if ambiguous @
