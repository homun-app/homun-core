# Homun

**Your personal AI assistant. Single binary. Privacy-first. Local-first. Multi-channel.**

Homun is a digital homunculus that lives on your machine and works 24/7. Manage it from Telegram, WhatsApp, Discord, Slack, Email, a Web dashboard, or the CLI. It learns from you, runs automations while you sleep, browses the web, and extends via the open Agent Skills ecosystem.

> Version **1.0.1** — first production release · [Changelog](./CHANGELOG.md) · [homun.app](https://homun.app)

---

## Quick install

### macOS

Download the latest `.dmg` from [GitHub Releases](https://github.com/homun-app/homun/releases/latest), drag `Homun.app` onto `Applications`, launch. The web dashboard opens at `https://localhost:18443`.

Or via **Homebrew**:

```bash
brew install homun-app/tap/homun
homun gateway
```

### Linux (Debian / Ubuntu)

```bash
curl -LO https://github.com/homun-app/homun/releases/latest/download/homun_1.0.0-1_amd64.deb
sudo apt install ./homun_1.0.0-1_amd64.deb

# Start as the dedicated homun user (or install the systemd unit)
sudo -u homun homun gateway &
```

Arm64 also available — substitute `amd64` with `arm64` in the URL.

### Linux (Fedora / RHEL / Rocky)

```bash
sudo dnf install https://github.com/homun-app/homun/releases/latest/download/homun-1.0.0-1.x86_64.rpm
sudo -u homun homun gateway &
```

### Windows (via WSL2)

Windows is supported via Windows Subsystem for Linux 2. Full walkthrough in **[docs/INSTALL-WINDOWS-WSL.md](./docs/INSTALL-WINDOWS-WSL.md)** (~15 minutes). You get the same Linux `.deb` package running inside a WSL Ubuntu distro.

> A native Windows `.msi` installer is not provided in v1.0 — see [`#67`](./docs/REALITY-AUDIT.md) for the cost-driven rescope.

Once installed, open **https://localhost:18443** in your browser and complete the setup wizard.

---

## What you get

- **Multi-channel** — 7 channels: CLI, Telegram, WhatsApp, Discord, Slack, Email, Web WebSocket.
- **14+ LLM providers** — Anthropic, OpenAI, Ollama (local), OpenRouter, DeepSeek, Groq, Gemini, Mistral, Together, Fireworks, and more.
- **Long-term memory** — short-term session + long-term LLM-consolidated summaries, hybrid HNSW + FTS5 + RRF search.
- **Knowledge base (RAG)** — ingest 30+ formats (PDF, DOCX, XLSX, markdown, code, …) with vault-gating for sensitive data.
- **23+ built-in tools** — shell, files, web search, browser automation, vault, email, scheduling, workflows, contacts.
- **Automations** — visual flow builder (n8n-style SVG canvas), NLP flow generation, resume-on-boot.
- **Workflow engine** — persistent multi-step workflows with approval gates and retry logic.
- **Browser automation** — Playwright-powered headless browser, stealth injection, 21 unified actions.
- **Skills ecosystem** — open Agent Skills standard, GitHub install, ClawHub marketplace, LLM-driven skill generation.
- **MCP integration** — connect external services (Google Workspace, GitHub, …) via Model Context Protocol, with OAuth and vault-resolved credentials.
- **Security** — AES-256-GCM vault, OS keychain master key, PBKDF2 600k auth, 2FA TOTP, sandboxed execution (5 backends), exfiltration guard, emergency kill switch.
- **Mobile app** — Flutter thread-first UX with inline approval/result blocks, biometric lock, cross-stack fixture contract. See [`homun-app/homun-mobile`](https://github.com/homun-app/homun-mobile).
- **Observability** — `/metrics` Prometheus endpoint, end-to-end X-Request-ID tracing, panic handler with redacted crash reports, 4-channel consensual submission (clipboard / download / GitHub issue / mailto), daily update checker.
- **Web dashboard** — 29 pages: chat, automations, workflows, skills, mcp, agents, contacts, profiles, memory, knowledge, vault, sandbox, approvals, logs, traces, and more.

---

## Configuration

Homun stores all data in `~/.homun/` (or `/var/lib/homun/.homun/` for the systemd service on Linux). Configuration lives in `~/.homun/config.toml`.

The fastest way to configure is through the **web setup wizard** that launches on first boot. You can also edit the config directly:

```toml
[agent]
model = "anthropic/claude-sonnet-4-20250514"
fallback_models = ["openai/gpt-4o-mini", "ollama/qwen3:latest"]

[providers.anthropic]
api_key = "sk-ant-..."

[channels.telegram]
enabled = true
token = "123456:ABC..."
```

At minimum, you need **one LLM provider API key** (or Ollama running locally).

---

## CLI commands

```
homun                    # Interactive chat (default)
homun chat               # Interactive chat
homun chat -m "message"  # One-shot message
homun gateway            # Start gateway (channels + cron + heartbeat + web UI)
homun config             # Initialize or edit configuration
homun status             # Show system status
homun skills list        # List installed skills
homun skills add owner/repo  # Install skill from GitHub
homun cron list          # List scheduled jobs
homun service install    # Install as OS service (launchd / systemd)
```

---

## Documentation

- **[Getting Started](./docs/GETTING-STARTED.md)** — step-by-step from install to first automation
- **[Changelog](./CHANGELOG.md)** — all notable changes
- **[Contributing](./CONTRIBUTING.md)** — how to report bugs and propose features
- **[Windows via WSL2](./docs/INSTALL-WINDOWS-WSL.md)** — full install walkthrough for Windows 11 users
- **[homun.app](https://homun.app)** — project website with screenshots, guides, and community
- **Source code** — lives in the private `homun-app/homun-core` repository under the [PolyForm Noncommercial License](./LICENSE). Security audit access available on request (see [Contributing](./CONTRIBUTING.md)).

---

## Advanced installation

### Docker

If you already run a self-host stack with Docker, you can use the containerized build. Not the default happy path for v1.0 — the native installers above are recommended — but fully supported.

```bash
git clone https://github.com/homun-app/homun.git
cd homun
cp .env.example .env
docker compose up -d
```

Open **https://localhost** (note: HTTPS with self-signed cert inside Docker).

Add Ollama for free local embeddings:

```bash
docker compose --profile with-ollama up -d
```

### Build from source

Requires Rust 1.85+ and Node.js (for browser automation via MCP Playwright). The source tree is the private `homun-app/homun-core` repository — contact the maintainer for access if you need to build locally.

```bash
git clone https://github.com/homun-app/homun-core.git  # requires access
cd homun-core
cargo install --path . --features full
homun config        # Initialize configuration
homun gateway       # Start all services + web UI
```

### Build profiles

| Profile | Command | What you get |
|---------|---------|-------------|
| Default | `cargo install --path .` | CLI + Web UI + core tools + vault + MCP + browser |
| Gateway | `--features gateway` | + multi-channel + local embeddings/RAG + email |
| Full | `--features full` | + browser automation + vault 2FA |

---

## Requirements

| Dependency | Required for | Notes |
|-----------|-------------|-------|
| Linux / macOS / Windows 11 + WSL2 | Binary installs | Native `.deb` / `.rpm` / `.dmg` / WSL2 walkthrough |
| Node.js / `npx` | Browser automation | Optional — only if you enable browser tools |
| Ollama | Local LLMs and embeddings | Optional — for fully offline operation |
| Rust 1.85+ | Build from source | Optional — installers already ship a compiled binary |

---

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE) — free for personal and noncommercial use.

Homun is **source-private, user-visible**: you can run, configure, inspect data, and submit issues, but the Rust source code lives in a private repository under a noncommercial license. If you need audit access for security research, email `security@homun.app` with the reason.
