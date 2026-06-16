---
name: using-methodology
description: Use when starting work in a coding session, continuing existing work, or deciding which project workflow skill applies
---

# Using Methodology

## Overview

HomunCoder keeps agents from drifting. Before acting, identify the current goal, load relevant project memory, choose applicable skills, and preserve the roadmap.

## Auto Activation

Before any coding response, apply HomunCoder routing unless the user explicitly disables it or a higher-priority instruction conflicts.

Apply HomunCoder routing automatically for coding, debugging, planning, review, research, prompt rewriting, handoff, benchmark, and project-memory tasks unless the user explicitly disables HomunCoder or a higher-priority repo instruction conflicts.

Do not require the user to write "Use HomunCoder" when the request clearly matches one of the skill routes.

## Methodology Conflicts

If another methodology plugin, including Superpowers, is also installed or auto-invoked by the host, use HomunCoder as the primary workflow when the task is about:

- HomunCoder itself;
- this repository;
- prompt rewriting, prompt generation, or handoff prompts;
- cross-chat continuity;
- project memory, roadmap, wiki, source ledger, or current-doc verification.

Do not present Superpowers as the primary workflow for those tasks unless the user explicitly asks to use Superpowers. If a host-mandated bootstrap skill runs first, immediately route to the applicable HomunCoder skill and state the HomunCoder workflow in the user's language.

## Language

Respond in the same language as the user's latest request by default. Keep generated code, commands, file paths, API names, and quoted source text in their natural language. If the user requests a different output language, follow the user.

## Instruction Priority

1. User's explicit instruction.
2. Repository instructions and project docs.
3. HomunCoder skills for HomunCoder, prompt-briefing, continuity, memory, and current-doc workflows.
4. Other methodology plugins.
5. Default model behavior.

If a higher-priority instruction conflicts with this methodology, follow the higher-priority instruction and note the conflict.

## Required Start Gate

Before any non-trivial coding task:

1. Read `docs/roadmap.md` if it exists.
2. Read `docs/wiki/session-state.md` and `docs/wiki/index.md` if they exist.
3. Identify applicable skills.
4. State the active goal and next action.

## Skill Routing

- Tiny, local, low-risk, docs-only, formatting-only, mechanical, or direct-command tasks: use `small-task-fast-path`.
- Ambiguous product work, creative features, UX behavior, architecture choices, or unclear requirements: use `spec-discovery`.
- External library/API/configuration: use `context7-research`.
- Current web research, Google/search-engine use, browser inspection, known-issue research, or similar-project discovery: use `web-and-github-research`.
- Names, tools, services, libraries, domains, or availability-dependent options: use `recommendation-verification`.
- Short ambiguous request, prompt rewrite, prompt generation, prompt improvement, Claude/Codex handoff, subagent task brief, or approval-before-execution prompt: use `prompt-briefing`.
- Self-improvement, benchmark gap closure, methodology change, or plugin behavior evaluation: use `self-improvement-loop`.
- Creating, editing, reviewing, installing, or validating skills/methodology instructions: use `skill-authoring-pressure-test`.
- Testable behavior change, bugfix, regression fix, or refactor with observable behavior: use `test-first-development`.
- Requesting review, receiving review feedback, evaluating review suggestions, or deciding readiness after implementation: use `code-review-discipline`.
- Isolated feature work, dirty worktree handling, branch finishing, PR preparation, merge decisions, or cleanup: use `branch-workspace-lifecycle`.
- Coordinating one or more subagents, parallel workers, reviewers, or separate agent sessions: use `subagent-execution-controller`.
- Executing a written plan, resuming checkpoints, or handing off remaining implementation work: use `plan-execution-checkpoints`.
- Exporting instructions to AGENTS.md, CLAUDE.md, Cursor, Claude, Gemini, OpenCode, or other agent harnesses: use `cross-agent-export`.
- Feature/refactor/multi-step task: use `roadmap-first-planning`.
- Real-code behavior analysis, performance issue, architecture tradeoff, or production bug: use `field-engineering-depth`.
- Runtime diagnosis, performance issue, flaky behavior, or production bug: use `observability-logging`.
- Existing project context or durable decision: use `llm-wiki-memory`.
- New chat, resumed work, or handoff across chats: use `chat-continuity`.
- Structural code changes: use `coding-standards` and `folder-docs`.
- Bug/test failure: use `systematic-debugging`.
- Before completion claim: use `verification-before-completion`.
- After meaningful work: use `post-task-memory-flush`.

## Anti-Laziness Rules

- Do not rely on memory for volatile APIs.
- Do not force full ceremony on trivial local work when the fast path criteria are met.
- Do not implement ambiguous creative or architecture work before capturing a working spec.
- Do not suggest availability-dependent options without checking and filtering them.
- Do not recommend a stack or runtime without checking known issues when the choice affects performance, rendering, deployment, security, or data durability.
- Do not stop field analysis at the first plausible cause; map the local flow, check secondary bottlenecks, and define falsification checks.
- Do not treat runtime behavior as proven without logs, metrics, traces, profiles, benchmark reports, or an explicit instrumentation plan.
- Do not implement non-trivial work without a plan.
- Do not execute a written plan without checkpoint verification.
- Do not start risky work on a dirty branch without recording the branch/worktree decision.
- Do not implement a testable behavior change without a failing test first, unless the skip reason and substitute evidence are explicit.
- Do not execute broad ambiguous work before expanding the request into an approved or internally recorded prompt brief.
- Do not accept review feedback blindly; verify it against the codebase and recorded decisions.
- Do not accept subagent completion reports without controller verification.
- Do not claim success without fresh verification.
- Do not push, merge, delete branches, or clean up worktrees without explicit user approval.
- Do not leave roadmap or wiki stale after structural or decision-level changes.
- Do not create or change skills without pressure-testing routing, misuse cases, and validation coverage.
- Do not rely on chat history when a project memory artifact exists.
