# Cross-platform onboarding and Homun Computer bootstrap

Date: 2026-07-22
Status: approved design

## Problem

The first-run wizard checks Docker and Ollama, but a runtime installed while Homun is already open may remain invisible until the desktop application restarts. This is especially visible on Windows because the running gateway keeps the `PATH` inherited at launch.

The contained computer has a second lifecycle gap. Homun attempts an eager start only once during gateway startup, which is too early on a fresh machine where Docker is installed during onboarding. The current container creation path also invokes `bash up.sh` on every platform. A normal Windows installation does not guarantee Bash, so `homun-cc` can fail to be created even after Docker becomes available.

The result is a first session that appears ready while the core contained computer is absent.

## Goals

- Apply one coherent onboarding flow to Windows, macOS, and Linux.
- Detect Docker and Ollama after they are installed without restarting Homun.
- Give the user an explicit recheck action in addition to automatic polling.
- Add a dedicated onboarding step that explains Homun Computer and prepares it visibly.
- Build, start, and verify `homun-cc` before the normal onboarding path enters Homun.
- Make container preparation idempotent and safe to retry.
- Remove the packaged application's runtime dependency on Bash for container creation.
- Surface actionable errors instead of hiding bootstrap failures in gateway logs.

## Non-goals

- Installing Docker Desktop, Docker Engine, or Ollama on the user's behalf.
- Replacing Docker with a different isolation runtime.
- Redesigning the model/provider selection step.
- Controlling the host desktop from `homun-cc`; the contained computer remains isolated from the host desktop.
- Removing the developer-facing `runtimes/contained-computer/up.sh` helper.

## User flow

The normal first-run sequence becomes:

1. Prerequisites
2. Prepare Homun Computer
3. Choose or connect an AI model
4. Ready

### Prerequisites

The wizard continues to poll Docker and Ollama automatically. It also exposes a visible **Check again** action. Each probe is fresh:

- Docker resolution checks the current filesystem and known platform locations on every probe rather than relying only on the process startup `PATH`.
- Docker readiness checks the daemon, not only whether the CLI executable exists.
- Ollama readiness checks its local HTTP API.

Installing either prerequisite while Homun is open must be detectable without restarting the desktop app.

### Prepare Homun Computer

After the prerequisites pass, the user enters a dedicated, blocking step. The screen explains that Homun Computer is an isolated workspace used to:

- browse through a real contained browser;
- execute tools and skills;
- create documents, presentations, and other artifacts;
- persist generated artifacts on the host without taking control of the host desktop.

The screen shows phase-based, truthful progress:

1. Docker available
2. Homun Computer image prepared
3. `homun-cc` started
4. Browser and live view verified

The model-selection step becomes available only after preparation succeeds. If an already-current and healthy `homun-cc` exists, the step completes immediately without rebuilding it.

If preparation fails, the screen remains in this step, shows a sanitized and actionable reason, and exposes **Try again**. Restarting Homun must not be the recovery instruction.

The existing global onboarding skip remains an explicit escape hatch from the first-run experience. It is not presented as the successful normal path and does not mark Homun Computer as prepared.

## Architecture

### Fresh prerequisite detection

The setup status endpoint must use the same platform-aware Docker resolver as the sandbox runtime. The resolver is evaluated per request and follows this order:

1. `HOMUN_DOCKER_BIN`, when explicitly configured;
2. current platform installation locations;
3. the current process `PATH`.

Platform locations include:

- Windows: Docker Desktop under the effective `ProgramFiles` directory and the standard fallback path;
- macOS: Docker Desktop, Homebrew, and the user's Docker CLI directory;
- Linux: common system and user installation paths.

The resolver reports installation and daemon readiness separately. This avoids the current divergence where setup uses bare `docker` while the runtime uses a more robust resolver.

Ollama remains an HTTP readiness check. The recheck button immediately repeats both probes; background polling remains active while the prerequisite step is visible.

### Setup bootstrap coordinator

The gateway owns an in-memory, concurrency-safe bootstrap coordinator with these states:

- `idle`
- `checking_docker`
- `preparing_image`
- `starting_container`
- `verifying_browser`
- `ready`
- `failed`

Starting preparation is idempotent:

- `ready` returns the current healthy result;
- an active preparation returns its current state instead of starting a duplicate Docker build;
- `failed` may be retried;
- a stale or stopped container starts a new preparation.

