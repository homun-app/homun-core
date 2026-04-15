# Homun v1.0.0 — Production Release Notes

> **Audience**: maintainer (Fabio), internal meta-doc. This file is the **state of the union** at the moment v1.0 shipped. It is intentionally blunt about what is shipped, what is deferred, and what might go wrong in the first 7 days post-launch.
>
> **For the user-facing changelog** → [`../CHANGELOG.md`](../CHANGELOG.md).
> **For the public README** → [`../README.md`](../README.md).
> **For the bug tracker** → [`./REALITY-AUDIT.md`](./REALITY-AUDIT.md).
>
> **Release date**: 2026-04-15
> **Tag**: `v1.0.0`
> **Commit**: (populated at tag time)

---

## Executive summary

Homun v1.0 is a **single-binary Rust personal AI assistant** that ships with:

- 7 messaging channels, 14+ LLM providers, 23+ built-in tools, 5 sandbox backends, 21 browser actions, 29 web UI pages, 70+ REST endpoints.
- End-to-end observability: `/metrics` Prometheus endpoint, X-Request-ID trace propagation, panic handler + crash reports + 4-channel submission API, daily update checker.
- Native installers for Linux (.deb + .rpm, amd64 + arm64), macOS (.dmg, x64 + arm64, signed+notarized when Apple cert is configured), Homebrew formula, and a documented Windows-via-WSL2 path.
- Mobile Flutter app with thread-first UX, cross-stack fixture contract, biometric lock.
- 982 Rust tests + 26 Flutter tests passing, 0 new clippy warnings.

It is **not** trying to be:
- A multi-user SaaS product (single-user, `~/.homun/` data dir).
- A team collaboration tool (Phase 3 work).
- A web-hosted control plane (privacy-first, local-first).
- An auto-updater for the binary (`UPD-2` is deferred — manual `apt install`/`brew upgrade`/replace-the-dmg).

---

## What's in v1.0

See [`../CHANGELOG.md`](../CHANGELOG.md) for the exhaustive per-domain list. Highlights the reader may miss:

- **Cognition-First architecture always-on** (not a feature flag anymore).
- **GitHub-as-telemetry-backend**: zero SaaS dependency. Crash reports are user-consensual, locally stored, submitted via one of 4 channels (clipboard, download, pre-filled GitHub issue, pre-filled mailto) gated on `[support]` config.
- **Split-repo strategy**: the public face is `homun-app/homun` (issues, releases, docs); the source lives on `homun-app/homun-core` (private, PolyForm-Noncommercial).
- **Windows = WSL2**: there is no native Windows installer in v1.0. Cost analysis drove a rescope. See `docs/INSTALL-WINDOWS-WSL.md`.

---

## What's explicitly NOT in v1.0

| Area | Status | Reason |
|---|---|---|
| Native Windows installer (`.msi` + Authenticode) | 📝 DEFERRED — bug `#67` | Cost: $600-900/year OV/EV cert + mandatory HSM post-2023. SignPath blocked by PolyForm non-OSI license. WSL2 path ships as the supported Windows option. |
| Binary auto-update (`UPD-2`) | ⏸️ post-v1.0 | Risk of overwriting a binary mid-process. Current update checker is notifier-only. Let package managers (apt, dnf, brew) handle updates. |
| Multi-user isolation (`MU-1/2/3`) | ⏸️ v3 feature | v1.0 is single-user. Profile isolation at the feature level works but `~/.homun/` is not partitioned by OS user. |
| Voice / telephony channels | ❌ excluded | Per UNIFIED-ROADMAP strategic exclusion. |
| i18n (`I18N-1/2`) | ⏸️ post-v1.0 | UI is bilingual-friendly, system locale works, but string catalog is deferred. |
| Fully rebranded public site | ⏸️ refresh only | `homun.dev` gets screenshot + install-section refresh, not a ground-up rebuild. |
| Cognition refactor to v2 (`AGENT-ARCHITECTURE-V2`) | ⏸️ blueprint only | The 6 sub-fixes in Sprint 1 brought cognition to ~90% quality. Full refactor is premature optimization. |

---

## Compatibility matrix

### Operating systems (tested / expected)

