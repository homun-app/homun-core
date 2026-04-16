# Changelog

All notable changes to Homun are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.1] — 2026-04-16

Security hotfix + health tracking fix. Shipped before public announcement.

### Fixed

- **#18 🔴 Security**: blocked path traversal in the `remember` tool's `site` parameter. A malicious domain like `../../etc/cron.d/evil` could write outside the `~/.homun/brain/sites/` directory. Two-layer fix: input validation (rejects `/`, `\`, `..`, empty) + defense-in-depth path sanitization via `Path::file_name()` stripping in `resolve_site_memory_path()`.
- **#26 🔴 Security**: enforced 100 MB file size limit on RAG ingestion. Previously, ingesting a very large file (e.g. 2 GB) would read it entirely into memory via `std::fs::read()`, causing OOM. Fix adds `MAX_INGEST_BYTES` guard in `ingest_file()` + `reingest_file()` (covers all 3 ingest paths: API upload, directory watcher, CLI), plus `DefaultBodyLimit` on the HTTP upload route.
- **#11 🔴 Functional**: added `ChannelHealthTracker` to the Slack channel. Previously Slack was the only channel without health monitoring — the circuit breaker was blind to Slack connection issues. Mirrors the Discord pattern: `record_message()` on successful inbound, `record_error()` on WebSocket disconnect, wired via `with_health()` builder in gateway.

### Changed

- Domain references corrected from `homun.dev` to `homun.app` across 14 files + release body + Homebrew formula (carried over from v1.0.0 post-tag fix).

[1.0.1]: https://github.com/homun-app/homun/releases/tag/v1.0.1

---

## [1.0.0] — 2026-04-15

First production release. Single-binary Rust personal AI assistant, privacy-first, local-first, multi-channel.

### Added

**Core architecture**
- Cognition-First ReAct loop: INGRESS → COGNITION → EXECUTION → POST-PROCESSING. A read-only mini-ReAct discovery phase (memory search, RAG search, tool/skill/MCP listing) analyzes intent **before** the main execution loop runs, so the LLM only sees the tools cognition selected.
- Selective tool loading: cognition chooses which tools enter the prompt, reducing context and improving precision.
- Iteration budget with cycle detection (periods 1, 2, 3), adaptive on cognition complexity.
- Orchestrator for intent classification → planning → execution → synthesis with pluggable agent definitions.
- `one_shot` unified engine for non-conversational LLM calls (automation generation, MCP setup, skill creation).
- `tokio::task_local!` trace-id propagation that survives thread migration (vs `thread_local`).

**Messaging & channels** (7 total)
- CLI (interactive REPL + one-shot), Telegram (Frankenstein long-polling), WhatsApp (wa-rs native, no Node.js), Discord (Serenity), Slack (Socket Mode + polling fallback), Email (IMAP IDLE + SMTP, vault-resolved credentials), Web (WebSocket streaming with delta/tool/block events).
- Gateway auth centralized in `agent/auth.rs`, all channels fail-closed. Pairing OTP for first-time contacts (6-digit, 5-min TTL, max 3 attempts).
- Debouncing window for batched rapid messages.
- Channel capability table + health tracker (opt-in, Discord fully adopted).

**Memory & knowledge**
- Short-term messages + long-term LLM-consolidated summaries.
- Hybrid vector search: **HNSW** (usearch) + **FTS5** + **RRF** fusion (k=60).
- `remember` tool writes to `~/.homun/brain/USER.md` (only-writer-wins pattern).
- Daily memory files under `~/.homun/memory/YYYY-MM-DD.md`.
- Temporal decay for memory ranking (half-life 30 days).

**RAG Knowledge Base**
- 30+ format ingestion: markdown, PDF, DOCX, XLSX, code, csv, json, html, org, etc.
- Directory watcher for auto-ingest.
- Sensitive data classification with vault-gating for PII/credentials before embedding.
- Cloud source integration via MCP.

