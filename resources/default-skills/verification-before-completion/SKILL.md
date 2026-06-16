---
name: verification-before-completion
description: Use when about to claim work is done, fixed, passing, ready, complete, reviewed, or safe to merge
---

# Verification Before Completion

## Overview

Evidence must come before success claims. Fresh verification is required in the current task context.

## Gate

Before claiming completion:

1. Identify the command or inspection that proves the claim.
2. Run the full command or perform the inspection.
3. Read the output and exit code.
4. Compare results against acceptance criteria.
5. State the actual result, including failures or unverified areas.

## Not Enough

- “Should pass.”
- “Looks correct.”
- Previous test run.
- Subagent report without independent verification.
- Linter pass when build/test is the real claim.

## Required Final Evidence

Report:

- Commands run.
- Result.
- Remaining risk or unverified items.
- Roadmap/wiki updates performed.
