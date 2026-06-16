# syntax=docker/dockerfile:1
# Portable, 12-factor image for self-hosting Homun on ANY self-hosted PaaS
# (Coolify, Dokku, CapRover, Kamal, plain docker compose, …). One container that
# serves the web UI AND the API on a single port; all config via env; state in a
# mounted volume; honours $PORT; health at /api/health. See docs/self-host.md.

# --- Build the Rust gateway (release) ---
FROM rust:1-bookworm AS gateway
# Native deps for transitive openssl/native-tls in the gateway tree (mirrors CI).
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# BuildKit cache mounts keep the registry + target dir warm across rebuilds.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p local-first-desktop-gateway && \
    cp /src/target/release/local-first-desktop-gateway /usr/local/bin/homun-gateway

# --- Build the web frontend (same React app the desktop ships, served as a SPA) ---
FROM node:20-bookworm AS web
WORKDIR /app/desktop
COPY apps/desktop/package.json apps/desktop/package-lock.json ./
RUN npm ci
COPY apps/desktop/ ./
# Empty gateway URL => the SPA calls the API at its own origin (relative paths),
# so the same image works behind any domain without a rebuild. The bearer token
# is injected at build time (it ends up in the bundle — protect the deployment
# with the PaaS front gate / a private network; see docs/self-host.md).
ARG VITE_HOMUN_DESKTOP_GATEWAY_URL=""
ARG VITE_HOMUN_DESKTOP_GATEWAY_TOKEN=""
ENV VITE_HOMUN_DESKTOP_GATEWAY_URL=$VITE_HOMUN_DESKTOP_GATEWAY_URL \
    VITE_HOMUN_DESKTOP_GATEWAY_TOKEN=$VITE_HOMUN_DESKTOP_GATEWAY_TOKEN
RUN npm run build

# --- Runtime ---
FROM debian:bookworm-slim
# ca-certificates: outbound TLS to LLM providers/connectors. curl: healthcheck.
# docker-cli (optional): lets the bundled "contained computer" (browser/sandbox)
# drive sibling containers via a mounted /var/run/docker.sock. Harmless if no
# socket is mounted — the feature simply stays off (the gateway detects Docker).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl docker.io \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=gateway /usr/local/bin/homun-gateway /usr/local/bin/homun-gateway
COPY --from=web /app/desktop/dist /app/web

ENV HOMUN_DESKTOP_GATEWAY_HOST=0.0.0.0 \
    HOMUN_DESKTOP_GATEWAY_PORT=18765 \
    HOMUN_WEB_DIR=/app/web \
    HOMUN_DATA_DIR=/data
EXPOSE 18765
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${HOMUN_DESKTOP_GATEWAY_PORT}/api/health" || exit 1
CMD ["homun-gateway"]
