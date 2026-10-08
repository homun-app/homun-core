# Homun owned core: native tool rounds

Approved direction: maintain Homun's engine, adapting Hermes logic without importing its runtime. Reference: NousResearch/hermes-agent c9dca726514b709cf6e677d236a79fc8d0627f37.

1. Add failing transport and application tests for native tool calls, durable multi-call history and human-input recovery across context restart.
2. Add canonical typed messages and OpenAI-compatible/Ollama request projections. Keep ordinary chat unchanged. Record usage through ModelRegistry.
3. Pin native protocol and initial prompt in new OpenAI-compatible run proposals. Existing runs and explicit fake/other adapters keep versioned JSON protocol; no failure-triggered downgrade.
4. Persist the assistant round before executing any tool. Execute one pending call per durable advance, associate results by call ID, and resume unresolved calls before querying the model again. Route human questions through existing contribution authority.
5. Adapt Hermes execution guidance with source attribution and complete MIT notice included in the engine package. Preserve existing approval, source validation, budgets and artifact review.
6. Run focused and full engine regressions, one bounded local Ollama workflow, package notice verification; document evidence and limits, commit locally.

Acceptance: two reads separated by human clarification and a process-context restart are both observed; no new model request while calls are outstanding; source changes block execution; publication remains transactional; truncated/invalid provider output cannot become a final artifact. No new shell/web access, compression, general pause/steering API or provider fallback in this tranche.

Implementation and evidence: [verification report](../../research/2026-09-23-owned-core-verifica.md). Independent review identified two malformed-provider cases, reproduced with failing tests and corrected before integration.
