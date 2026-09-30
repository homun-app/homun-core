---
name: skill-authoring
description: Write and propose Homun skills well — frontmatter, structure, when to patch instead of creating.
---

# Authoring Homun Skills

A skill is the procedure for a class of task: the steps in order, the concrete
tool calls, the decision points, the pitfalls that cost time. A future run
should be able to follow it and produce the right result on the first try.

## Where skills live and how they change

- Skills live in the workspace catalog. Use `skill_search` and `skill_view`
  to read them; propose changes with `skill_propose` (new) or `skill_patch`
  (update an existing agent-authored skill).
- Every proposal lands in **staging quarantine**: a human must approve it
  before the skill is served as trusted guidance. Never claim a skill is
  active right after proposing it.
- `skill_patch` on an approved skill returns it to staging — that is
  expected: the next human review re-approves it.

## Writing the body

- **Procedure first**: numbered steps in the order they are done, with the
  concrete tool names and arguments that work on Homun (`write_workspace_file`
  requires an approval digest; `terminal_execute` runs in the pinned
  container; memory tools are `memory_recall`/`memory_remember`).
- **One rule per lesson**: the same lesson learned twice is ONE rule. Before
  proposing, `skill_search` the catalog: if an existing skill covers the
  territory, `skill_patch` it instead of creating a near-duplicate.
- **Pitfalls are rules, not stories**: "Align columns before totals — the
  merge breaks otherwise", imperative, with the mechanism. No ticket ids,
  dates, or session narratives.
- **Fix in place**: edit the sentence that misled; never append
  "UPDATE: actually…" sections.
- **Reference depth goes in resources**: decision tables, recipes and
  runnable scripts are separate resource files (`references/…`, `scripts/…`),
  not more body. The body stays the always-on procedure.
- Keep `description` to one line (max 120 chars): it is what `skill_search`
  matches on and what a future run reads first.

## What NOT to capture

- Environment failures ("X is not installed"), negative tool claims
  ("browser does not work"), one-off tasks, or unvalidated sequences of
  failed attempts. These become self-imposed constraints that outlive the
  actual problem.

## Checklist before proposing

1. `skill_search` for the topic — patch beats create.
2. Body: procedure, pitfalls as rules, Homun tool names.
3. Description: one line, specific enough to find again.
4. State clearly in your reply that the proposal is staged and needs human
   approval.
