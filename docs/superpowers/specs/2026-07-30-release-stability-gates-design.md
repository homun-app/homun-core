# Release Stability Gates Design

**Status:** Approved for implementation on 2026-07-30

## Goal

Make the current Homun kernel a defensible release candidate without adding a
parallel release system. GitHub Actions remains the only multiplaform packager,
and public availability remains a separate manual decision after draft-asset
validation.

## Current Evidence

- The deterministic local pre-release gate passes on `a909d950`.
- The first Linux CI attempt on that commit failed before gateway readiness in
  `gateway_crash_recovery`; the retry passed, but the child log was deleted
  before it could be reported.
- The installer workflow can package and upload draft assets without running the
  complete deterministic gate on the same workflow attempt.
- The live stability soak accepts a terminal status without requiring exactly
  one canonical terminal event and one canonical assistant identity.
- Draft release assets have electron-updater hashes, but no user-verifiable
  SHA-256 manifest.
- The public release remains `v0.1.1078`; the existing `v0.1.1093` draft predates
  the current kernel and must not be published as the new kernel release.

## Design

### 1. Crash-Recovery Harness

The hard-restart integration test will retain an ephemeral loopback reservation
until immediately before spawning the gateway. Startup failure and readiness
timeout errors will include the bounded child log contents, not only a temporary
path that is deleted during unwinding. The test will keep using a real gateway
process, SQLite database, hard kill, restart, and canonical state assertions.

This improves the evidence and removes the observable port-allocation TOCTOU
window without adding retry-based masking around a gateway crash.

### 2. Deterministic Release Gate

`scripts/pre_release_gate.py` remains the single local and CI entry point. Its
required deterministic plan will include:

- Rust formatting;
- workspace Clippy with warnings denied;
- the existing kernel/runtime/gateway suites;
- desktop production dependency audit;
- existing Electron, packaging, compliance, UI, renderer, and build checks.

RustSec remains a workflow-level check because its advisory database is a
network input. No vulnerability will be ignored merely to obtain a green build.

The installer workflow will add a validation job and every platform packaging
job will depend on it. A tag or manual dispatch therefore cannot package before
the same workflow has passed deterministic validation and dependency audit.

### 3. Canonical Stability Soak

The soak evaluator will require, for every enqueued logical turn:

- a terminal task status;
- exactly one canonical terminal event;
- exactly one canonical assistant identity;
- no reasoning leakage;
- no foreground-selection theft.

The restart mode will support a real hard kill so the optional release soak
exercises lease and journal recovery instead of graceful shutdown only. Its JSON
report remains metadata-only.

### 4. Release Artifacts

A small cross-platform Node script will create a deterministic SHA-256 manifest
for installer files. It will reject an empty artifact set and exclude checksum
files from their own input. Unit tests will cover ordering, digest format,
filtering, and the empty-set failure.

Each platform job will generate and upload its manifest with the workflow
artifact. On a version tag the manifest will also be attached to the draft
release. This does not publish the release.

### 5. Upgrade and Installed-Candidate Evidence

The release procedure will require an isolated profile copied from the latest
public version and opened by the candidate. The evidence must cover database
open/migration, conversation/task visibility, Vault metadata, memory,
connections, runtime settings, and a new canonical turn. Real secrets are never
copied into test reports.

Because signed/notarized candidate assets exist only after a tag build, this
gate is post-build and pre-publication. Failure leaves the GitHub release in
draft state.

### 6. Repository Protections

After the workflow changes are green on `main`, repository protection will
require the frontend, backend, Linux Landlock, and release-readiness checks
before integration. Version tags must point to a commit that passed those checks.
The release workflow itself still enforces validation, so repository settings
are defense in depth rather than the sole guard.

## Error Handling

- Child-process startup failures print bounded logs and preserve the original
  exit status.
- Release validation fails closed at the first failed deterministic step.
- A failed platform build or missing installer file fails the matrix job.
- A failed checksum upload leaves the release draft incomplete and therefore
  non-publishable.
- A failed installed/upgrade smoke never edits or publishes the public release.

## Non-Goals

- Publishing a release in this change.
- Introducing a second lifecycle, task store, or release orchestrator.
- Claiming Windows filesystem sandboxing or Linux network isolation that the
  current kernel does not enforce.
- Implementing effect compensation for adapters that do not yet declare a safe
  inverse operation.

## Acceptance Criteria

1. The crash-recovery test reports child logs and passes repeated local runs.
2. The complete deterministic gate passes with warnings denied.
3. CI and installer validation pass on the same commit.
4. The hard-restart soak rejects missing or duplicate terminal evidence.
5. GitHub produces all platform artifacts and deterministic checksums without
   publishing them.
6. An isolated installed-candidate and upgrade smoke is recorded before any
   release draft is made public.
