---
name: folder-docs
description: Use when adding folders, moving files, changing module responsibilities, or onboarding into unfamiliar project areas
---

# Folder Docs

## Overview

Folder docs make project structure navigable for future agents. Significant folders should explain their purpose and boundaries.

## When A Folder Is Significant

Create or update `README.md` or `FOLDER.md` when a folder:

- Contains source code with multiple files.
- Defines a domain, feature, service, package, or integration.
- Has local conventions not obvious from filenames.
- Is newly created or structurally changed.

## Template

```markdown
# Folder Name

## Purpose

What belongs here.

## Main Files

- `file.ext`: responsibility.

## Local Patterns

Conventions future agents must follow.

## Does Not Belong Here

Boundaries and anti-patterns.

## Related Docs

Links to roadmap, wiki, sources, or plans.
```

## Completion Gate

If a task changes folder responsibilities, folder docs must be updated before claiming completion.

