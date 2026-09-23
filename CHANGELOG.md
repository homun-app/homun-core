# Changelog

All notable changes to Homun are documented here. This is the single source of
truth: the released version's section is written into the GitHub Release body
(from which the app shows the in-app "What's new" on update).

Section headers are `## Highlights` / `## Improvements` / `## Fixes` (H2), and
each bullet is a single line; version delimiters are `## [x.y.z] — date`.

## [Unreleased]

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