| OS | Installer | Arch | Status |
|---|---|---|---|
| Ubuntu 22.04 LTS | `.deb` | amd64 + arm64 | 🟡 local metadata validated, VM smoke-test pending |
| Ubuntu 24.04 LTS | `.deb` | amd64 | 🟡 expected to work (same package) |
| Debian 12 | `.deb` | amd64 | 🟡 expected to work |
| Fedora 40 | `.rpm` | x86_64 | 🟡 local metadata validated, VM smoke-test pending |
| RHEL 9 / Rocky Linux 9 | `.rpm` | x86_64 | 🟡 expected to work |
| macOS 13+ (Ventura+) | `.dmg` or brew | x64 + arm64 | ✅ local bundle verified (unsigned) / ⏸️ signed+notarized pending Apple cert setup |
| Windows 11 | WSL2 + `.deb` | amd64 | ⏸️ VM walkthrough pending |

The maintainer executes the full smoke-test matrix before publishing the release. See `docs/INSTALLER-SMOKE-TEST.md`.

### LLM providers (tier classification)

| Tier | Providers | Notes |
|---|---|---|
| **A — production** | Anthropic, OpenAI, Ollama, OpenRouter | Used daily, tool_use verified, streaming stable |
| **B — supported** | DeepSeek, Groq, Gemini, Mistral, Together, Fireworks | Covered by `openai_compat.rs`, may require XML fallback |
| **C — community** | xAI, Cohere, Bedrock, Cloudflare, LM Studio, generic OpenAI-compatible | Should work via `openai_compat.rs`, no daily regression testing |

**Extended thinking** (Anthropic Claude Opus/Sonnet 4) is auto-detected via model capabilities.

### Channel maturity