**Skills ecosystem**
- Agent Skills standard compatible (SKILL.md with YAML frontmatter, progressive disclosure).
- 5 bundled skills + installation from GitHub (`homun skills add owner/repo`).
- Pre-install security scanning shield.
- ClawHub marketplace + Open Skills registry integration.
- LLM-driven skill creator.
- Directory hot-reload watcher.
- Runtime parity with OpenClaw: eligibility, invocation policy, tool restriction, env injection.

**MCP (Model Context Protocol) runtime**
- Persistent stdio and HTTP peers via `rmcp`.
- OAuth flow with state validation and token refresh.
- Registry with 7 curated presets and auto-setup flow.
- Vault-resolved credentials (`vault://key` placeholders).

**Tools** (23+ built-in)
- `shell`, `file`, `web` (search + fetch with browser auto-escalate), `message`, `approval`, `spawn`, `remember`, `vault`, `knowledge`, `automation`, `workflow`, `contacts`, `send_file`, `view_file`, `add_data`, `browser` (21 actions), `mcp`, `skill_create`, `email_inbox`, plus sandbox-wrapped dynamic tools.
- Unified **sandbox** with 5 backends: Docker, native/macOS, macOS Seatbelt, Linux Bubblewrap, Windows Job Objects — auto-detected per platform.

**Browser automation**
- Playwright-powered headless browser via persistent MCP peer.
- 21 unified browser actions, stealth anti-bot injection, compact tree-preserving snapshots, auto-snapshot after navigate/click/type.
- Per-site memory + tab session state tracking + action policy enforcement + CAPTCHA handling.

**Security**
- Vault: AES-256-GCM encryption, OS-keychain-backed master key, zeroized memory on drop.
- Web auth: PBKDF2 600k iterations, HMAC-signed session cookies, replay protection (IP + User-Agent binding).
- Rate limiting: auth 5/min, API 60/min, per-IP.
- 2FA via TOTP (RFC 6238) + 10 recovery codes.
- Emergency stop (E-Stop) via `/estop` from any authorized channel — kills agent loop, browser, MCP peers.
- Exfiltration guard: 18+ regex patterns (secrets, PII, tokens) with CRITICAL/HIGH/MEDIUM/LOW levels.
- Trusted devices, contact perimeter enforcement, vault leak detection, 2FA chain post-fix.

**Automations & scheduling**
- Cron scheduler (`tokio-cron-scheduler`) + `every`-interval triggers + event-driven triggers (always/on_change/contains).
- Visual flow canvas (n8n-style SVG, 11 node kinds), guided inspector, LLM NLP generation via `one_shot`.
- Resume-on-boot for in-flight runs.

**Workflow engine**
- Multi-step persistent workflows with approval gates, retry logic, per-step agent routing, resume-on-boot from SQLite.
- Builder UI with step visualizer + approval queue.

**Web UI** (Axum + rust-embed)
- 29 pages: chat, setup, appearance, channels, browser, automations, workflows, skills, mcp, agents, contacts, profiles, memory, knowledge, vault, file-access, shell, sandbox, approvals, account, api-keys, maintenance, logs, traces, onboarding, OAuth callbacks.
- 70+ REST API endpoints under `/api/v1/`.
- WebSocket streaming with delta/tool/block/plan/error events.
- Rich response blocks (choice, approval, status, result, external_message) rendered inline.
- Self-signed TLS via `rcgen`, session cookies, API keys for programmatic access.
- Debug mode: CSS/JS served from filesystem for hot-reload.

**Mobile app** (Flutter, thread-first)
- QR pairing + bearer auth + multi-conversation chat + WebSocket streaming.
- Inline approval, status, result, choice, external-message blocks with tap handlers.
- Thread-level profile switcher, drawer + bottom nav (2-page IndexedStack).
- Biometric lock (`local_auth` + 2-min grace period, secure storage).
- Cross-stack fixture contract (Rust ↔ Flutter): 5 canonical JSON fixtures, 6 Rust + 6 Flutter tests — schema drift is a CI failure.
- Client-side redact on result blocks (defense-in-depth).

