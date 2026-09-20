# Conversational intake UX implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded backend and presentation tasks; root owns integration and native acceptance.

**Goal:** Turn a natural request into a persisted, reviewed work brief and collaborator proposal before assignment, with compact work navigation.

**Architecture:** Reuse draft Work/Conversation as durable intake containers; preserve the request as a message. Separate structured model synthesis, authoritative roster validation, versioned proposal confirmation and React presentation. Reuse the existing comparison tool after confirmation; keep exact material/action approval distinct from staffing approval.

**Tech Stack:** Python/Pydantic, existing ModelRegistry, SQLite domain commands, React/Electron.

Approved by user on 2026-09-19. Continue on current fabio branch because the foundation being extended is uncommitted here; do not copy or discard the working tree. No push or public release.

## 1. Backend intake contract

Files: new engine/src/homun/application/intake*.py, models/intake.py, routes/intake*.py; existing app router, work naming domain integration; engine/tests/test_intake.py.

- [x] Write failing tests: POST proposal never reassigns or executes; request is durable; output title/objective are separate; forged/missing agent rejected; confirmation persists exact summary/owner and handles duplicates; stale work/agent revision blocks; provider failure produces no fake success; rename survives later synthesis; existing completed work is not rerun.
- [x] Implement `POST /works/{id}/intake` with `{command_id,text,expected_version}`, `GET` -> `{items: [...]}`, `POST /intake/{proposal_id}/confirm` with `{command_id,digest,expected_version,create_agent:boolean}`. Proposals contain title, objective, output, constraints, missing_information, suggested_agent, new_agent, rationale, capability, status, digest, revision, original_request. Restrict capability to implemented compare_csv or general planning; model cannot invent tools or permissions.
- [x] Model synthesis uses configured provider and real active agent descriptions/instructions; validate bounded structured output. New profile is proposed only and creation/assignment require explicit confirmation. Persist confirmed proposal and normalized brief through existing domain transaction. No model call inside lock.
- [x] Run focused tests and update OpenAPI; independent review of authority/replay/recovery before final integration.

## 2. Compact presentation

Files: EngineWorkspaceWorkPanel.tsx, EngineWorkObjectiveEditor.tsx, new intake presentation modules/CSS; EngineStatusBar/ConversationEngineBanner.

- [x] Replace always-editing objective with readable short brief and explicit edit mode. Show Italian status and next step; remove nested scroll/textarea by default. Diagnostics collapsed, error states remain visible.
- [x] Keep module bounds; no engine/simulation mixing. Existing work retains its original persisted history. Add explicit user-controlled rename/brief refinement where needed rather than silently rewriting history.

## 3. Chat integration

Files: new engine-intake-client.ts, useWorkIntake.ts, EngineWorkIntake.tsx; useEngineWorkspace creation helper; ConversationWorkspaceChatStage.tsx.

- [x] Write transport tests for exact confirmation payload and typed denial before implementation.
- [x] Create intake draft under temporary title, persist initial request through intake endpoint; refresh authoritative work. Render proposal in chat and let user revise details or confirm suitable agent/new profile. Failed provider requests are retryable.
- [x] Price files appear contextually after confirmed compare_csv capability. Execution still uses existing material ingestion/digest approval. No automatic reassignment, no unconfirmed capability activation. Refresh and restart recover proposal and confirmation.

## 4. Acceptance

- [x] Run backend tests, frontend typecheck/tests/build, architecture and OpenAPI checks.
- [x] Build native app, inspect actual title/brief/card/panel. Use synthetic demo CSVs through complete new flow; verify agent creation suggestion when catalog empty, explicit confirmation, contextual upload, report, restart, no duplicate result.
- [x] Verify no-agent/provider-error/stale-proposal paths by focused tests; editing and a narrower native window in GUI. Record delivery evidence and limits. Do not claim unimplemented tools or broad production readiness.

- [x] Verify a narrower native window: report, composer and right summary remained usable during native resize; no objective textarea scrollbar in reading mode.

Evidence and limitations: `docs/research/2026-09-19-conversational-intake-ux-verification.md`.
