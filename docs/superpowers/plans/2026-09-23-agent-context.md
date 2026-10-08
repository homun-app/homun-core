# Durable context checkpoint implementation plan

Goal: continue bounded native work when older completed tool rounds fill the model window, without deleting canonical history.
Architecture: pure model context planner + separately persisted prefix-hashed checkpoint; a budgeted and fenced summary call; explicit connection context/output pins transported to the provider. Derived estimator and summary rules from pinned Hermes context_compressor.py/model_metadata.py; no upstream imports.

- [x] Add failing planner tests for ASCII/CJK estimates, tool-schema reservation, closed-tool-group boundaries, preserved initial objective and latest consecutive corrections, pending calls, checkpoint hash validation and protected-context overflow.
- [x] Implement models/context_plan.py with immutable projections, rough estimates separate from UsageEntry, source-covered checkpoint schema and a pure cut plan. Preserve original system+objective and latest correction chain; retain whole recent tool groups. Fail explicitly if protected content cannot fit.
- [x] Add explicit optional context_window and max_output_tokens to configured connections. For local Ollama, explicitly request Homun's 16384 default window rather than infer the model's trained maximum. Cloud without a pin remains unknown; no guessed capacity. Pin this policy in new native proposals.
- [x] Add bounded, tool-free summary transport and Hermes-derived summary prompt. Reject empty/truncated/refusal summaries; preserve old checkpoint/history on failure. Summary usage charged separately with existing budgets.
- [x] Implement application/agent_context.py: plan under current lease, reserve/account summary, commit checkpoint only if epoch/lease and prefix/steering state still match, then project before acting request. No output summaries counted as actual billing estimates.
- [x] Test restart, stale summary after redirect/steer, budget denial, no progress and provider malformed summary. Reuse existing model-attempt limit; never reset retries through DBOS replay.
- [x] Run context/native/control/provider suites plus full regression, independently review, record local runtime evidence. Keep full H05 parity open for auxiliary providers, cache semantics, micro-compaction, memory flush and complex overflow recovery not yet implemented.
