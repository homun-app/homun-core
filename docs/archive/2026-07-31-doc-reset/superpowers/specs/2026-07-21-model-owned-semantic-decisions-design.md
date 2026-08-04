# Model-Owned Semantic Decisions — Design

**Date:** 2026-07-21
**Status:** Proposed for review
**Scope:** user-intent interpretation, objective contracts, continuation and steering,
capability/workflow routing, deliverables, memory-use intent, and deterministic enforcement

## Principle

Homun must not infer what the user means through keyword lists, substring tests, BM25 winners,
prompt length, or similar deterministic language heuristics. Semantic choices belong to the model.
The runtime may validate and enforce a model decision, but it must not replace that decision with a
second home-grown interpretation of natural language.

This is intentionally different from removing determinism altogether. Deterministic code remains
authoritative for facts and invariants such as filesystem boundaries, authorization provenance,
cancellation, idempotency, effect receipts, schema validation, data sensitivity policy, and tool
metadata. Those mechanisms answer "is this allowed and valid?", not "what did the user mean?".

## Failure reproduced

The exact read-only request used for the authorization/analysis regression contained:

> È esclusivamente un'analisi: non creare, modificare o cancellare file e non creare documenti o
> Markdown.

The current runtime made two deterministic semantic decisions before the working model could reason:

1. `classify_objective_mode` matched `crea`, `modifica`, and `cancella` inside explicit negations and
   persisted the objective as `mixed` with mutation allowed;
2. `route_capability` ranked native workflow descriptions with BM25, selected `make_document`, and
   pruned every other tool, including the directory tools needed to request access and inspect the
   project.

The model therefore never received the capability needed to satisfy the request. The fixture stayed
byte-for-byte unchanged, but authorization and analysis never happened. Two focused regression tests
currently fail at these two seams.

## Options considered

### A. Expand deterministic language rules

Add negation handling, more synonyms, language detection, thresholds, and routing exceptions.

Rejected. It would move the current false positive without solving the class of failures. Each new
language, paraphrase, multiple intent, or correction would require another rule and could contradict
another rule.

### B. Let the model decide and execute without a runtime validator

Give the working model every tool and trust its prose interpretation completely.

Rejected. Semantic authority does not imply authority to cross security or effect boundaries. A
model mistake, malformed response, prompt injection, or stale context must not silently widen scope
or create side effects.

### C. Model-owned semantics with deterministic validation and enforcement

Use a model to produce one canonical structured decision; use deterministic code only to validate
that structure against known capabilities, permissions, current objective state, and effect policy.

Chosen. This preserves natural-language understanding even with small models while retaining hard,
auditable safety boundaries.

## Audit: decisions that must move to the model

The initial source audit found the following semantic decision families. The implementation must
remove them as authorities, not merely wrap their current output.

| Decision family | Current deterministic authority | Required owner |
| --- | --- | --- |
| Objective effect mode | `classify_objective_mode` keyword/substring scan | semantic decision model |
| Initial objective, scope, forbidden actions, deliverable | mostly raw prompt plus inferred mode | semantic decision model |
| Workflow or agent-loop route | `route_capability` BM25 winner | semantic decision model |
| Atomic PDF versus deliverable workflow | `atomic_pdf_operation_reason` token list | semantic decision model |
| Plan/research precedence | `is_plan_continuation_message`, `prompt_requests_planning_or_research`, `prompt_forces_plan_precedence` | semantic decision model using thread state |
| Steering compatibility | `classify_steering` reuses keyword mode classification | semantic decision model comparing active and proposed objective |
| Same objective, compatible extension, replacement, or scope expansion | implicit rules and terse-message heuristics | semantic decision model |
| Choice-card request intent | `is_standalone_choice_card_request` phrases | working model or semantic decision model |
| Whether terse input is confirmation/correction | `is_confirmation_reply` word list | semantic decision model with conversation context |
| Whether an exchange is worth memory extraction | `is_salient_exchange` length/trivial-word filter | memory extraction model; cheap batching may remain non-semantic |
| Whether cross-thread memory is relevant | `should_inject_cross_thread_memory_for_prompt` and aliases | semantic decision model followed by grant-scoped retrieval |
| Whether the user is asking to reveal a Vault value | `query_should_offer_vault_reveal` keywords | semantic decision model; local PIN and reveal policy remain deterministic |

BM25, embeddings, token overlap, and keyword search may remain retrieval mechanisms that return
candidates. They must never be the final authority that chooses the user's intent, narrows tools, or
widens effects.

## Audit: determinism that must remain

