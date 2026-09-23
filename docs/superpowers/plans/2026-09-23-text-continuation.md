# Durable text truncation continuation

H06, reference Hermes turn_truncation.py and conversation_loop continuation prompt
and joining. Homun owns execution. New native proposals pin version 1, legacy
runs retain terminal truncation. At most 3 continuation nudges (4 fragments total
including final failure), 64k saved text, global attempts/budgets remain binding.

- [x] RED tests: typed visible partial with usage; no tools/reasoning/filter/empty
  continuation; restart then stitched final; exhaustion with no artifact.
- [x] Model-only partial exception, classifier carries explicit bounded text.
  Pure continuation state/prompt/join helpers separate from durable recording.
- [x] Persist assistant fragment + user nudge under authority/lease/epoch and
  steering fences; no provider IO in transaction. Reset phase retries only upon
  accepted fragment. Preserve original output cap and independent retry budgets.
- [x] Successful final stitches once; tool round supersedes textual assembly;
  human steering/redirect clears assembly, pause/resume retains accepted pieces.
- [x] Tests for controls, revoked access, model attempt cap, context headroom,
  malformed tool output, transient recovery and final persistence.
- [x] Real HTTP truncation and genuine Ollama continuation, reviewer, checks,
  docs/provenance, local commit and merge.

Partial trails remain canonical evidence, never artifacts. No streaming recovery,
truncated tool retries/output cap boosts, reasoning-only continuation or fallback
claimed. Full H06 and H01-H46 remain open.
