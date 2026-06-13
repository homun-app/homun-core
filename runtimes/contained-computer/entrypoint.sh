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
#    the container IS the sandbox (ADR 0010).
#
#    NOTE: modern Chromium IGNORES --remote-debugging-address and always binds
#    CDP to 127.0.0.1 (loopback) for security. Docker's published port forwards
#    to the container's eth0, NOT its loopback, so the host can't reach CDP
#    directly. We therefore run Chromium's CDP on loopback and bridge it to the
#    container's external IP with socat (step 5), which the published port hits.
log "launching headed Chromium with CDP on 127.0.0.1:${CDP_PORT}"
chromium \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --disable-gpu \
  --disable-dev-shm-usage \
  --user-data-dir="${PROFILE_DIR}" \
  --remote-debugging-port="${CDP_PORT}" \
  --window-position=0,0 \
  --window-size="${GEO/x/,}" \
  --start-maximized \
  --disable-blink-features=AutomationControlled \
  --lang="${CHROME_LANG:-it-IT}" \
  about:blank &
CHROMIUM_PID=$!

# 5) Wait for Chromium's CDP to come up on loopback, then expose it on the
#    container's external IP so the published port reaches it. Bind to the
#    container IP (not 0.0.0.0) to avoid colliding with Chromium's 127.0.0.1.
log "waiting for CDP on 127.0.0.1:${CDP_PORT}"
for _ in $(seq 1 150); do
  if (echo > "/dev/tcp/127.0.0.1/${CDP_PORT}") 2>/dev/null; then break; fi
  sleep 0.2
done
CONTAINER_IP="$(hostname -I | awk '{print $1}')"
log "bridging ${CONTAINER_IP}:${CDP_PORT} -> 127.0.0.1:${CDP_PORT} (socat)"
socat "TCP-LISTEN:${CDP_PORT},fork,reuseaddr,bind=${CONTAINER_IP}" "TCP:127.0.0.1:${CDP_PORT}" &

# 6) On-device speech-to-text server (faster-whisper), best-effort. Binds 0.0.0.0
#    so the published port reaches it; the model loads lazily on first use and
#    stays warm afterward. Never fails the container if absent.
if [ -x /opt/whisper-venv/bin/python ]; then
  log "starting whisper STT server on :${HOMUN_WHISPER_PORT:-9000}"
  HOME=/home/agent /opt/whisper-venv/bin/python /usr/local/bin/whisper_server.py \
    >/tmp/whisper.log 2>&1 &
fi

# Tie the container lifecycle to the browser: exit when Chromium exits.
wait "${CHROMIUM_PID}"
