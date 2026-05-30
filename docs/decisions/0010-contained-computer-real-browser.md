# Decision 0010: Contained computer with a REAL browser (revises 0009 containment)

Date: 2026-05-30

## Status

Accepted (direction). Supersedes the "no Docker / no VM, prefer headless" posture
of ADR 0009 for the browser + script-execution surface. Implemented in phases;
the spike artifacts live in `runtimes/contained-computer/`.

## Context

ADR 0009 chose "workspace as sandbox root, no Docker by default" and the browser
work defaulted toward headless. Field reality broke both assumptions:

- **Headless gets blocked.** Many real sites (the north-star Trenitalia/Italo
  among them) detect and block headless Chromium via bot-detection. Headless is
  not a viable default for an agent that must actually use the web.
- **Headed-on-host is invasive.** A real headed browser on the user's macOS
  desktop opens a window that steals focus and "takes over" — the exact behavior
  the user rejected.

So the two on-host options are each unacceptable: headless (blocked) vs headed
(invasive). The user explicitly asked for the **Manus model**: a *real* browser
(passes bot-detection) that is *non-invasive*, running inside a virtual computer
that also runs scripts/shell.

## Decision

Run the browser and script surfaces inside a **contained Linux computer** (a
local container/VM with a **virtual display**), not on the host:

- **Real, headed Chromium** rendered into a virtual framebuffer (Xvfb) inside the
  container. It is a real browser with a real display context → passes most
  bot-detection, exactly like Manus. It never opens a window on the host →
  non-invasive.
- **Automation reuses our existing port unchanged.** The container exposes CDP
  (`--remote-debugging-port`); the browser sidecar attaches via the EXISTING
  `connectOverCDP(BROWSER_AUTOMATION_USER_CDP_ENDPOINT)` path
  (`session_manager.ts:482`). The OpenClaw observe→act contract is untouched —
  it just drives the in-container browser.
- **Visible in the chat via streaming**, not a window. x11vnc + noVNC (websockify)
  serve the virtual display over HTTP/WS; the chat embeds the noVNC client (the
  Manus "Computer" panel), with input forwarding for takeover.
- **The container is the sandbox.** Scripts/shell run inside it (the
  `local-computer-session` Browser/Shell/Files surfaces become live, in the VM);
  the host filesystem/desktop is untouched. This REALIZES ADR 0009's containment
  goal with a real boundary instead of a process-level one.

### Virtualization backend

- **Now / dev**: Docker (the only runtime present on the dev machine; Docker on
  macOS already runs a Linux VM under the hood). The container CONTENTS (Xvfb +
  Chromium + x11vnc + noVNC + CDP) are the real artifact and are **portable**
  across backends.
- **Distribution (OPEN QUESTION)**: the product is downloadable/local-first, so
  requiring every end-user to install Docker Desktop is a heavy dependency. Options
  to decide later: bundle a lightweight VM via Apple `Virtualization.framework`
  (native on Apple silicon, no Docker) / Lima-Colima / ship the image and require
  a runtime. The Linux stack is identical regardless, so this choice does not
  block the spike.

## Consequences

- **Pro**: real browser (not blocked) + non-invasive (no host window) + true
  containment (host untouched) + a general compute sandbox (scripts) — the full
  Manus experience, on-device. Reuses our automation port and session model.
- **Con / cost**: a virtualization dependency (Docker now; a bundled VM later for
  distribution); container image weight (Chromium+X+VNC ≈ hundreds of MB); the
  streaming UI (noVNC embed + input forwarding) is new UI that needs visual
  verification.
- **Interim** (until this lands): browser defaults to headless (commit ac6b135)
  with the visible self-heal — least-invasive of the two bad on-host options.
  This ADR supersedes that interim.
- ADR 0009's destructive-action approval gate and "prefer remote/WASM" posture
  remain; the local-stdio-MCP OS sandbox is now subsumed by the container boundary
  for surfaces that run inside it.
