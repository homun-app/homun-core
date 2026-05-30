# Contained computer (ADR 0010)

A local, isolated Linux "computer" that runs a **real, headed Chromium on a
virtual display** — the Manus-style surface the agent uses. Real browser (passes
bot-detection), non-invasive (never opens a window on the host), viewable live in
the chat (noVNC), and a general compute sandbox (shell/scripts run inside it).

## Why

On-host browsing forces a bad choice: headless (blocked by bot-detection on many
sites) vs headed (steals the user's screen). Running a real headed browser inside
a contained virtual display removes the dilemma — see `docs/decisions/0010-*`.

## What's inside (`entrypoint.sh`)

```
Xvfb :99            virtual framebuffer — the "screen"
 └ fluxbox          minimal window manager
 └ x11vnc           exports the display over VNC (:5900)
    └ websockify    bridges VNC → WebSocket for noVNC (:6080)
 └ chromium         REAL headed browser into :99, CDP open on :9222
```

## Run + validate (needs Docker daemon running)

```sh
./up.sh
```
Validates headlessly that **CDP is reachable** (agent can drive the real browser)
and **noVNC is serveable** (the browser can be embedded in the chat). No screen
needed for this check.

## How it plugs into the app

- **Automation (no new code):** the browser sidecar already attaches to an
  external browser via CDP — `connectOverCDP(BROWSER_AUTOMATION_USER_CDP_ENDPOINT)`
  (`runtimes/browser-automation/src/browser/session_manager.ts:482`). Set
  `BROWSER_AUTOMATION_USER_CDP_ENDPOINT=http://127.0.0.1:9222` and the OpenClaw
  observe→act loop drives the in-container browser unchanged.
- **Visibility (new UI, staged):** embed the noVNC client (`http://127.0.0.1:6080/vnc.html`)
  in the chat's computer panel; add input forwarding for takeover.
- **Session model:** maps onto `crates/local-computer-session` surfaces
  (Browser/Shell/Files) — they become live, inside the container.

## Status / caveats

- **VALIDATED live (2026-05-30, macOS 26.5 arm64, Docker 29.4.3)**:
  - `./up.sh` → CDP up (`Chrome/148`, real headed on X11) + noVNC up.
  - End-to-end integration probe via `chromium.connectOverCDP("http://127.0.0.1:9222")`
    (the exact sidecar API): attached, navigated https://example.com, and read
    `navigator.webdriver === false` + no `Headless` UA marker — i.e. a REAL,
    non-flagged browser. This is the bot-detection win the headless path lacked.
- **CDP binding gotcha (fixed)**: modern Chromium IGNORES
  `--remote-debugging-address` and binds CDP to 127.0.0.1 only. Docker's published
  port forwards to the container's eth0, not loopback, so CDP was unreachable from
  the host. Fixed by bridging with `socat` bound to the container IP
  (`entrypoint.sh` step 5). The `webSocketDebuggerUrl` reports `127.0.0.1:9222`,
  which works because we publish to the host's `127.0.0.1:9222` (no rewrite needed).
- **Distribution**: Docker is the dev backend; shipping to end users may instead
  bundle a VM (Apple Virtualization.framework / Lima). The image contents here are
  portable across backends. Open decision in ADR 0010.
- **Security**: CDP grants full browser control — publish to `127.0.0.1` only;
  `--no-sandbox` is acceptable only because the container is the isolation
  boundary.
