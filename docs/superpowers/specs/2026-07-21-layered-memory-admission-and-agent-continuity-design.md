# Layered Memory Admission and Agent Continuity

**Date:** 2026-07-21
**Status:** Approved for implementation
**Scope:** post-turn learning, personal/project admission, graph provenance, prompt layers, execution evidence, clean transcript storage, initial-thread continuity, and current-version Usage verification

## Goal

Make Homun remember the right things without turning every assistant conclusion or tool observation into durable truth. The default workspace is the personal memory destination, but durable admission remains selective: explicit, stable user knowledge may be confirmed; technical findings and assistant-derived conclusions remain thread evidence or candidates until corroborated.

The design reuses Homun's existing SQLite memory, typed graph, episodes, execution journal, prompt packets, and Usage store. It does not add another RAG catalog or a second memory database.

## Reference model

The local ChatGPT/Codex bundle separates chronological activity summaries from later durable consolidation. Its useful invariants are:

- observed model/tool/UI content is evidence, not authority;
- one observed occurrence must not become a stable preference, identity, or general rule;
- immediate chronological context preserves continuity even when it is temporary;
- durable consolidation retains only supported, reusable information;
- compact higher-level context is preferred over dumping every low-level event.

Homun maps these ideas onto its own primitives:

| Layer | Homun authority | Purpose |
| --- | --- | --- |
| Turn evidence | chat transcript, `agent_run_events`, memory event refs | What was said, observed, attempted, or produced |
| Thread continuity | episodic memory, checkpoint, Working Ledger | Resume the current task without claiming general truth |
| Durable semantic memory | personal/project `MemoryRecord` | Stable facts, preferences, goals, and decisions |
| Graph | typed entities/relations with evidence | Navigate only supported connections |
| Prompt projection | typed `PromptPacket`s | Give the model the smallest relevant context in a stable hierarchy |

## Admission contract

### Default/personal workspace

The default workspace maps to `__personal__`, but only these user-grounded categories can be immediately confirmed:

- explicit identity or relationship facts;
- explicit ownership and stable personal circumstances;
- explicit preferences stated as preferences;
- explicit long-lived personal goals or commitments;
- explicit corrections or confirmations of a previously presented claim.

The following remain only in the thread episode/evidence unless the user explicitly asks to remember or confirms them as durable:

- assistant conclusions;
- tool, browser, shell, test, or file observations;
- technical facts about a product, website, codebase, or external system;
- hypotheses, evaluations, search results, temporary state, and failed attempts;
- a single observed behavior interpreted as a preference.

### Named project workspace

- Explicit user project goals, constraints, decisions, and confirmed state route to the active project.
- Tool/assistant findings may be stored only as project candidates with evidence, never as personal facts.
- Facts unrelated to the active project are not silently routed to personal memory unless they independently satisfy the personal admission contract.
- Linked read-only sources remain non-writable; previously used linked facts stay in conversation history with provenance and are not copied into project memory.

### Status and promotion

- `derives` and `conflict` are always candidates.
- Assistant/tool-derived claims are always candidates even when the extractor reports high confidence.
- Time alone never promotes a candidate.
- Confirmation requires explicit user confirmation, deterministic duplicate reinforcement of an already confirmed claim, or an evidence-aware lifecycle action.
- Exact/high-similarity duplicates reinforce the canonical record rather than creating another row.

## Provenance and graph contract

Each accepted durable memory records a reserved admission envelope:

```json
{
  "admission": {
    "origin": "user_explicit|user_confirmed|assistant_derived|tool_observed",
    "source_thread_id": "...",
    "source_turn_id": "...",
    "durability": "durable|candidate|episode_only",
    "classifier": "layered-admission-v1"
  }
}
```

The post-turn exchange is represented by a sanitized `MemoryEvent`. Accepted memories and relations link to that event through existing evidence refs. No raw reasoning, secret, data URL, or unbounded tool output enters memory evidence.

Graph persistence is filtered by the accepted semantic result:

