# Changelog

All notable changes to Homun are documented here. This is the single source of
truth: the released version's section is written into the GitHub Release body
(from which the app shows the in-app "What's new" on update).

Section headers are `## Highlights` / `## Improvements` / `## Fixes` (H2), and
each bullet is a single line; version delimiters are `## [x.y.z] — date`.

## [0.2.1002] — 2026-10-08

Spaces collaborate: another machine joins yours with an invite, sees only the projects you share, contributes and takes delegated work — all with a verifiable device identity.

## Highlights
- **People, invites and real sessions.** Single-use invites create persons with roles; sessions are bound to the person and die with their revocation, which also closes devices, grants and delegations. Access stays explicit: an invited person sees nothing until you share a project.
- **Pairing between machines with proof of possession.** A device joins with its own Ed25519 key and must sign a challenge: the invite is consumed only on the correct signature, so a stolen or mistyped token burns nothing.
- **Selective read replication.** A peer subscribes to a shared project's events by cursor and browses conversations, works and messages marked *Fonte: motore remoto*, read-only, in a store separate from its own space.
- **Remote contributions with an honest outbox.** Delivery is distinct from outcome (a version conflict is delivered, not accepted); when the host is down commands wait as "in attesa di consegna" — never shown as saved — and flush in order on reconnect.
- **Delegation to peers with a single result.** Assignments carry input hash and reserved attempts; an identical return reconfirms the receipt, a different one is an explicit conflict, expiry closes without ghost results.
- **Peer onboarding and reading in the app.** Settings → Spazi remoti enters with an invite and shows synced projects; the sidebar view reads remote conversations with markdown; `homun peer` covers the full flow from the terminal.

## Improvements
- **Chat on the official assistant-ui thread**: streaming with separated reasoning, collapsible tool groups, markdown tables; reasoning and tool calls stay visible in history too.
- **Engine resilience**: recovery mode on corrupt databases (quarantine, deterministic salvage, diagnosis narrated in chat), daily backups with retention, zombie run closure, periodic WAL checkpoints; idle CPU down to 1-2%.
- **Automations create routines from the view**, choosing a successful work as model with cadence preview; the "+" inside a project inherits its memory, materials and permissions.
- **Three-OS build validation** on every PR (macOS, Linux, Windows) with pinned external driver dependencies.

## Fixes
- **Conversation writes now enforce authority before mutation** (project write access), closing a gap that mattered once remote peers existed.
- **Pairing validates the invite on presentation and never persists its secret**; local invite redemption is localhost-only.
- **Connector failures are visible** (error surfaced in view, failed OAuth popup closed); project names are unique with reuse on auto-creation.
- **Date grouping in the sidebar uses real engine timestamps** on calendar days, never invented ones.

## [Unreleased]

## Highlights
- **Work directly with Homun without creating a specialist bot.** Optional company onboarding proposes a small team for recurring responsibilities.
- **Adaptive work over approved materials.** Homun can read, search, consult selected AI teammates, request clarification and deliver a reviewable result with persisted progress.
- **Scoped human contributions.** Named recipients can answer one request through an expiring, revocable link; an adaptive run can resume from that answer. Reachable hosting remains a prerequisite.

## Fixes
- **Model retries remain bounded after a crash.** Corrections interrupt stale waits immediately, and malformed usage counters cannot reduce recorded spending.
- **Materials and Plugins use the engine from the sidebar.** Files, previews, archival and capability settings share the persisted engine state; denied access clears stale previews.
- **Task deadlines persist from the Tasks view**, with saving feedback and typed errors.
- **Tool chains resume after artifact publication without duplicating results**, preserving DBOS journal step order.
- **Synthesis respects the assigned collaborator's budget and approved sources**, preserving known token counts in partial usage reports and blocking further calls at exhausted limits.
- **Routine recovery reconciles cron and timezone drift** while preserving pause state.
- **Manual update checks offer the available version only once.**

