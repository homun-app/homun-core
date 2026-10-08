# Bounded provider context-overflow recovery

Approved direction: continue parity autonomously using Homun-owned logic derived
from pinned Hermes `agent/turn_overflow.py` and context compression helpers.

When a native acting request fails with provider context overflow, request a
persisted forced compaction, not an identical blind retry. Require an explicit
known context window. Keep the same output limit, canonical messages, authority,
budgets and three-attempt acting cycle. Limit forced compactions to two per
unaccepted decision. Publish a checkpoint only after more than5% estimated
request reduction; if no safe cut exists, fail explicitly before another call.
Never recursively recover overflow of the summary call. Controls fence the marker.

- [x] Add forced planner mode with protected-context/no-cut/unknown-window tests.
- [x] Persist overflow recovery intent under the current lease/epoch/input fence.
- [x] Consume intent in summary preparation, clear only after valid checkpoint;
  accepted acting round or human control resets its decision-specific counter.
- [x] Verify overflow→summary→final, restart, no duplicate tools, budgets,
  no-cut/unknown-window terminal outcome and concurrent control.
- [x] Record fixture evidence and limits, review, regression, commit and integrate.

This does not implement provider-specific output-limit repair, tokenizer metadata
inference, 413 image resizing, auxiliary models, or fallback chains. H06 stays partial.
