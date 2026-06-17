# Homun

**A local-first, proactive personal assistant** for macOS, Windows and Linux.

Homun isn't a passive chat box. It watches the work you point it at, builds a
verifiable memory, drafts replies across your messaging channels, and can operate a
real computer on your behalf — under permissions you grant step by step. Your data
and your models stay on your machine by default; the cloud is opt-in.

> 📚 **Full documentation: [docs.homun.app](https://docs.homun.app)** — start with the
> [Getting started](https://docs.homun.app/guides/getting-started/) guide.

---

## What it does

- **Operative chat** — Markdown, syntax-highlighted code, diagrams, attachments/vision,
  message editing and branching.
- **A contained local computer** — a real, headed browser and shell in a sandboxed
  Docker container you watch live over noVNC and can take over anytime.
  ([guide](https://docs.homun.app/guides/local-computer/))
- **Hybrid memory** — SQLite + a knowledge graph (entities, relations, decisions), a
  generated Markdown wiki, curated contacts, and per-topic *forget*.
  ([guide](https://docs.homun.app/guides/memory/))
- **Channels** — WhatsApp and Telegram flow inbound into memory and drafts, with an
  allowlist + approval gate before anything is sent.
  ([guide](https://docs.homun.app/guides/channels/))
- **Automations** — a *When → Then* model: a time or event trigger runs an agentic
  action. ([guide](https://docs.homun.app/guides/automations/))
- **Connectors & skills** — native tools, MCP servers, and opt-in managed providers,
  routed by a capability router; plus installable, sandboxed skills.
  ([connectors](https://docs.homun.app/guides/connectors/) ·
  [skills](https://docs.homun.app/guides/skills/))
- **Bring your own model** — local Ollama or any of a dozen cloud providers (OpenAI,
  Anthropic, and OpenAI-compatible endpoints), enabled per provider and routed per
  task. ([guide](https://docs.homun.app/guides/models/))
- **Proactivity** — a supervisor that surfaces timely suggestions instead of waiting
  to be asked.

Local-first and deny-by-default are deliberate
[security](https://docs.homun.app/guides/security/) choices.

## How it's built

A Rust gateway orchestrates everything; an Electron + React desktop app is the UI;
standalone sidecars handle the heavier or isolated jobs.

| Path | What it is |
| --- | --- |
| `apps/desktop` | Electron + React desktop app (the UI) |
| `crates/desktop-gateway` | the Rust gateway — agent loop, routing, task runtime, APIs |
| `crates/*` | memory, inference, orchestrator, skills, secrets, capabilities, … |
| `runtimes/contained-computer` | the sandboxed Docker computer (browser + shell over CDP/noVNC) |
| `runtimes/browser-automation` | the Playwright/CDP browser driver |
| `runtimes/channel-telegram`, `channel-whatsapp` | the messaging bridges |

See [PROJECT.md](PROJECT.md) for the founding document, architecture and roadmap, and
the [architecture reference](https://docs.homun.app/reference/architecture/) for the
component map.

## Install

Grab a signed build for your platform from the
[**Download**](https://docs.homun.app/guides/download/) page (releases are published to
[homun-releases](https://github.com/homun-app/homun-releases)). Self-hosting the server
build is covered in [Self-hosting](https://docs.homun.app/guides/self-hosting/).

## Develop

You'll need Node and a Rust toolchain (the gateway builds its own native binary).

```bash
# desktop UI (apps/desktop)
npm install
npm run dev            # Vite dev server
npm run electron:dev   # the Electron app against the dev server

# build a distributable
npm run dist

# tests (from the repo root)
make test              # Rust + browser-automation suites
```

The full local + server setup, including the contained computer's Docker requirements,
is documented under [Self-hosting](https://docs.homun.app/guides/self-hosting/).

## License

[Functional Source License v1.1](LICENSE.md) (FSL-1.1), converting to Apache 2.0 over
time. See [LICENSE.md](LICENSE.md) for the full terms.