**Observability**
- `/metrics` Prometheus endpoint (dual-mount: auth-gated `/api/v1/metrics` always + public `/metrics` conditional on `[metrics] public = true`).
- 12 metrics registered (counter/gauge/histogram), 6 instrumented live: `requests_total`, `tool_calls_total`, `llm_tokens_total`, `cognition_latency`, `tool_execution_latency`, `llm_latency`.
- 4-chokepoint instrumentation strategy (no scatter): `ToolRegistry::execute`, `run_cognition`, `process_message_with_retry`, `ReliableProvider::chat`.
- X-Request-ID trace propagation end-to-end via `tokio::task_local!`. Middleware validates inbound IDs against a whitelist regex and echoes them in response headers. Single identifier across HTTP headers, logs, `RequestTrace.id` on disk.
- `dispatch_to_agent` refactored into outer/inner pair → single wrap point for 6 channels (Telegram/Discord/Slack/WhatsApp/Email/Web); CLI wrapped separately.
- Panic handler installed as the first line of `main()` (catches boot-time panics during TLS / CLI / config / DB init).
- Crash reports stored redacted in `~/.homun/crashes/YYYY-MM-DD_HH-MM-SS_<trace_id>.json` with version, OS/arch, forced backtrace, last 200 log records, trace-id.
- 4-channel crash submission API gated by `[support]` config: clipboard markdown, download JSON, pre-filled GitHub issue, pre-filled mailto. No SaaS, no dial-home — **GitHub as telemetry backend**.
- Daily update checker polling `api.github.com/repos/{public_repo}/releases/latest` via `semver::Version`. Drafts/prereleases skipped. Platform hint detection from `/etc/os-release`. Notifier-only chip in topbar, never auto-updater.

**Native installers** (3 OS targets, 4 platforms)
- Linux `.deb` (amd64 + arm64) via `cargo-deb`, systemd system-level unit, maintainer scripts (postinst/prerm/postrm).
- Linux `.rpm` (x86_64) via `cargo-generate-rpm`.
- macOS `.dmg` (x64 + arm64) with `.app` bundle, launcher shell wrapper, 3 build modes (unsigned / signed / signed+notarized).
- Homebrew formula (`homun-app/tap`) hybrid binary-bottle + source-fallback.
- Windows via WSL2: `docs/INSTALL-WINDOWS-WSL.md` walkthrough.
- GitHub Actions `release.yml` matrix: Linux amd64+arm64 + macOS x64+arm64. Graceful signing fallback (unsigned warning appended when Apple secrets are absent).

**Configuration**
- Single `~/.homun/config.toml`, 15+ sections, hot-reload on change.
- Web setup wizard with provider detection, model listing, API key vault-resolve.
- DB overlay: 3 sections persisted in SQLite with TOML sync + corruption-safe fallback.
- Dotpath get/set for CLI config editing.

**LLM providers** (14+)
- Anthropic (native Claude API with tool_use + streaming + thinking blocks), OpenAI, Ollama (local), OpenRouter, DeepSeek, Groq, Gemini, xAI, Mistral, Together, Fireworks, Cohere, Bedrock, Cloudflare, and OpenAI-compatible generic.
- Capabilities auto-detection (vision, tool_use, extended_thinking).
- `ReliableProvider` wraps any provider with circuit breaker + failover.
- `QueuedProvider` adds priority queue + per-provider concurrency semaphore.
- XML fallback dispatcher for models without native function calling.

### Changed

