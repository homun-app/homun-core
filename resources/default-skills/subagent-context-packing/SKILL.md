---
name: subagent-context-packing
description: Use when delegating work to a subagent, reviewer, parallel worker, or separate agent session
---

# Subagent Context Packing

## Overview

Subagents should receive enough context to succeed without inheriting the full conversation. Pack exact task context, sources, decisions, and local standards.

## Required Packet

Include:

- A prompt brief when the source request is short, broad, or ambiguous.
- Task goal and non-goals.
- Relevant plan section.
- Relevant roadmap state.
- Source ledger entries.
- Architecture and decisions that constrain the task.
- Folder docs and code standards.
- Expected files or areas to inspect.
- Verification commands.
- Required memory/docs updates.

## Avoid

- Raw chat history.
- Vague prompts like “continue the task.”
- Letting subagents rediscover known decisions.
- Omitting source/version evidence for external APIs.

## Completion Contract

Require the subagent to report:

- Status: `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`.
- Files changed.
- Verification run.
- Wiki/roadmap/folder docs updated.
- Open risks.