## Improvements
- **Recover from model context rejection through bounded compaction.** Homun preserves original history, respects output and attempt limits, and stops explicitly when protected context cannot shrink.
- **Durable context checkpoints for native agent runs.** Automatic summaries preserve original history, recent corrections and complete tool rounds; configured model limits and separate usage accounting remain explicit.
- **Pause, resume and redirect native agent work.** Chat corrections reach the active run; pending tools survive pause, stale responses cannot publish, and revoked source history remains hidden.
- **Native agent tool rounds in the Homun engine**, with persisted call/result history and pending-call recovery after human input; Hermes-derived execution guidance includes MIT attribution.
- **Current usage and developer documentation**, with verified limits and a dated Hermes usage comparison.

## [0.2.1001] — 2026-09-23

Updating becomes a visible, guided flow: you watch the download and choose when to restart.

## Improvements
- **Download progress window.** Accepting an update now opens a small progress window (percentage and megabytes); the Dock icon mirrors the progress. Homun keeps working while it downloads.
- **Explicit restart consent.** When the download completes the app asks whether to close and restart now to install, or install on the next quit. Nothing is ever installed silently.

## Fixes
- **A malformed update event can no longer crash the main process** (defensive guards around the update offer, the download start and the Dock progress call).
- **A staged download equal to the running version no longer prompts again** (leftover from an install-on-quit is ignored unless genuinely newer).

## [0.2.1000] — 2026-09-23

Updates become visible: the app now says which version it runs and lets you check for updates on demand.

## Improvements
- **The installed version is now visible in Settings → Guide, with a "Check for updates now" action.** The automatic check still runs at startup and nothing is ever installed without consent; the new card makes "already up to date" distinguishable from "cannot tell".
- **Release notes are written in English.**

## [0.2.1] — 2026-09-23

A clean first-run experience: every trace of the development environment is gone from shipped builds.

## Fixes
- **Neutral identity on first launch.** A new user is named "Tu" (editable in Settings), no longer the development demo identity.
- **Removed development references from the interface**: the "Previous version" link in the sidebar, the technical indicator in the header, the "PROTOTYPE" label, the demo-data section and links (development builds only), and the misleading "Local archive" and "demo catalog" wordings.

## [0.2.0] — 2026-09-22

The new generation of Homun: the same assistant that delegates real work to collaborators, rebuilt on a local conversational engine with explicit human approval for every execution.

## Highlights
- **Collaborators write real work with their own model.** Synthesis phases produce actual drafts (catalogs, reports) from materials, constraints and approved procedures, always delivered for human review; every model used is declared in the artifact.
- **No more silent executions.** CSV comparison, material reading, MCP tool calls and synthesis all start as digest-bound proposals you approve: the engine never runs anything without your explicit go.
- **Multi-phase work from agreement to outcome.** Conversational intake proposes objective, collaborator and phases; each phase advances with your verification and the work closes with a reviewed result.
- **Every collaborator has its own model.** The per-agent preferred connection is chosen from the agent card and actually used by that agent's synthesis phase, with a declared fallback.
- **Learned procedures guide the work.** Agent messages become approved procedures ("Save as procedure") and their body enters the context of later syntheses.
- **Engine-driven automations.** Recurring routines on a durable scheduler with pause, resume, skip-next and template revision; every recurrence stays supervised.
- **External MCP tools with a curated catalog.** Servers declared with allowlists and honest probing, supervised execution with results in review; vetted entries live in the repository, inert until you declare them.

## Improvements
- **Complete Settings**: people, models with per-activity recommendations, budget and routing, agents, teams, plugins, skills, automations, memory, archive.
- **Per-work budget**: attempts and tokens counted per work, with atomic reservations and typed exhaustion that only rises explicitly.
- **Documents and deadlines**: the engine artifact library and a deadlines view linked to works.
- **Standalone local Python engine**: receipt-verified bundle with hash-locked dependencies, bundled with the app; no external service required.
- **App hardening**: Electron fuses, sandbox, context isolation, CSP and an API proxy that keeps tokens out of the renderer.

## Fixes
- **Unsigned updates are impossible**: the release pipeline refuses to publish a macOS release without signing and notarization instead of shipping it to the update feed.