- **Mobile app thread-first pivot** (Sprint 7, 2026-04-14): Activity feed + Approvals page separate removed in favor of actions inline within the conversation thread. Drawer + bottom nav only, no secondary hub pages.
- **Windows strategy WSL-first pivot** (Sprint 8, 2026-04-14): native `.msi` + Authenticode rescoped to Windows-via-WSL2 doc path after cost analysis ($600-900/year OV/EV cert + post-2023 mandatory HSM + PolyForm incompatible with free signing services). One binary now covers 4 platforms (Ubuntu + Fedora + macOS + Windows-WSL) with a single audit surface.
- **Cognition architecture always-on** (Sprint 9): the feature gate was removed. Every agent invocation runs the read-only discovery mini-loop before execution.
- **License**: from MIT to [PolyForm Noncommercial 1.0.0](./LICENSE) — free for personal and noncommercial use, source access via the private `homun-app/homun-core` repository.
- **Split repo architecture**: `homun-app/homun` (public — issues, releases, docs landing) + `homun-app/homun-core` (private — Rust source, CI workflows, sprint plans, audit findings).
- **Telegram**: migrated from teloxide to frankenstein for reduced binary size and long-polling stability.
- **Embeddings**: removed ONNX/fastembed, switched to provider-agnostic embedding factory (OpenAI + Ollama).
- **Web API**: split monolithic `api.rs` (12K lines) into `web/api/` submodule (30+ domain files).

### Removed

- **Business Autopilot** domain (2026-04-10, commit `17087916`): removed as dead code. Numbered slot `09` preserved as historical ID. May be rewritten from scratch with different logic post-v1.0.

### Security

- **6 Reality Audit sprints completed** (Sprint 2–6): 16/16 domains code-audited via 2–3 parallel Explore agents, ~41K LOC reviewed total.
  - Channels (~4.2K LOC): 7 channels × 9 axes.
  - Memory + RAG (~5.7K LOC): 16 axes M1–M8 + R1–R8.
  - Security E2E (~4K LOC): 15 axes S1–S15.
  - Skills + MCP + Contacts + Profiles (~15.5K LOC): 16 axes SK1–SK6 + M1–M4 + C1–C6.
  - Automations + Workflow + Heartbeat (~11K LOC): 16 axes A1–A6 + W1–W4 + H1–H2.
