# Native provider recovery implementation plan

Goal: recover transient native model failures durably without repeating tools or
inventing billing usage. Reference: pinned Hermes `turn_api_error.py`,
`turn_recovery.py`, `retry_utils.py`, `error_classifier.py`; root MIT notice applies.
This tranche is partial H06, not provider fallback or full truncation parity.

- [x] Add typed sanitized native model failures: network/timeout, rate limit,
  server, authentication/billing, invalid request/TLS, context/payload overflow,
  empty/truncated/malformed reply. Extract and preserve usage before validation.
- [x] Keep legacy provider API behavior compatible; no transport-local retries.
  Numeric/date Retry-After and structured quota detection, no raw bodies persisted.
- [x] Add durable per-phase attempt counters before IO and three total attempts
  for transient failures. Reconcile each call separately; missing usage stays
  unknown. Summary and acting phases remain distinct; accepted rounds reset only
  their own counter. Replay never resets counters.
- [x] Persist next retry time using Hermes base2 exponential backoff plus bounded
  jitter and Retry-After capped600 seconds. Workflow yields through its existing
  busy path; no transaction or lease held while waiting. Pause/cancel/redirect
  fence old requests; new control generation resets unresolved recovery.
- [x] Surface concise retry state in the engine API and existing run controls.
  Reject incomplete tool calls/partial text and checkpoint summaries rather than
  execute or publish partial results. Truncation continuation remains tracked.
- [x] Test transient recovery, exact exhaustion across restart, permanent
  failures, actual/unknown usage, no duplicate tools, stale results and controls.
  Run local HTTP failure fixture, full regression and independent review.