| Channel | Status | Known gaps |
|---|---|---|
| CLI | ✅ clean | — |
| Discord | ✅ clean | Only channel with full `ChannelHealthTracker` integration |
| Web (WebSocket) | ✅ clean | — |
| Telegram | ⚠️ | Health tracker calls missing (#13), fixed 5s backoff (#14), silent attachment drops |
| WhatsApp | ⚠️ | Outbound attachments capability drift (#10 🔴), health tracker missing (#13) |
| Slack | ⚠️ | Missing `ChannelHealthTracker` struct integration (#11 🔴) |
| Email | ⚠️ | Outbound attachments capability drift (#10 🔴), dead-code `is_sender_allowed()` (#12) |

**Recommendation for v1.0 users**: prefer **CLI + Discord + Web** for production use. Telegram/WhatsApp/Slack/Email work for incoming messages; outgoing file attachments should be worked around.

### Sandbox backends

| Backend | OS | Status |
|---|---|---|
| Docker | all | ✅ verified, baseline image tested |
| macOS native | macOS | ✅ |
| Seatbelt (sandbox-exec) | macOS | ✅ |
| Linux Bubblewrap (bwrap) | Linux | ✅ |
| Windows Job Objects (via WSL) | Windows | ✅ |

Auto-detection picks the best available backend. Fallback to `None` has a known silent-fallback gap (#35) — mitigate by setting `[sandbox] require = true` in config.

---

## Upgrade path

### From v0.2 alpha → v1.0

**Recommended**: fresh install, keep `~/.homun/` data directory intact.

```bash
# Backup (just in case)
cp -r ~/.homun ~/.homun.backup-pre-1.0

# Install v1.0 via your package manager
# (apt / dnf / brew / drag-dmg — see README.md)

# First run of v1.0 detects existing ~/.homun/ and runs migrations automatically
homun gateway
```

**SQLite migrations are idempotent.** The 53 migrations auto-apply on first boot and skip any that have already run. The vault (`~/.homun/secrets.enc` + OS keychain master key) is **not touched** by the upgrade — the key is under `dev.homun.secrets` in the OS keychain (see `src/storage/secrets.rs:29`, single call site).

### Breaking changes

**None expected.** Verify before cutting the release with:

```bash
git log v0.2..HEAD --grep='BREAKING' --oneline
```

If any commits match, triage them and document in this section before tagging.

### Config migration

`~/.homun/config.toml` v0.2 is compatible with v1.0. The new sections (`[support]`, `[updates]`, `[metrics]`) are additive with sensible defaults. Users get them on first write by the web UI or CLI setup wizard.

---

## Post-release monitoring (first 7 days)

These are the metrics/surfaces to watch in the 7 days after `v1.0.0` ships. Any sustained anomaly becomes a v1.0.1 candidate.

### 1. GitHub issue rate

- **Soft alert**: > 10 new issues/day in days 1-3.
- **Hard alert**: > 5 duplicate issues for the same crash (indicates a regression).
- **Action**: triage + decide whether a hotfix is warranted.

### 2. Crash reports submitted

- **Soft alert**: > 5 distinct crash reports/day.
- **Hard alert**: same crash file pattern from > 3 distinct users — systemic bug.
- **Action**: inspect the JSON files shared via the 4-channel submission, identify the panic location, write a regression test.

### 3. `/metrics` dashboard baseline (from self-hosted users who share)

Expected ranges (rough, to be refined after first week):
- `homun_requests_total` rate: proportional to user activity.
- `homun_tool_calls_total{tool=*,status="error"}` / `homun_tool_calls_total{tool=*}` error ratio: **< 5%** steady-state.
- `homun_cognition_latency_seconds` p95: **< 3s** for steady-state cognition.
- `homun_llm_latency_seconds{provider=*}` p95: depends on provider (Anthropic ~2-5s, Ollama local ~0.5-2s).
- `homun_cognition_fallback_total`: should be **< 1%** of cognition runs (fallback fires only on provider error).

### 4. Update checker uptake

Query `https://api.github.com/repos/homun-app/homun/releases/tags/v1.0.0` download counts weekly. If v1.0 adoption plateaus, check for install-blocking regressions in later releases.

### 5. Homebrew formula
- Monitor `homun-app/homebrew-tap` for PRs / issues (expected low traffic).
- `brew install homun-app/tap/homun` should work within minutes of cutting the release.

---

## Known issues with workarounds

All 5 🔴 bugs are documented in the user-facing [`../CHANGELOG.md`](../CHANGELOG.md) with workarounds. This section is the maintainer-facing view: root cause + fix effort estimate.

| # | Bug | Root cause | Fix effort | Priority |
|---|---|---|---|---|
| `#10` | WA+Email outbound attachments | Capability table aspirational, not runtime-audited | S (2-3 days) — implement upload or set capability to false | v1.0.1 |
| `#11` | Slack health tracking | Missing `ChannelHealthTracker` struct field | XS (2 hours) — copy Discord pattern | v1.0.1 |
| `#18` | `remember` path traversal | User-controlled filename component not canonicalized | XS (1 hour) — add `check_path_permission` + `canonicalize` | **v1.0.1 hotfix** |
| `#26` | RAG DoS on large file | No size limit in directory watcher / upload | S (3-4 hours) — add `DefaultBodyLimit` on upload + size check in watcher | **v1.0.1 hotfix** |
| `#57` | Automations/Workflow profile_id | `CronEvent` struct missing `profile_id`, `execute_step` not setting session profile | M (2-3 days) — add field + propagate through fire path | v1.1.0 |

`#18` and `#26` are the two **hotfix candidates** — file size DoS and path traversal are the kind of issues that users report publicly and embarrass the release. Estimate: ~1 day of work to ship a `v1.0.1` with both fixes.

The other 3 (`#10`, `#11`, `#57`) can wait for `v1.1.0` since they have workarounds (use a different channel, monitor externally, run single-profile).

---

## What could go wrong in the first 7 days (and what to do)

### Scenario A: `.deb` fails on Ubuntu 22.04 with "unmet deps"
- **Cause**: dep resolution picks unexpected `libsqlite3-0` version.
- **Fix**: update `packaging/linux/Cargo.toml [package.metadata.deb] depends` field, re-tag as v1.0.1.

### Scenario B: macOS `.dmg` fails Gatekeeper notarization check
- **Cause**: stale notarization (> 6 months) or Apple cert misconfigured.
- **Fix**: re-run `create-dmg.sh` with fresh credentials, re-publish the macOS assets under v1.0.0 (GitHub Release allows asset re-upload without re-tagging).

### Scenario C: Homebrew formula points to wrong SHA256
- **Cause**: CI step that computes SHA256 race condition.
- **Fix**: manually update `homun-app/homebrew-tap/Formula/homun.rb`, commit directly.

### Scenario D: Update checker chip shows "1.0.1 available" on a 1.0.1 install (loop)
- **Cause**: `semver::Version` compare bug or `tag_name` with unexpected format.
- **Fix**: debug via `GET /v1/updates/status`, disable the checker (`[updates] check_enabled = false`), ship v1.0.2.

### Scenario E: Crash reporter catches its own panic (infinite loop)
- **Cause**: `CRASH_IN_PROGRESS` atomic bool not resetting. Should not happen — guarded in `src/crash_reporter.rs`.
- **Fix**: disable crash reporter via config, investigate, ship hotfix.

### Scenario F: User reports a silent data loss on vault upgrade
- **Cause**: OS keychain migration on macOS major version upgrade (rare).
- **Fix**: the vault service/account in `src/storage/secrets.rs:29` is `dev.homun.secrets`. If it was somehow renamed between v0.x and v1.0 → critical hotfix. **Current state**: unchanged since v0.2, verified Sprint 8.

---

## Decisions for v1.x → v2.0 (wait-and-see)

Do not preemptively plan these. Let real user feedback drive them.

- **Phase 3 (Consumer-Ready)**: start when 100+ active users, zero 🔴 bugs open > 30 days, 3+ incorporated feature requests.
- **Phase 4 (Multi-agent, PWA, Ingress, UI Redesign)**: wait for demand signal — no point building if nobody asks.
- **Auto-update binary (`UPD-2`)**: consider only if user feedback says "manual upgrade is painful". Otherwise, package managers win.
- **Multi-user (`MU-1/2/3`)**: v3 feature, requires schema changes that would break the single-user assumption throughout the codebase.

---

## Handoff checklist for Sprint 10 closing (maintainer)

Before declaring Sprint 10 ✅ and tagging `v1.0.0`:

- [ ] All 5 Sprint 10 commits landed (from Claude's Fase A)
- [ ] `docs/MIGRATION-SPLIT-REPO.md` Phase 1-9 executed (homun-app/homun public + homun-app/homun-core private)
- [ ] `~/.homun/config.toml` flipped: `[support] crash_submit_github = true`
- [ ] Apple Developer cert + 6 GitHub Secrets configured (optional — release ships unsigned as graceful fallback)
- [ ] 4 smoke tests executed fresh-install per `docs/INSTALLER-SMOKE-TEST.md` (Ubuntu .deb + Fedora .rpm + macOS .dmg + Windows WSL2), evidence tarballs attached to the release
- [ ] `homun.dev` (repo `homun-app/docs`) refreshed with v1.0 screenshots, GIFs, install section, "What's new"
- [ ] `git tag -a v1.0.0 -m "Homun 1.0.0"` pushed to `homun-app/homun-core`
- [ ] GitHub Release visible on `homun-app/homun` with all 6 artifacts + SHA256 checksums
- [ ] Homebrew formula updated on `homun-app/homebrew-tap`
- [ ] Announcement post drafted for HN/Reddit/Twitter (publish timing is discretionary)
- [ ] This file updated with the commit SHA of the v1.0.0 tag

---

## Post-launch rollback plan (if catastrophic)

If the release has to be pulled within the first 24 hours:

1. **Mark the GitHub Release as "pre-release"** (does not delete, but hides from `/releases/latest` API).
2. **Homebrew**: revert the tap commit, users re-running `brew upgrade` stay on pre-v1.0.
3. **Debian/Fedora**: users who already installed are stuck until a v1.0.1 ships — no rollback mechanism in `apt`/`dnf` without explicit pinning.
4. **macOS `.dmg`**: delete the asset from the release — users who already downloaded must re-download after v1.0.1.
5. **Communication**: pinned GitHub issue on `homun-app/homun` explaining the pull + ETA on v1.0.1.

**Expected likelihood**: LOW. Sprint 1-9 put a lot of work into not shipping a broken binary.

---

*End of production release notes.*
