# Contained computer (ADR 0010): a real, headed Chromium on a virtual display,
# reachable for automation over CDP and viewable over noVNC — the Manus-style
# "computer" the agent uses, isolated from the host desktop.
#
# arm64 (Apple silicon) and amd64 both work: every package below is multi-arch.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN_GEOMETRY=1280x800 \
    CDP_PORT=9222 \
    VNC_PORT=5900 \
    NOVNC_PORT=6080 \
    PROFILE_DIR=/data/profile

# Real browser + virtual display + VNC bridge. `chromium` is the real browser
# (NOT headless): it renders into Xvfb, so it has a genuine display context and
# passes most bot-detection, while never opening a window on the host.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      x11-utils \
      x11vnc \
      fluxbox \
      novnc \
      websockify \
      socat \
      dumb-init \
      ca-certificates \
      fonts-liberation \
      procps \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user; the container boundary is the sandbox (ADR 0010).
RUN useradd --create-home --shell /bin/bash agent \
    && mkdir -p "${PROFILE_DIR}" \
    && chown -R agent:agent /data

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER agent
WORKDIR /home/agent

# CDP (automation, attach from the host sidecar via connectOverCDP) + noVNC (live
# view streamed into the chat). Publish both to 127.0.0.1 only when running.
EXPOSE 9222 6080

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
