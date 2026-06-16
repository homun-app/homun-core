---
name: branch-workspace-lifecycle
description: Use when starting isolated feature work, deciding whether to use a git worktree, preparing branch cleanup, finishing a development branch, opening a PR, merging, or preserving handoff state before integration
---

# Branch Workspace Lifecycle

## Overview

Long-running coding work should not blur workspace state. HomunCoder uses this skill to decide when work needs an isolated branch or worktree, how to preserve provenance, and how to finish the branch without losing verification or project memory.

## Start Gate

Before starting non-trivial implementation:

1. Inspect `git status --short --branch`.
2. Identify whether the current worktree has unrelated changes.
3. Decide whether isolation is needed.
4. Record the branch/workspace choice in the active plan or thread ledger when the task is more than a quick edit.

Use an isolated branch or worktree when:

- Existing changes are unrelated to the new task.
- The task is risky, broad, or likely to take more than one session.
- A benchmark, migration, dependency update, or generated-output step may create noisy diffs.
- The user asks for parallel work, comparison branches, or a PR-ready result.

You may stay in the current workspace when:

- The worktree is clean and the task is small.
- The user explicitly wants the current branch used.
- The repository does not support worktrees cleanly and the fallback is recorded.

## Worktree Decision

Prefer the repository's native workflow if it exists. Otherwise use git branches and worktrees conservatively:

- Do not overwrite or discard user changes.
- Do not delete a worktree or branch without explicit user approval.
- Keep worktree names tied to the task, not generic labels.
- Record the base branch and target branch.
- Record any setup commands needed to reproduce the workspace.

If a worktree cannot be created, state the blocker and choose the safest fallback: current branch with explicit status notes, a normal branch, or a separate clone only if the user approves.

## Finishing Gate

Before saying a branch is ready to merge, push, or PR:

1. Re-read the active plan, roadmap, and relevant wiki state.
2. Check `git status --short --branch`.
3. Summarize changed files by purpose.
4. Run focused verification and broader affected verification.
5. Run `git diff --check`.
6. Update roadmap/wiki/thread ledger if the work changes direction, decisions, sources, or next action.
7. Decide the finish path with the user when it affects remote state:
   - leave local only;
   - commit only;
   - push branch;
   - open draft PR;
   - merge locally;
   - clean up worktree/branch.

Do not treat "tests passed" as sufficient if memory, docs, or handoff artifacts are stale.

## Completion Report

When completing branch or worktree lifecycle work, include:

```markdown
## Workspace Lifecycle

- Base:
- Branch/worktree:
- Dirty state before:
- Changed files:
- Verification:
- Memory/docs updated:
- Finish decision:
- Cleanup needed:
```

## Common Mistakes

- Starting risky work on a dirty branch without naming the risk.
- Creating a worktree and then forgetting setup or cache differences.
- Merging or deleting branches without explicit user approval.
- Pushing changes before verification and memory flush.
- Reporting a clean finish while untracked benchmark or generated files remain.
