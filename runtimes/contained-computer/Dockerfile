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
      # Timezone database (Layer D, defensive): bookworm-slim happens to ship
      # zoneinfo today, but pin tzdata so a future base-image slimming can't
      # silently revert the container to UTC. The ESSENTIAL part is `-e TZ=...`
      # in up.sh — without it the container is UTC (host-2h here), so `date`,
      # Python and Chromium would pick the wrong day near midnight.
      tzdata \
      # Skill execution toolchain (same contained computer doubles as the skill
      # sandbox): a real shell needs curl/python/git/jq for SKILL.md scripts.
      bash \
      curl \
      jq \
      git \
      python3 \
      python3-pip \
      python3-venv \
      # On-device speech-to-text (dictation): faster-whisper decodes audio via
      # ffmpeg and runs on CPU, identically on every OS.
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# faster-whisper (CTranslate2 — no torch) in an isolated venv: powers on-device,
# multilingual dictation. The model itself downloads at first use into ~/.cache
# (a persistent volume), not baked into the image.
RUN python3 -m venv /opt/whisper-venv \
    && /opt/whisper-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/whisper-venv/bin/pip install --no-cache-dir faster-whisper

# Deck renderer: turns a structured deck JSON into an on-brand HTML deck AND a NATIVE,
# EDITABLE .pptx (python-pptx — real text boxes, not screenshots). Used by the
# create-presentations skill, which writes deck.json then runs `deck-render deck.json`.
RUN python3 -m venv /opt/deck-venv \
    && /opt/deck-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/deck-venv/bin/pip install --no-cache-dir python-pptx
COPY deck_render.py /opt/deck/deck_render.py
RUN printf '#!/bin/sh\nexec /opt/deck-venv/bin/python /opt/deck/deck_render.py "$@"\n' \
      > /usr/local/bin/deck-render \
    && chmod +x /usr/local/bin/deck-render

# Non-root runtime user; the container boundary is the sandbox (ADR 0010).
# `.cache` is pre-created and owned by agent so a named volume mounted there
# inherits agent ownership on first init (persists the Whisper model download).
RUN useradd --create-home --shell /bin/bash agent \
    && mkdir -p "${PROFILE_DIR}" /home/agent/.cache /home/agent/output \
    && chown -R agent:agent /data /home/agent/.cache /home/agent/output

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY whisper_server.py /usr/local/bin/whisper_server.py
# Chrome-free noVNC embed page used by the in-app "Computer" panel: scales the
# whole framebuffer to fit (proportioned), no toolbar/status bar.
COPY novnc-view.html /usr/share/novnc/lfpa-view.html
RUN chmod +x /usr/local/bin/entrypoint.sh

USER agent
WORKDIR /home/agent

# CDP (automation, attach from the host sidecar via connectOverCDP) + noVNC (live
# view streamed into the chat). Publish both to 127.0.0.1 only when running.
EXPOSE 9222 6080

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
