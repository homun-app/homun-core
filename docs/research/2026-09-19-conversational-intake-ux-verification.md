# Conversational intake and work summary — 19 September 2026

## Delivered behavior

A new conversation preserves the original request and creates a draft with temporary labels. The configured model proposes a separate title, objective, output, constraints, missing information and suitable collaborator from the real roster, or a new reusable profile. Assignment and profile creation require explicit confirmation. Missing materials are listed before execution without blocking staffing. Agent creation grants no tool or project access.

The confirming human owner remains reviewer when delegating to an agent; an existing reviewer is never replaced. A regression test reproduces staffing, material proposal, human approval and artifact publication end to end. Generic plan/start/assignment commands cannot bypass unconfirmed intake. Proposal revisions, digests, agent revisions and current project authority are checked on the server, including replay. Only the latest confirmed intake permits execution. An idle agreement can be revised before planning.

The right panel shows a short title, readable objective, actual collaborator and next step. Rename and objective editing are explicit. Diagnostic panels are collapsed. Real engine collaborators replace prototype names in the engine squad. Sibling editor keys are distinct so switching works cannot retain an old editor alongside the current objective.

Code is split into model synthesis, application orchestration, policy, HTTP transport, hook and presentation modules. The workspace shell remains 1,459 lines; the engine workspace hook is below 500 lines. The architecture check reports zero errors and 29 existing size notices; this is not a claim that all legacy monoliths have been removed.

## Automated verification

- Engine: 372 passed, 1 skipped; one upstream Starlette deprecation warning.
- Packaged-engine desktop lifecycle/security/packaging: 8 passed.
- Frontend: 137 passed, TypeScript and production/prototype builds passed. Existing large-chunk build warnings remain.
- OpenAPI snapshot matches current routes; `git diff --check` passes.
- Focused review covered stale proposals, authority, replay, concurrent synthesis order, denied reads and interruption recovery.

## Native GUI evidence

Used the real Electron app with its packaged engine and local Qwen3.5:4b, persistent local profile, and only synthetic demo CSVs.

1. Empty roster: natural request produced a proposal. Clarification requested a reusable price analyst. Quit/reopen preserved the pending proposal and zero agents. Clicking **Crea il collaboratore e affida** created exactly one real **Analista Prezzi Cancelleria**; no execution occurred on staffing confirmation.
2. Existing roster: a new request suggested that actual profile and produced a concise title/objective with `compare_csv`. Contextual file inputs appeared only after confirmation.
3. Live execution exposed loss of human approval authority after delegation. Added the reviewer preservation fix and a failing-then-passing end-to-end regression. The failed pre-fix demo remains available as test history; it was not silently modified or executed.
4. Original completed demo: renamed through GUI to **Confronto listini · demo iniziale**, then proposed and confirmed a concise objective. Original messages and report were preserved.

5. New complete GUI flow after the reviewer fix: work `work_HBVRKmo8Kv3x9A`, actual owner `agent_6CJBvMqfk9oTsg`, human reviewer `person_fabio`. Comparison `e0533909-3c0d-458f-b75c-59a6d1855eee` completed in one attempt, artifact `art_aHJ0bX5jGZ3ZwA`. Result: 4 increases, 3 decreases, 2 unchanged, 3 new, 3 removed, 3 excluded and 4 anomaly signals, matching the independent fixture. Quit/reopen recovered the agreement, actual agent, summary and downloadable report.
6. Report recovery exposed a presentation lifecycle loop: refreshing intake temporarily unmounted the comparison card, resetting its completion tracking and refreshing history again. Intake now refreshes in place; denied reads still discard its proposal. On the final packaged app, opening the recovered full report succeeded; it remained open across subsequent observations and resizing. Conversation scrolling worked independently of the stable right summary. A narrower native window (approximately 1,000 screenshot pixels wide) retained readable summary, composer and download actions without a nested objective scrollbar.

## Limits

The model is responsible for wording. An isolated real-model clarification test preserved `compare_csv` but sometimes changed title/output emphasis toward creating the collaborator. The UI therefore exposes the activity and full proposed brief for review and allows revising an idle agreement. This is still a known synthesis-quality limit, not a guarantee that arbitrary requests are interpreted correctly.

Concrete automatic execution in this flow is the deterministic two-CSV price comparison. `general` means planning, not an unimplemented general-purpose worker. The fake provider does not supply valid structured synthesis and correctly produces a recoverable error. Local macOS packaging remains unsigned. No public release or push was performed.

## Final delivery artifact

- App: `dist/desktop/2026-09-19T12-50-30-931Z/Homun-darwin-arm64/Homun.app` (left open).
- ZIP: `dist/desktop/2026-09-19T12-50-30-931Z/Homun-0.1.0-macos-arm64.zip`, 184,964,164 bytes.
- SHA-256: `fb4065f09e50ae7a84c6dad85e134e48ac1a34c10e3f5b90452b998284c10051`.
- ZIP CRC, extracted engine inventory, shell byte comparison and isolated bundled-engine smoke all passed. The engine inventory matches current source.
- Final read-only verification of the synthetic demo after restart: exactly one artifact for the work, one execution attempt, one real agent in the roster. No duplicate execution on restart.

The final frontend lifecycle fix was verified by native reproduction, report expansion and resizing, plus TypeScript, all 137 frontend tests and a rebuilt production package. No dedicated automated React mount-lifecycle test was added; the separate backend execution regression is automated.
