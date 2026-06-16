---
name: recommendation-verification
description: Use when suggesting names, tools, libraries, services, vendors, domains, repositories, APIs, or options whose availability or current status matters
---

# Recommendation Verification

## Overview

Recommendations that depend on external availability must be verified before they are presented. Do not make the user sort through options that should have been filtered already.

## Gate

Before suggesting options:

1. Define what "available" means for the task.
2. Check the relevant external source.
3. Check known issues, limitations, and recent failure reports when the option affects architecture, runtime, rendering, performance, data durability, security, or deployment.
4. Filter out unavailable, taken, deprecated, incompatible, high-risk, or unverified options.
5. Label partial checks honestly.
6. Present only options that meet the criteria, or clearly separate "verified" from "not verified."

## Examples

- Product or plugin name: check GitHub account/org, exact repo conflicts when relevant, package registry, and domain if requested.
- Project idea: use `web-and-github-research` to find similar repos and current alternatives before recommending a direction.
- Language/framework/runtime choice: check maintenance, version compatibility, official docs, project fit, known failure modes, and mitigation paths.
- Library choice: check maintenance, version compatibility, official docs, known issues, and project fit.
- API recommendation: check current official docs or Context7.
- Service choice: check current pricing/status if it affects the recommendation.
- Desktop/mobile/webview stack: check platform-specific rendering/performance issues, open GitHub issues, official runtime constraints, and realistic fallbacks.

## Required Output

For each recommended option, include:

- Source checked.
- Result.
- Known issue or limitation checked.
- Mitigation or fallback when relevant.
- Date.
- Limitation, if any.

## Stop Conditions

Do not present unverified options as recommendations when verification was requested or obviously necessary. If rate limited or blocked, say so and recommend only the verified subset.