The following are not natural-language interpretation and remain deterministic:

- exact user selections already captured by structured UI state, such as an approved template or
  routing binding;
- authorization identity, path jail, canonical-path checks, project grants, and approval provenance;
- cancellation flags, concurrency ownership, idempotency keys, effect receipts, and retry rules;
- tool declarations and provider-supplied `readOnlyHint`/effect metadata;
- conservative safety fallback when a third-party tool omits effect metadata;
- schema, enum, capability existence, attachment MIME, archive, and file-format validation;
- privacy and sensitive-data enforcement, including local-only Vault reveal and PIN confirmation;
- memory grant boundaries, provenance, retention, and source isolation;
- completion evidence, filesystem hashes, test results, and other externally verifiable facts;
- deterministic execution of a validated semantic decision.

These checks may reject a model decision or require confirmation. They may not reinterpret the
request into a different objective or workflow.

## Canonical semantic decision

Before tool pruning, objective persistence, planning, or memory injection, the orchestrator model
returns one strict structured object:

```json
{
  "objective": "Inspect the requested project and report findings in chat",
  "relationship_to_active_objective": "new_objective",
  "mode": "read_only_analysis",
  "scope": {
    "resources": ["user-requested Projects subtree"],
    "may_request_additional_access": true
  },
  "allowed_effect_classes": ["read", "request_authorization"],
  "forbidden_effect_classes": ["filesystem_write", "artifact_creation", "external_write"],
  "deliverable": {
    "kind": "chat_report",
    "artifact_requested": false
  },
  "execution_shape": "agent_loop",
  "selected_capability": null,
  "memory_intent": {
    "use_current_thread": true,
    "search_personal": false,
    "search_project": true,
    "vault_value_requested": false
  },
  "requires_user_confirmation": false,
  "confidence": 0.97,
  "rationale": "The user explicitly asks only for analysis and forbids files and documents."
}
```

Required enums:

- `relationship_to_active_objective`: `new_objective`, `same_objective`,
  `compatible_extension`, `replacement`, `scope_expansion`;
- `mode`: `read_only_analysis`, `mutation`, `mixed`;
- `execution_shape`: `agent_loop`, `workflow`, `atomic_capability`;
- deliverable kind: `chat_report`, `artifact`, `code_change`, `external_action`, `none`.

The request includes the latest user message, bounded current-thread context, the active Objective
Contract and runtime plan, attachment metadata, and a compact registry of available capabilities
with declared effect classes. It does not include unauthorized memory contents.

## Model selection and small-model contract

The semantic decision uses the configured orchestrator role. Every model, including a small local
model, sees the same canonical decision afterward. The working model is no longer expected to
reverse-engineer hidden router rules or recover from a toolset already pruned incorrectly.

The call uses strict JSON Schema where supported and the existing structured-output repair path
where needed. Temperature is low, token budget is bounded, and raw natural-language rationale is
short. The result records provider, model, latency, schema version, confidence, and fallback reason.

## Deterministic validator

The validator accepts or rejects the structured decision without interpreting the user's prose. It
checks only machine-verifiable invariants:

1. the response matches the schema and known enums;
2. a selected workflow/capability exists and is enabled;
3. its declared effect class is compatible with the decision's mode and forbidden effects;
4. it does not silently broaden the active objective's resource scope;
5. an explicit user-selected binding remains authoritative unless the user changes it;
6. new mutation or external effects during steering require confirmation when absent from the active
   contract;
7. no tool pruning can leave the selected execution shape without the capabilities it needs.

Contradictory output such as `read_only_analysis` plus `make_document` is invalid. The runtime does
not choose which half was "probably intended".

## Failure and fallback behavior

If the semantic call is unavailable, malformed, contradictory, or below the confidence floor:

- preserve an existing active objective and its previously validated policy when possible;
- for a new objective, use `read_only_analysis`, `chat_report`, and an unpruned read-only agent loop;
- allow tools to request authorization but block all mutations and artifact creation;
- show a typed degraded-routing event and retain the failure reason for inspection;
- ask the user only if the ambiguity blocks progress or a broader effect is required.

The fallback contains no keyword classifier. It is a safe execution default, not a semantic guess.

## Routing and tool exposure

The model chooses the execution shape from the registry supplied in its request:

- `agent_loop`: expose all capabilities compatible with the validated objective policy;
- `workflow`: expose the selected workflow plus any explicitly declared supporting capabilities;
- `atomic_capability`: expose that capability and compatible discovery/read helpers.