- persist only entities referenced by an accepted relation or accepted memory;
- create `person:self` only when an accepted relation actually references it;
- preserve canonical-key upsert/deduplication;
- skip relations whose endpoints were not admitted;
- attach the exchange evidence ref to accepted relations;
- never infer a relation from prose without explicit extractor output and supporting evidence.

## Layered prompt contract

Prompt packets become real content boundaries rather than metadata around one monolithic string:

1. `core`: stable Homun behavior and safety rules;
2. `workspace`: bounded authorized profile, relevant memory, project objective/brief, and recent work;
3. `project`: jail-scoped `AGENTS.md` and `.homun/instructions.md`;
4. `thread`: contact perimeter, thread binding, retained episodic context, and attachment manifest;
5. `runtime`: current mode, route, plan/checkpoint state, offered tools, and one-turn controls.

Every packet has a stable id, priority, size, and fingerprint. The composed provider prompt remains backward-compatible, while the Prompt Inspector can show where context came from. Workspace/thread blocks are bounded independently so a small model does not lose its task to a large memory dump.

## Agent-loop evidence and no-progress handling

Effect receipts keep their existing at-most-once role. A separate bounded tool-evidence event records:

- tool family/name;
- outcome class (`evidence`, `empty`, `blocked`, `retryable_error`, `no_progress`);
- redacted summary and fingerprint;
- optional artifact/evidence refs.

The loop detects semantic no-progress across calls in the same tool family, not only byte-identical arguments. After two consecutive non-progress outcomes for the same objective it must change strategy; a third non-progress outcome forces an honest blocked/final synthesis. Successful setup/capability discovery is cached for the current run.

The Working Ledger remains a deterministic projection of canonical structured data and includes bounded evidence summaries, not raw tool payloads.

## Transcript and initial-thread contract

- New assistant messages store clean user-visible text in `chat_messages.text`.
- Reasoning/activity/recall/plan parts remain structured in `event_parts_json`.
- Legacy messages containing markers remain readable through the existing parser; no destructive migration is required.
- First startup seeds the configured base workspace, never a hard-coded foreign workspace.
- Creating a new task reuses an untouched seeded task in the same workspace instead of creating a duplicate.
- Frontend fallback identifiers are display-only and must not create another persistent starter task.

## Usage contract

The analyzed conversation predates the current Usage implementation. No retrospective rows are fabricated. Verification uses a fresh current-version turn and checks provider, model, task/thread, run/turn, token/cost provenance, and dashboard aggregation. Code changes are made only if that fresh path fails.

## Failure behavior

- Invalid/missing admission metadata degrades to candidate or episode-only, never confirmed.
- Missing evidence prevents graph relation persistence but does not erase the visible conversation.
- Failure to write semantic memory does not fail the chat turn.
- Failure to write the canonical transcript or structured run state is surfaced; projections remain rebuildable.
- Linked-source provenance failures remain fail-closed for learning and future model context.

## Acceptance criteria

1. A personal chat stating a stable user preference stores one confirmed personal memory.
2. A personal chat where the assistant concludes a technical fact stores no confirmed personal fact; the episode/evidence remains available.
3. Explicit user confirmation upgrades the supported claim without creating a duplicate.
4. Candidate age alone never changes status.
5. Project findings never leak into personal memory.
6. Every newly accepted memory and relation has a valid bounded exchange evidence ref.
7. Repeating the same analysis preserves canonical entity/relation counts.
8. No orphan `person:self` or unused topic/tool node is created.
9. Prompt Inspector reports non-empty content-derived metadata for all applicable packet layers in the correct order.
10. Two related but differently parameterized failed tool calls trigger strategy change rather than an unbounded retry loop.
11. Newly stored assistant text contains no internal markers while legacy messages still render correctly.
12. Reset plus first app entry yields one starter task in the base workspace.
13. A fresh current-version chat produces truthful Usage rows and aggregates; the old chat remains legitimately absent.

## Non-goals

- Replacing SQLite, FTS, embeddings, or the typed graph.
- Keyword-based memory activation.
- Copying linked read-only memory into the consumer project.
- Persisting raw model reasoning or raw tool output.
- Backfilling historical Usage with estimates.
- Requiring user approval for every stable, explicit personal fact.
