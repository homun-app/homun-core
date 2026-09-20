# Mem0 Local Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Wire DualWriteMemoryPort to local Mem0 (Ollama + Qdrant) with explicit config.

**Spec:** `docs/superpowers/specs/2026-09-18-mem0-local-stack-design.md`

---

### Task 1: Spec — done with this plan

- [x] Design spec

### Task 2: Local config + deps

- [x] `build_local_mem0_config()` + env
- [x] `qdrant-client` in `[memory]` extras
- [x] Fail loud on init

### Task 3: Dual-write + tests

- [x] Fake Mem0 isolation tests
- [x] Best-effort delete/rectify on Mem0

### Task 4: Status + UI

- [x] `GET /v1/memory/status`
- [x] Settings status + recall box

### Task 5: Docs

- [x] README, roadmap, piano, live test marker
