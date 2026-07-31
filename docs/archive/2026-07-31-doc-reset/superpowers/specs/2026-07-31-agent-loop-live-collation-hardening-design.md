# Agent Loop Runtime Hardening

## Problem

The live release collation exposed four initial contract violations:

1. A substantial final answer can close an open plan step without evidence.
2. Only one delegated browse is allowed per turn, so a multi-source plan cannot finish autonomously.
3. The privacy model can classify an absolute filesystem path as a private postal address.
4. The development UI reports the Electron runtime version instead of the Homun package version.

The first issue can also split state: the stream can show an open step while the durable runtime plan
is force-closed during delivery.

The wider collation then exposed related failures in evidence verification, provider tool-call
normalization, presentation generation, recurring automation cancellation, and terminal workflow
delivery. These are part of the same agent-loop contract rather than independent UI exceptions.

## Contract

### Lifecycle and progress

- A plan step becomes `done` only through verified `update_plan`/`step_advance` evidence or the
  evidence-driven frontier verifier. Answer length is never completion evidence.
- Delivery preserves every open or blocked step exactly as-is and persists no synthetic completion.
- Malformed progress operations fail closed. Planning and bookkeeping operations never count as task
  evidence.
- A deterministic workflow that has reached its terminal route gets one synthesis pass and then
  exits. It cannot re-enter the same tool workflow indefinitely.
- Canonical terminal state remains the source of truth for the durable run, the trace, and the UI.

### Delegation and evidence

- A manager turn may delegate multiple distinct browse goals, with a bounded per-turn cap. Repeating
  the same normalized goal remains no-progress and cannot create an unbounded retry loop.
- Tool evidence includes bounded, non-secret argument provenance so a verifier can distinguish the
  requested path/entity from an unrelated successful result.
- Analytical steps may use candidate model output as evidence only after a forced verification pass.
  Candidate output never verifies its own claims, and verifier budgets remain bounded.
- Exact-target verification prefers the candidate plus the most recent matching tool evidence, not
  unrelated successful calls from the same turn.

### Provider normalization

- Provider-specific XML tool envelopes normalize into the same internal tool-call contract,
  including wrapped `<tool_calls>` payloads and attribute-based tool names.
- Internal tool wrappers and display markers never leak into the delivered assistant message.

### Memory, privacy, and security

- Memory artifacts are scoped to the current task. Memory recall remains authorization-gated and
  fails closed when unavailable or forbidden.
- Filesystem paths are technical identifiers, not private postal addresses. Real postal addresses and
  all deterministic credential/identity detections remain protected.
- Security, Vault, sandbox, and connector boundaries remain enforced by the existing gateway contract;
  agent-loop verification does not bypass them.

### Presentations

- `make_deck` can execute at most once per turn. The following model round must synthesize the result
  instead of regenerating the deck.
- Requested slide count, visible title/subtitle/bullets, notes, and closing-slide semantics are
  normalized consistently across providers.
- Closed-world requests cannot inherit visible sample text or speaker notes from a template. Templates
  may contribute non-textual visual assets only.
- PPTX, PDF, HTML, and source JSON are registered together. PDF output is 16:9 without browser headers
  or footers, and QA rejects real internal clipping while ignoring valid page-level overflow.
- The artifact catalog declares whether each output is `managed` or `project`. Managed outputs are
  opened through the jailed `thread + name` artifact contract; project outputs keep filesystem
  authorization. PDF previews always render through the packaged PDFium runtime, never a native
  Chromium blob iframe.

### Automations

- Disabling or deleting a recurring automation cancels every open occurrence associated with it.
- A recurring occurrence is requeued only while its parent automation remains active.
- The automation UI refreshes both definitions and queued occurrences after a state change.

### Version identity

- Packaged builds use Electron's packaged app version; development uses `apps/desktop/package.json`.

## Verification

- Unit regressions for delivery reconciliation, browse admission, evidence provenance, privacy paths,
  provider normalization, automation cancellation, presentation semantics, and development version
  resolution.
- Gateway and engine test suites.
- Live Electron tasks covering canonical progress, read-only project evidence, multi-source browsing,
  coding, presentations, automations, cancellation, and restart recovery.
- Full pre-release gate and warning-free development build.
