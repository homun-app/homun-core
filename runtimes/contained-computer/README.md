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

- **Not yet built/run**: authored while the Docker daemon was down. Run `./up.sh`
  to build + validate on a machine with Docker started.
- **CDP host rewrite**: when attaching from the host via the published port,
  Playwright reads `/json/version`; if the returned `webSocketDebuggerUrl` carries
  the container's internal host, attach may need the host rewritten to
  `127.0.0.1:9222`. Verify during `up.sh` integration testing.
- **Distribution**: Docker is the dev backend; shipping to end users may instead
  bundle a VM (Apple Virtualization.framework / Lima). The image contents here are
  portable across backends. Open decision in ADR 0010.
- **Security**: CDP grants full browser control — publish to `127.0.0.1` only;
  `--no-sandbox` is acceptable only because the container is the isolation
  boundary.
