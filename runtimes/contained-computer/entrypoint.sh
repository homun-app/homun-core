#!/usr/bin/env bash
# Brings up the contained computer (ADR 0010):
#   Xvfb (virtual display) → fluxbox (WM) → x11vnc (export display) →
#   noVNC/websockify (stream over WS) → real headed Chromium with CDP open.
# The agent attaches over CDP (port 9222); the user watches over noVNC (6080).
set -euo pipefail

GEO="${SCREEN_GEOMETRY:-1280x800}"
DISP="${DISPLAY:-:99}"

log() { echo "[contained-computer] $*"; }

# 1) Virtual framebuffer — the "screen" the real browser renders into.
log "starting Xvfb on ${DISP} (${GEO}x24)"
Xvfb "${DISP}" -screen 0 "${GEO}x24" -nolisten tcp &
XVFB_PID=$!

# Wait for the display to be ready before launching X clients.
for _ in $(seq 1 50); do
  if xdpyinfo -display "${DISP}" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

# 2) Minimal window manager so the browser window behaves normally.
log "starting fluxbox"
fluxbox >/dev/null 2>&1 &

# 3) Export the display over VNC, then bridge VNC→WebSocket for noVNC.
log "starting x11vnc on :${VNC_PORT}"
x11vnc -display "${DISP}" -forever -shared -nopw -rfbport "${VNC_PORT}" -quiet >/dev/null 2>&1 &

log "starting noVNC/websockify on :${NOVNC_PORT}"
websockify --web=/usr/share/novnc "${NOVNC_PORT}" "localhost:${VNC_PORT}" >/dev/null 2>&1 &

# 4) The REAL, headed browser. No --headless. --no-sandbox is safe here because
#    the container IS the sandbox (ADR 0010). CDP is bound to all interfaces so
#    the host sidecar can attach via the published port.
log "launching headed Chromium with CDP on :${CDP_PORT}"
exec chromium \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --disable-gpu \
  --disable-dev-shm-usage \
  --user-data-dir="${PROFILE_DIR}" \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port="${CDP_PORT}" \
  --window-position=0,0 \
  --window-size="${GEO/x/,}" \
  --start-maximized \
  about:blank