The onboarding uses a small setup API surface:

- `POST /api/setup/computer/prepare` starts or retries preparation;
- `GET /api/setup/computer/status` returns the current phase, completion state, and sanitized error.

The UI starts preparation when the dedicated step opens and polls status until `ready` or `failed`. The request that starts work returns promptly; Docker preparation continues in a gateway-owned blocking worker.

### Cross-platform container creation

The packaged application creates the contained computer with native Rust `Command` invocations of the resolved Docker CLI. It must not require Bash, PowerShell, WSL, Git Bash, or a login shell.

The native path preserves the existing runtime contract:

- optional best-effort refresh of `debian:trixie-slim`;
- content-derived `homun.cc_hash` image label;
- cached or `--no-cache` image build behavior;
- replacement of a stale `homun-cc` container;
- loopback-only CDP, noVNC, and Whisper ports;
- shared-memory and temporary-filesystem limits;
- timezone propagation;
- persistent Whisper volume;
- host artifact and browser-profile mounts;
- optional Docker network for server deployments.

The image-definition hash is calculated in Rust from the same files baked into the image, including bundled fonts. This makes freshness checks work on all three operating systems. Host data directories resolve from `HOME` and, on Windows, `USERPROFILE` as a fallback.

The shell helper remains available for developers and manual operation, but it is not the packaged application's bootstrap dependency.

### Verification

Preparation is successful only when all of the following are true:

- Docker reports the `homun-cc` container running;
- CDP responds at `/json/version`;
- the noVNC page responds successfully.

Container presence alone is insufficient. A failed browser or live-view probe moves the coordinator to `failed` with a retryable error.

## Error handling

Errors are classified without exposing command output that may contain host paths or sensitive environment data:

- Docker not installed;
- Docker installed but daemon not ready;
- contained-computer resources missing from the package;
- image pull unavailable, when no cached build can continue;
- image build failed;
- container start failed;
- CDP verification failed;
- noVNC verification failed.

The optional base-image refresh remains non-fatal when a cached base image is usable. Build and run failures are fatal for the preparation attempt and are shown as concise user-facing messages with a retry action.

## UI behavior

The preparation screen uses one flat progress surface rather than nested cards. It contains:

- a short explanation of isolation and capabilities;
- four status rows corresponding to the real backend phases;
- a progress indicator for the active phase;
- a success state before continuing automatically or enabling Continue;
- an inline error and Try again action on failure.

The UI never claims that Homun Computer is ready based only on a submitted Docker command. It renders only the gateway coordinator's observed status.

All new copy is added to English, Italian, French, German, and Spanish locales.

## Testing and release evidence

### Rust tests

- Docker resolution does not depend solely on startup `PATH`.
- Windows `ProgramFiles` resolution and `USERPROFILE` fallback are covered by pure tests.
- Docker build/run argument construction preserves ports, mounts, labels, timezone, network, and no-cache behavior.
- Image hashing is deterministic and changes when an image input changes.
- The bootstrap coordinator prevents duplicate builds and supports retry after failure.
- `ready` requires container, CDP, and noVNC evidence.

### Frontend tests

- Prerequisite recheck runs immediately and updates current state.
- Entering the preparation step starts one bootstrap request.
- Phase status maps to the four visible progress rows.
- Failure exposes Try again and a retry starts a new attempt.
- Model selection is not reachable through the normal path until preparation is ready.

### Packaging and platform gates

- Package preparation includes the complete contained-computer context on Windows, macOS, and Linux.
- The packaged bootstrap contract contains no Bash requirement.
- Windows CI is authoritative for Windows compilation and package-contract coverage.
- macOS and Linux run their corresponding compile, test, and package-contract gates.
- Before release, perform a fresh-install smoke test on each platform: install prerequisites after Homun is already open, recheck without restarting, prepare `homun-cc`, and verify CDP/noVNC readiness.

## Acceptance criteria

- A user can install Docker and Ollama while the prerequisite screen is open and continue without restarting Homun.
- The new preparation step clearly explains Homun Computer and shows real progress.
- `homun-cc` is running with healthy CDP and noVNC before the normal onboarding path reaches model selection.
- Preparation works through the same product flow on Windows, macOS, and Linux.
- Windows requires neither Bash nor WSL.
- Retrying a failed preparation does not create concurrent builds or duplicate containers.
- Existing healthy containers are reused immediately.
- Errors are visible and actionable.
