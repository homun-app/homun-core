---
name: prompt-briefing
description: Use when turning a short user request into a complete prompt, preparing a Codex/Claude/subagent handoff, rewriting an ambiguous task brief, or asking the user to approve or edit the execution prompt before work starts
---

# Prompt Briefing

## Overview

Users should be able to write short, natural requests. The agent should expand them into an execution-ready prompt when the task is broad, risky, multi-step, delegated to another agent, or likely to suffer from missing context.

This skill is a prompt compiler: preserve the user's intent, add the methodology gates, expose assumptions, and ask for approval when the rewritten prompt will steer significant work.

## Auto Activation

Use this skill automatically when the user asks to write, improve, rewrite, generate, prepare, translate into a better prompt, or hand off a prompt for Codex, Claude, another model, a subagent, a reviewer, or a benchmark. The user should not need to say "Use HomunCoder" for prompt rewriting.

When generating a prompt for another agent, include "Use HomunCoder" only if the target environment has HomunCoder available. Otherwise include the portable HomunCoder operating rules directly.

If Superpowers or another methodology plugin is also installed, prompt rewriting remains a HomunCoder-primary workflow unless the user explicitly asks for that other methodology. Do not lead with Superpowers for prompt rewriting just because its bootstrap skill exists.

## Language

Write the explanation, assumptions, and approval request in the user's language. Keep the draft prompt in the user's language unless the target agent, repository, or user explicitly requires another language.

## When To Use

Use this skill when:

- The user asks for a prompt, handoff, Claude/Codex instruction, or subagent task.
- The user asks to rewrite, improve, strengthen, structure, or generate a prompt.
- The user gives a short brief for a non-trivial task.
- The task needs project memory, docs lookup, benchmarks, logging, or verification discipline.
- The next step may be run in a different chat, model, tool, or agent.

Do not force this gate for tiny direct edits or commands where the user's intent is already precise.

## Required Output

For prompt rewriting, produce:

```markdown
## Draft Prompt

...

## Assumptions

- ...

## Missing Context

- ...

## Approval Needed

Reply with `approve`, edits, or constraints to change before execution.
```

If there is no meaningful missing context, say `None critical`.

## Prompt Requirements

The draft prompt should include, when relevant:

- Target agent or tool: Codex, Claude, subagent, reviewer, benchmark runner.
- Instruction to load project memory instead of relying on chat history.
- Scope and non-scope.
- Files, folders, docs, or artifacts to inspect.
- Required research sources, including Context7, official docs, web, or GitHub checks.
- Observability/logging requirements for runtime problems.
- Planning, verification, and memory-update requirements.
- Explicit stop conditions for missing data, risky assumptions, or unavailable tools.
- Expected output format.

## Approval Rules

Ask for approval before execution when:

- The rewritten prompt changes the user's scope materially.
- The task is expensive, destructive, production-facing, security-sensitive, or architecture-level.
- The prompt will be sent to a separate agent or external tool.
- Missing context could change the recommended plan.

If the user already says to proceed autonomously, create the prompt internally and execute, but still preserve the prompt or summary in the plan or handoff when useful.

## Quality Bar

Good prompt briefs:

- Keep the user's language and intent.
- Add only constraints that improve outcome quality.
- Mark assumptions instead of hiding them.
- Keep prompts executable, not essay-like.
- Avoid over-constraining creative or exploratory tasks.
- Prevent lazy work by requiring sources, logs, tests, and memory updates where they matter.

## Common Mistakes

- Rewriting every small request into a long ritual.
- Executing a broad ambiguous task without showing the prompt first.
- Adding invented context or fake file names.
- Omitting verification and durable memory for long-running work.
- Asking for approval without giving a concrete draft to approve.
