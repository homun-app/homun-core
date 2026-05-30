# Contained, in-chat-visible browser (OpenClaw vs Manus → our plan)

Date: 2026-05-30

## Why

User feedback: the automated browser "opens and takes over the screen" — it
launches a real OS window that steals focus. Desired: the browser runs inside a
contained "computer" and is **visible as a window inside the chat**, like Manus.

## References

- **OpenClaw** (MIT, our browser-automation reference): a protocol-level browser
  CONTROL layer — CDP + Playwright, aria-ref snapshots, atomic actions,
  observe→act loop, three modes (managed / Chrome-extension relay / remote CDP).
  We already ported its *automation contract* (`browser_loop_controller.rs`,
  `runtimes/browser-automation`). It is the right reference for *how to drive* a
  browser, not for *where it runs or how it's shown*.
- **Manus**: each task gets an isolated cloud microVM (E2B/Firecracker) with a
  REAL Chromium (not headless) driven by Playwright inside it; the VM screen is
  **streamed into the web UI** ("Manus's Computer" panel). Contained + live-visible.

## Current state (evidence)

| Aspect | Before this work | Evidence |
|---|---|---|
| Default visibility | **Visible** → focus-stealing OS window | `main.rs` `browser_headless_env_value` → "0" |
| Browser/profile | Dedicated Chromium + dedicated temp profile (not the user's Chrome) | `profiles.ts`, `session_manager.ts` |
| Containment | Runs on the host; no sandbox/VM | — |
| In-chat visibility | Only sparse screenshot artifacts shown as a card; no live stream | `ChatView.tsx`, `local_computer_artifact_preview` |
| `local-computer-session` | Models surfaces (Browser/Shell/Files/Logs) + takeover + artifacts, but is a passive LOG, not a live surface | `crates/local-computer-session` |

Key realization: `local-computer-session` already models the right abstraction
(a Manus-style multi-surface computer). The work is to make it **live**, not to
invent new architecture.

## Gap

- vs OpenClaw: minor (missing extension/remote-CDP "drive my own browser" modes).
- vs Manus: (1) wrong default (focus-stealing window), (2) no live in-chat view
  (only screenshots), (3) no real containment (runs on host).

## Plan

### Phase 1 — local-first, no VM; fixes the complaint
1. **Headless by default** — DONE (this commit). No focus-stealing window;
   self-heal `restartAssistantVisible` still recovers hard sites (window only as
   last resort). `LOCAL_FIRST_BROWSER_HEADLESS=0` overrides.
2. **Per-iteration frame capture** — STAGED. Capture a screenshot artifact each
   loop iteration (best-effort, must not slow/destabilize the validated loop) so
   the EXISTING in-chat computer card updates live. Backend-only, but needs a
   running browser + unlocked screen to observe latency/stability.
3. **CDP screencast + input forwarding** — STAGED. Replace polled screenshots
   with `Page.startScreencast` frames pushed to the UI (SSE), and reinject
   click/scroll/type from the embedded panel via CDP for in-chat takeover. Needs
   a streaming channel from sidecar→gateway→UI and visual verification.

### Phase 2 — true "computer" (opt-in, later)
A contained local desktop (browser + shell + files in one streamed surface) via
a Linux microVM/container with Xvfb + window manager + VNC/noVNC embedded in the
UI. Heavier; needs virtualization (on macOS: Lima/container), in tension with the
no-Docker stance of ADR 0009 — so keep it opt-in, not default. This is the full
Manus-style "Computer" panel, on-device.

## Status

- Phase 1.1 (headless default): DONE as INTERIM, `cargo 76 bin / 24 lib` green.

## UPDATE (2026-05-30): user chose the Manus model — VM promoted to primary

User feedback: **headless gets blocked by bot-detection on many sites**, and a
headed browser on the host is invasive. So neither on-host mode is acceptable —
go with Manus: a **real headed browser inside a contained virtual computer**,
streamed to the chat, which also runs scripts. This promotes "Phase 2" to the
primary direction and revises ADR 0009 → see **ADR 0010**.

Environment grounded: macOS 26.5 arm64; **Docker CLI present but daemon was down**
(can't run the spike now); no Lima/Colima/Podman. Apple `Virtualization.framework`
available for a future bundled VM.

Key low-cost insight: our sidecar already attaches to an external browser via
`connectOverCDP(BROWSER_AUTOMATION_USER_CDP_ENDPOINT)` (`session_manager.ts:482`),
so the OpenClaw automation port drives an in-container Chromium **unchanged**.

Spike authored (NOT yet built — daemon down): `runtimes/contained-computer/`
(Dockerfile + entrypoint + `up.sh`): Xvfb → fluxbox → x11vnc → noVNC + real headed
Chromium with CDP. `up.sh` validates CDP + noVNC reachability headlessly.

### Revised plan
1. **Bring up + validate the contained computer** — DONE & VALIDATED (2026-05-30,
   Docker 29.4.3, arm64): `./up.sh` builds + runs; CDP reachable (real headed
   Chrome/148 on X11), noVNC serveable. End-to-end probe via the sidecar's own
   `connectOverCDP` attached, navigated example.com, and confirmed
   `navigator.webdriver === false` (NOT flagged headless — the bot-detection win).
   Fixed a CDP-binding gotcha with a socat bridge (Chromium ignores
   `--remote-debugging-address`; binds loopback only).
2. **Wire the gateway** — DONE & VALIDATED. `LOCAL_FIRST_CONTAINED_COMPUTER=1`
   (or `LOCAL_FIRST_CONTAINED_COMPUTER_CDP=<url>`) makes every browser-sidecar
   spawn carry `BROWSER_AUTOMATION_USER_CDP_ENDPOINT`; the sidecar then attaches
   via CDP by default (single switch). Shared `browser_sidecar_env` so no spawn
   path is missed. End-to-end probe drove the sidecar (start→open→snapshot)
   against the container: start picked profile "user", opened example.com, and
   the OpenClaw snapshot observed the real page. Remaining: the full Brain→loop
   run + observing it needs the app + a screen.
3. **Embed the live view**: noVNC client in the chat computer panel + input
   forwarding for takeover. (Needs unlocked screen for visual verification.)
4. **Shell/Files surfaces** in the same container → `local-computer-session`
   becomes a live multi-surface computer.
5. **Distribution decision** (ADR 0010 open question): Docker vs bundled
   Apple-vz/Lima VM for end users. Container contents are portable either way.

Steps needing the screen / a running Docker daemon are blocked until the user is
back; design + spike artifacts are done so the build is unblocked the moment they
are available.