- **47 bugs tracked** across the audits: **5 🔴 critical**, 31 🟡 high, 11 🟢 low. See [Known issues](#known-issues).
- **13 false positives corrected** in verification reads cross-sprint, establishing the consolidated pattern **"agent confidence ≠ correctness"**: Explore agents read partially and declare features broken when enforcement lives 500 lines deeper in the caller. Verification read is non-negotiable for any severity-🔴 claim.
- **ISO-3 cross-subsystem table closed** (Sprint 6): profile isolation verified end-to-end in 5/7 subsystems (memory, RAG, vault, skills, contact perimeter). 2 ⚠️ partial (MCP, gateway overrides) + 2 ❌ (automations + workflow — #57 **profile_id stored but not enforced at fire time**).

### Fixed (pre-Sprint 2 batch)

- `#1` — Vault 2FA semantic gap: `ToolResult::success` changed to `ToolResult::error` when 2FA gate blocks retrieval; anti-hallucination prompt added; audit log for both 2FA blocked and confirmed paths (commits `554c720`, `18e2975`).
- `#2` — Cognition quality: 6 sub-fixes (keyword fallback, retry feedback, timeout auto-detect, schema 5→2, budget 90s, metrics API).
- `#3` — Vault form re-attach on web UI.
- `#4` — Session expire persistence in DB.
- `#5` — Browser auto-escalate covers JS-required pages + HTTP 403/503/52x via `[HINT:]` check.
- `#6` — Syntax highlighting for 27 file extensions.
- `#7` — Binary file guard in file viewer.
- `#8` — `send_file` for Web channel via `ResultBlock`.
- `#9` — `view_file` tool always-available.
- `A-bug-2` — Null-guard for `loadIdentities()` and `loadDevices()` in `static/js/account.js`.
- `A-bug-3` — `get_avatar()` serves inline SVG placeholder (200 OK) instead of 404.
- `A-bug-8` — Vault audit log propagates `profile_id` via `resolve_profile_id_from_slug` helper.
- Provider hot-reload + OpenRouter model routing.
- Browser auto-cleanup on task completion.
- WebSocket TLS upgrade.
- Embedding provider URL fallback.
- Ollama model auto-pull on save.
- MCP TLS for streamable HTTP client.
- Automations layout and history panel overflow.

### Infrastructure

- **982 Rust tests** + **26 Flutter tests** (including 6 cross-stack fixture contract tests).
- **53 SQLite migrations**, auto-applied at startup.
- CI pipeline: 11 checks, release matrix (Linux amd64+arm64, macOS x64+arm64, no Windows runner).
- ~121K LOC Rust, ~29K LOC JavaScript, 245 Rust source files, 45 JS files.
- 0 production `cargo clippy` warnings on new code (16 pre-existing warnings unchanged since Sprint 8).
- Detailed `/health/components` endpoint (6 subsystem checks).
- Graceful shutdown: SIGTERM + Ctrl+C, 30s grace period, DB pool close.
- Unified toast notification system (`hm-toast`, 17 implementations consolidated).

### Known issues

Five 🔴 critical bugs are known, tracked, and will receive hotfix releases. None are immediate data-loss risks; workarounds are documented per-bug.

| # | Severity | Domain | Summary |
|---|---|---|---|
| `#10` | 🔴 | Channels | WhatsApp + Email declare `outbound_attachments` capability but do not implement upload. Users attempting to send files will see a silent no-op. **Workaround**: use Web/Discord/Slack channels for file transfer; CLI `view_file` to inspect locally. |
| `#11` | 🔴 | Channels | Slack channel is missing `ChannelHealthTracker` integration → circuit breaker is blind, reconnection issues may not be surfaced. **Workaround**: monitor Slack connectivity externally until fixed. |
| `#18` | 🔴 | Memory | `remember` tool path traversal vector in user-provided filename component. **Workaround**: do not let untrusted inputs flow into `remember` calls; audit `~/.homun/brain/USER.md` periodically. |
| `#26` | 🔴 | RAG | RAG ingestion accepts unbounded file size → potential DoS on very large documents. **Workaround**: enforce file size limits at the directory watcher or upload endpoint level manually. |
| `#57` | 🔴 | Automations + Workflow | `profile_id` is stored in DB but **not forwarded at fire time** — cron/event triggers and workflow steps resolve profile via the global resolver cascade, not the stored scope. **Workaround**: run single-profile deployments until fixed. |

Additionally:
- **42 other open bugs** (31 🟡 high + 11 🟢 low) are tracked in `docs/REALITY-AUDIT.md`. Post-migration to the public repo they will become GitHub issues on `homun-app/homun`.
- **`#67` 📝 DEFERRED**: native Windows installer (`.msi` + Authenticode). Intentionally deferred post-v1.0 after cost analysis — the WSL2 path in `docs/INSTALL-WINDOWS-WSL.md` is the supported path for Windows users.
- **`#64` 🟢 mitigated passively**: `HeartbeatService` is defined but never instantiated in production. Sprint 9 mitigation — the `homun_heartbeat_last_fire_timestamp` gauge stays at 0 until the service is wired, surfacing the anomaly in dashboards.

### Links

- Documentation: [homun.app](https://homun.app)
- Issues: [homun-app/homun/issues](https://github.com/homun-app/homun/issues)
- Security policy: [SECURITY.md](https://github.com/homun-app/homun/blob/main/SECURITY.md)
- License: [PolyForm Noncommercial 1.0.0](./LICENSE)

[1.0.0]: https://github.com/homun-app/homun/releases/tag/v1.0.0