Candidate retrieval may preselect a bounded list for very large plugin catalogs, but it must include
an `agent_loop` option and must not treat the top retrieval score as the route. Native workflow
registries and plugin declarations remain the source of capability identity, enablement, and effect
metadata.

An exact user-selected routing binding is not an inferred semantic choice. It remains deterministic
state, is included in the model request, and wins until the user replaces or cancels it.

## Objective lifecycle and steering

The semantic decision becomes the source of the Objective Contract fields. A steering message is
classified by the same model against that active contract:

- same objective or compatible strategy change: replace the plan autonomously and continue;
- compatible extension without new scope/effects: revise the plan autonomously and continue;
- objective replacement: supersede the old contract and start the new one;
- scope expansion or new mutation/external effect: persist a proposed revision and request explicit
  confirmation before dispatching the first incompatible tool.

The runtime owns persistence and transition atomicity; it does not decide semantic compatibility by
matching words.

## Memory and Vault intent

The decision describes which authorized memory domains are relevant. Retrieval remains
grant-scoped and provenance-preserving. A model decision can request a search but cannot widen the
authorized source set.

Terse replies are interpreted with current-thread context by the model, so `sì`, `continua`, or a
choice label are not guessed from a standalone word list. Memory extraction receives the exchange
and decides whether it contains durable knowledge; deterministic batching may skip empty payloads
or enforce resource budgets, but not decide meaning.

A semantic `vault_value_requested` decision may offer a reveal card. The secret stays local and the
PIN/reveal checks remain deterministic. A model can never receive or reveal the plaintext value.

## Migration plan

1. Add the typed semantic decision and validator in a dedicated module, with a versioned schema.
2. Add a model client seam with injectable deterministic fixtures for tests.
3. Make turn start await the validated decision before persisting the initial Objective Contract.
4. Replace BM25/keyword route authority with the decision's execution shape and capability.
5. Replace steering and plan-precedence language heuristics with the same decision path.
6. Move memory/confirmation/choice-card intent to model-produced fields or the normal working-model
   response.
7. Delete dead semantic keyword functions and tests that canonize their behavior.
8. Keep search/ranking helpers only as candidate retrieval and rename them accordingly.
9. Add observability in the execution journal and inspector.
10. Re-run the exact authorization/analysis flow in a fresh chat and prove no file mutations.

Migration must be vertical: objective mode and routing move together. Replacing only one leaves the
other able to produce the same failure.

## Test strategy

### Structured decision tests

- explicit read-only analysis containing negated mutation verbs;
- explicit request to create or modify files;
- analysis followed by an explicitly requested artifact;
- multiple intents in one message;
- multilingual and paraphrased variants without language-specific runtime rules;
- terse continuation resolved from active thread context;
- same-goal steering versus objective replacement;
- newly introduced mutation requiring confirmation;
- invalid JSON, unknown capability, low confidence, and unavailable model fallbacks;
- contradiction between mode, forbidden effects, deliverable, and selected capability;
- explicit user-selected routing binding retained.

### Enforcement tests

- read-only policy blocks every declared effectful tool regardless of model output;
- authorization grants access only to the approved path and does not grant write permission;
- cancelled turns cannot dispatch another tool;
- candidate retrieval order cannot become a route decision;
- unavailable semantic routing cannot produce a write.

### Exact end-to-end acceptance test

In a fresh chat and isolated filesystem fixture:

1. ask Homun to find a project below an unauthorized `Projects` folder;
2. verify it lists what is already accessible or requests the exact folder authorization;
3. grant access once;
4. verify execution resumes automatically without a second `continua` message;
5. verify it traverses relevant subfolders and returns an analysis in chat;
6. verify no document, Markdown, source file, directory, or metadata timestamp changed;
7. verify the persisted contract is `read_only_analysis`, deliverable `chat_report`, and route
   `agent_loop`;
8. verify the journal records the semantic decision, validation, authorization, continuation, and
   completion.

Hashes, sizes, mtimes, and absence of unexpected paths are captured before and after. The test is
not green if authorization, automatic continuation, analysis depth, or the no-write proof is
missing.

## Completion criteria

- No deterministic natural-language heuristic can select objective mode, execution shape,
  deliverable, semantic continuation, or memory/Vault intent.
- The model's structured decision is persisted and inspectable for every user turn.
- Deterministic policy rejects incompatible or unauthorized effects without changing semantic
  intent.
- The exact prior chat flow succeeds end to end and leaves the fixture unchanged.
- Focused unit, integration, runtime, and rendered desktop tests pass with live evidence.
