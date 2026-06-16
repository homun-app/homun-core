# Self-hosting Homun (any PaaS)

Homun ships as a **single 12-factor container** so it runs identically on any
self-hosted PaaS — Coolify, Dokku, CapRover, Kamal, or plain `docker compose`.
We target the standard container contract, not a specific PaaS.

## The contract (why it's portable)

| Requirement | How Homun meets it |
|---|---|
| One OCI image | [`Dockerfile`](../Dockerfile) (multi-stage: Rust gateway + web build → slim runtime) |
| Listen on `0.0.0.0:$PORT` | `HOMUN_DESKTOP_GATEWAY_HOST` (default `0.0.0.0` in the image) + `HOMUN_DESKTOP_GATEWAY_PORT` / `PORT` |
| All config via env | see the table below |
| State in one mounted dir | `HOMUN_DATA_DIR` (default `/data`) → every store (SQLite + files) lives here |
| Health check | `GET /api/health` (no auth) |
| Logs to stdout | yes |
| One deployable unit | the gateway serves the **web UI and the API on the same port** (`HOMUN_WEB_DIR`) |
| Optional features degrade | no Docker socket → the "contained computer" stays off; the app still runs |

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `HOMUN_DESKTOP_GATEWAY_HOST` | `0.0.0.0` (image) | bind address; `127.0.0.1` for desktop |
| `HOMUN_DESKTOP_GATEWAY_PORT` / `PORT` | `18765` | listen port (PaaS usually injects `PORT`) |
| `HOMUN_DATA_DIR` | `/data` (image) | all persistent state — **mount a volume here** |
| `HOMUN_WEB_DIR` | `/app/web` (image) | built web UI to serve; unset on desktop (Electron serves it) |
| `HOMUN_DESKTOP_GATEWAY_TOKEN` | generated | bearer token the API requires (set it explicitly on a server) |
| inference / providers | — | provider keys / Ollama URL (e.g. `HOMUN_EMBED_BASE`) — all via env |

## Quick start (docker compose)

```bash
echo "HOMUN_DESKTOP_GATEWAY_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build
# UI + API on http://<host>:18765 ; data persists in the `homun-data` volume.
```

## Per-PaaS cheatsheet

All of them do the same three things: **build the Dockerfile**, **set the env vars**,
**mount a volume at `HOMUN_DATA_DIR`**, and route a domain to port `18765`.

- **Coolify** — New Resource → *Dockerfile* (or *Docker Compose*) from this repo.
  Set the domain (TLS is automatic via Traefik). Add a **Persistent Storage** mount at
  `/data`. Set the env vars. To gate the public domain, add Traefik **Basic Auth**
  (see "Access / auth" below).
- **Dokku** — `dokku git:from-image` or push the repo with the `Dockerfile` builder;
  `dokku storage:mount homun /var/lib/dokku/data/storage/homun:/data`; `dokku config:set`
  the env; `dokku ports:set homun http:80:18765`; `dokku letsencrypt:enable`.
- **CapRover** — a `captain-definition` pointing at `./Dockerfile`; add a **Persistent
  Directory** at `/data`; set env vars; enable HTTPS for the app domain.
- **Kamal** — `image` built from the `Dockerfile`; a `volume` mapping host dir → `/data`;
  `env` for the vars; Kamal's proxy handles TLS.

## Access / auth (read this)

The web build ships a **login gate**: the bearer token is **not** baked into the bundle.
On first load you enter the `HOMUN_DESKTOP_GATEWAY_TOKEN` value; it's validated against
the gateway and stored in your browser (localStorage), so the JS bundle stays token-free.

Still recommended for a single-user host — add a **first layer** in front:

- Put the app on a **private network** (Tailscale / WireGuard), or
- Add **basic auth / an OAuth proxy** at the PaaS reverse proxy (Traefik/Caddy/nginx).

The login token is then the second layer.

## Inference

Runs entirely off env: point at **cloud provider APIs** (keys) or a self-hosted
**Ollama** (`HOMUN_EMBED_BASE` and the provider URL). On a small VM, cloud APIs are
the lighter choice; Ollama needs real RAM/GPU.

## The "contained computer" (browser / sandbox) — optional, needs Docker

The agent's browser/shell runs as a **sibling Docker container**. The image bundles its
build context (`/app/contained-computer`, `HOMUN_CONTAINED_COMPUTER_UP`), so the gateway
builds + runs it on the host daemon via a mounted socket — nothing to pre-provision.

To enable it (in `docker-compose.yml`, or the equivalent on your PaaS):

1. Mount the host Docker socket (privileged — the container can control the host's Docker;
   only on a box you own):
   ```yaml
   volumes:
     - /var/run/docker.sock:/var/run/docker.sock
   ```
2. Uncomment the contained-computer env block so the gateway runs the sibling on the shared
   `homun-net` network and reaches it **by name**:
   ```yaml
   HOMUN_CC_NETWORK: "homun-net"
   HOMUN_CC_VALIDATE_HOST: "homun-cc"
   HOMUN_CONTAINED_COMPUTER_CDP: "http://homun-cc:9222"
   HOMUN_CONTAINED_COMPUTER_NOVNC: "http://homun-cc:6080/vnc.html"
   HOMUN_WHISPER_URL: "http://homun-cc:9100"
   ```

Without the socket the gateway detects Docker is absent and the feature stays off; the rest
of the app works.

> **Remaining piece — the live view.** With the above, the agent can fully **drive** the
> browser (CDP is reached internally over `homun-net`). But the in-chat **live noVNC view**
> points at `homun-cc:6080`, which is internal — a remote browser can't load it yet. To
> *watch* the session on the web you must expose noVNC (a second subdomain, or a reverse-proxy
> route, to `homun-cc:6080`). That UX wiring is the open follow-up.

## Updates (one-click redeploy)

A container can't replace its own image from the inside — pulling the new image and
recreating the container is the orchestrator's job. So set `HOMUN_UPDATE_WEBHOOK` to your
PaaS **redeploy webhook** and the app's **Notifications** view (the sidebar bell) shows a
one-click **Update** that POSTs it:

- **Coolify**: the resource has a *Webhooks → Deploy* URL (`.../api/v1/deploy?uuid=...`).
  Paste it into `HOMUN_UPDATE_WEBHOOK`. Clicking Update redeploys (pulls `:latest`).
- Any PaaS with a deploy webhook works the same way.

The webhook URL stays server-side (the gateway calls it; it never reaches the browser).
The image auto-rebuilds on GHCR on every `main` push, so "Update" always fetches the newest.

> Desktop builds update via electron-updater instead (in-app download + restart) — that
> path is separate from this webhook.

## Resource sizing

Gateway alone is light. With the contained computer (Chromium-in-Docker) budget
**≥ 4 GB RAM**; more if you also run Ollama.
