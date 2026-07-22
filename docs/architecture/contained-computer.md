# Contained Computer bootstrap

Homun Computer is the isolated Docker environment used for real-browser work,
tools, skills, and generated artifacts. First-run onboarding prepares it before
the user selects an AI model, using the same flow on Windows, macOS, and Linux.

## Setup API

The desktop renderer starts preparation with:

- `POST /api/setup/computer/prepare` — starts or joins the current preparation;
- `GET /api/setup/computer/status` — returns the latest observed phase.

Both endpoints return `phase`, `ready`, and a safe optional `error`. The stable
phases are `idle`, `checking_docker`, `preparing_image`, `starting_container`,
`verifying_browser`, `ready`, and `failed`. A coordinator permits only one active
bootstrap. A failed attempt can be retried without restarting Homun, and a late
result from an older attempt cannot replace the current state.

The onboarding Continue action is enabled only when the gateway reports both
`phase: ready` and `ready: true`; the renderer never infers readiness from elapsed
time or Docker presence alone.

## Native lifecycle

The gateway performs the lifecycle directly through the Docker CLI:

1. resolve Docker again on every check and start its engine when needed;
2. hash the packaged build inputs and compare the `homun.cc_hash` image label;
3. build `homun-contained-computer:local` when the definition is stale;
4. recreate and start `homun-cc` with the required ports, volumes, timezone,
   network, shared memory, and temporary filesystem;
5. wait for the container, then verify Chrome CDP on port 9222 and noVNC on port
   6080 before reporting ready.

This path does not invoke Bash. `runtimes/contained-computer/up.sh` remains a
developer helper and a backwards-compatible build-context locator, not a packaged
runtime dependency.

## Cross-platform discovery

Docker lookup is evaluated for each request so installing Docker while Homun is
open is immediately observable:

- Windows checks the effective `ProgramFiles` Docker Desktop location and the
  standard `C:\Program Files` location in addition to `PATH`;
- macOS checks Docker Desktop, Homebrew, `/usr/local`, and the user's Docker CLI
  directory;
- Linux checks the standard system locations and the user's Docker CLI directory.

The host data directory resolves `HOME` first and `USERPROFILE` second, allowing
normal Windows installations to create artifact and persistent browser-profile
mounts without Unix environment assumptions.

## Packaging contract

`apps/desktop/scripts/prepare-package.mjs` copies the complete
`runtimes/contained-computer` directory into Electron resources on every platform.
Electron supplies that location to the gateway. The context must include the
Dockerfile, entrypoint, rendering utilities, noVNC page, Whisper service, and font
assets used by the native content hash.

Release verification must include cross-platform compilation and a physical fresh
install. On first run, installing Docker or Ollama and returning to Homun must work
through **Check again** without an app restart; preparation must create `homun-cc`,
and only successful CDP plus noVNC checks may unlock model selection.
