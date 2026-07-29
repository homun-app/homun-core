# General Effect Host Design

**Date:** 2026-07-29

**Status:** Approved by the preceding architecture review and the instruction to proceed autonomously.

## Purpose

Make every consequential dispatch in the agent loop obey one durable contract. Tool adapters, browser actions, and adapter-owned channel delivery must use the same authorization, idempotency, replay, uncertainty, and completion protocol instead of reimplementing receipt handling at each call site.

## Scope

This increment introduces one gateway `EffectHost` and migrates the existing generic tool and channel receipt paths. It also carries the same host into the delegated browser loop so `browser_act` and `browser_rehydrate` cannot bypass durable effect ownership.

The host does not replace the sandbox, Vault, connector authorization, browser action classification, payment approval, or URL policy. Those remain domain gates and run before the external mutation. The host owns only the general execution invariant around the final dispatch.

## Canonical sequence

Every effect follows this order:

1. Resolve the authoritative validated `ExecutionContract` for the running revision.
2. Run domain-specific validation and approval gates.
3. Ask `EffectHost` to authorize the effect class and logical operation.
4. Prepare and atomically claim a receipt keyed by execution, operation, and logical call id.
5. On `Replay`, return the persisted result without dispatching.
6. On `Resolve`, suspend or project uncertainty without dispatching.
7. On `Execute`, perform the external mutation once.
8. Persist completion before reporting success.
9. If dispatch returned an ambiguous transport failure, mark the receipt uncertain and never retry it automatically.

## Contract policy

The execution contract is the general authorization source. Chat-turn `approval` values are normalized into its policy when the contract is built:

- `read_only`: read and authorization requests only.
- `full`: all effect classes are available, while existing interactive domain gates still decide when approval is required.
- `confirm`: all effect classes are representable with `OnRequest`; existing gates must obtain approval before dispatch.
- `autonomous`: all effect classes are representable with `Preauthorized`, subject to the narrower objective, sandbox, Vault, connector, and browser policies.

Explicit `permission_context` constraints remain additive only where they narrow or specifically authorize non-chat task families. No adapter may widen the already persisted authoritative contract.

Channel reply delivery is adapter output, not a model-selected capability. The host accepts it only for a `chat_turn` whose contract scope matches the channel thread and whose persisted task source is `channel`. This allows the response transport while keeping channel-originated model tools read-only unless the turn was explicitly configured otherwise.

## Effect identity

The stable identity is:

`execution_id + operation + logical_call_id`

Equal arguments do not imply equal intent. Two user-approved sends with identical payloads but different tool-call ids receive different receipts. A replay of the same logical call receives the same receipt. The arguments hash remains evidence and supports lookup of pre-migration receipts; it is not the new idempotency identity.

## Components

### `effect_host.rs`

The module exposes a small request/decision API:

- `EffectRequest`: operation, logical call id, effect class, canonical arguments, optional compensation, and whether the operation is a model capability or adapter output.
- `EffectDecision`: `Execute`, `Replay`, or `Resolve` with the durable receipt.
- `EffectHost::begin`: validates scope/policy, performs legacy lookup, prepares, and claims.
- `EffectHost::complete`: redacts and persists result/effects.
- `EffectHost::mark_uncertain`: converts an in-flight receipt to the durable uncertain state.

The module receives the validated contract and task store. It does not receive network clients, Vault values, browser sessions, or arbitrary `AppState` access.

### Generic capability executor

The current inline hashing, migration lookup, prepare, claim, replay, resolve, and completion code is removed. The executor calls the host around the existing `execute_chat_tool` dispatch. Read-only tools do not allocate receipts.

### Channel projector

The projector builds an adapter-output request and uses the same host. A replay does not call the sidecar. An ambiguous send failure becomes uncertain. A completed send is persisted before `thread.updated` is emitted.

### Browser executor

The delegated browser loop receives the enclosing validated contract and run identity. `browser_rehydrate` is always a filesystem/external-state mutation owned by a receipt. `browser_act` uses a receipt for actions capable of changing remote or account state; ordinary observation-only browser operations remain receipt-free. The browser safety lattice and payment gate run first, then the host claim occurs immediately before `BrowserMethod::Act`.

For this increment, all accepted `browser_act` calls are treated as `ExternalWrite`. This is intentionally conservative: clicks, typing, login, booking, and payment can have remote effects, and the sidecar does not provide a transaction boundary that can safely distinguish them after the fact. Navigation, snapshot, tabs, dialog inspection, screenshot, and terminal `browser_done` remain reads.

## Failure behavior

- Missing durable execution scope blocks the effect before dispatch.
- A denied effect returns a typed contract-blocked result and creates no receipt.
- A completed receipt replays its persisted result and effects.
- A started or uncertain receipt never dispatches again automatically.
- Store failure before dispatch blocks the operation.
- Store failure after a successful remote call is surfaced as an unknown outcome; success is never fabricated.
- Scope, revision, operation, class, or arguments mismatch on an existing receipt fails closed.

## Tests

Focused tests prove:

1. identical arguments with different logical call ids create different receipts;
2. a replay returns persisted output without invoking the dispatch closure;
3. a second claim of a started receipt becomes `Resolve` and never redispatches;
4. denied policy fails before receipt creation;
5. legacy argument-keyed receipts are reused;
6. channel adapter output is accepted only for a matching channel chat contract;
7. browser mutations require durable scope and reads remain receipt-free;
8. all previous task-runtime, gateway, Electron, and warning-free build gates remain green.

## Follow-up boundary

This increment establishes one effect boundary. Product-wired `continue_as_new`, in-flight cancellation/deadline propagation, projector/outbox separation, and the crash matrix remain separate increments because they change lifecycle scheduling rather than effect dispatch semantics.
