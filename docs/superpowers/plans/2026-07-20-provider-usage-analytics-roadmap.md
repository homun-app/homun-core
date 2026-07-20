# Provider Usage Analytics Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver complete, privacy-safe inference accounting, provider limits, usage UI and confirmed model suggestions in five independently gated phases.

**Architecture:** A shared metadata-only contract feeds an append-only SQLite ledger in the desktop gateway. Pricing, provider snapshots, UI projections and suggestions build on that canonical ledger without changing inference behavior automatically.

**Tech Stack:** Rust workspace, Axum, rusqlite/SQLite, reqwest, React 19, TypeScript, CSS, Node test runner, Electron.

---

## Execution order

| Phase | Plan | Gate |
|---|---|---|
| A | [Usage ledger and instrumentation](./2026-07-20-provider-usage-phase-a-ledger.md) | Every known inference path records metadata-only attempts and exposes trusted aggregates. |
| B | [Pricing, provider snapshots and policy](./2026-07-20-provider-usage-phase-b-provider-accounting.md) | Reported/estimated/unknown cost and provider-account state remain distinct. |
| C | [Settings Usage](./2026-07-20-provider-usage-phase-c-settings.md) | Overview, Models, Providers and Processes are usable and accessible. |
| D | [New-chat usage overview](./2026-07-20-provider-usage-phase-d-new-chat.md) | Prompt chips are replaced by the approved operational summary. |
| E | [Confirmed model suggestions](./2026-07-20-provider-usage-phase-e-suggestions.md) | Suggestions respect hard constraints and never mutate routing without confirmation. |

Phases are sequential. Each phase starts from the green commit produced by the previous phase and ends with its own focused tests, regression gate and commit. Do not start a later phase while the prior gate is red.

## Requirement coverage

| Approved requirement | Owning phase |
|---|---|
| Every logical call, retry, fallback, local inference and embedding is accounted for | A |
| Metadata-only append ledger, scoped aggregates, no historical backfill and rebuildable daily projections | A |
| Fail-open recording, workspace purge, full factory reset and sentinel privacy verification | A–B |
| Reported, catalog-estimated, manual-estimated, not-billed and unknown cost remain visibly distinct | B–C |
| Provider-account state uses only standard model keys; unsupported limits stay explicitly unknown | B–C |
| Manual monthly budgets, reset policy and model-price overrides | B–C |
| Settings → Usage with Overview, Models, Providers and Processes | C |
| New-chat operational summary replaces canned prompt examples | D |
| Suggestions are evidence-based and cannot mutate routing without explicit confirmation | E |

## Release boundary

Phases A–D form a useful release without suggestions: users can inspect usage and costs even when insufficient history exists for a recommendation. Phase E may ship in the same release only after real multi-provider QA satisfies its confidence and privacy checks.
