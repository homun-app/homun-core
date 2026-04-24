# Installer Smoke Test — Fresh Install Procedure

> **Purpose**: verify that each Homun installer works end-to-end on a genuinely clean machine (or VM / container), not just on the maintainer's dev box where Rust, cargo, and Homun's dependencies are already present.
>
> **When to run**: before cutting a tagged release (v1.0.0, v1.0.1, v1.1.0…). Every installer that passes the checklist gets ✅ in the release notes; any that fails blocks the release.
>
> **Scope**: this is a manual procedure. The pipeline in `.github/workflows/release.yml` validates that the artifacts *build* cleanly, but only a human can verify that a non-technical user can *install and use* them.

---

## Common checklist (per installer)

Each installer must pass these **11 checks** before the release is cut:

**Basic install path (checks 1-7)**

1. **Install succeeds** without any error output
2. **Binary is on PATH** or launchable from the UI
3. **First launch creates `~/.homun/`** with expected subdirs (config.toml prompted, db initialized, tls/ created)
4. **Web UI at `https://localhost:18443`** is reachable in a browser
5. **Setup wizard completes** (provider config, at least one channel test message)
6. **Vault stores a secret** (via setup wizard's API key entry for any LLM provider)
7. **Uninstall + reinstall preserves data** (apt remove → apt install does NOT wipe `/var/lib/homun/.homun/`)

**Sprint 9 observability path (checks 8-11 — new for v1.0)**

8. **Crash reporter captures panics**: trigger a controlled panic (inject `panic!("smoke test panic")` behind a debug route, or SIGSEGV via `kill -SEGV <pid>` — though `kill -SEGV` is not a Rust panic and won't trigger the hook, so prefer an explicit panic route on a debug build). Verify:
   - A JSON file appears in `~/.homun/crashes/YYYY-MM-DD_HH-MM-SS_<trace_id>.json`
   - `curl -sk https://localhost:18443/api/v1/crashes | jq '.crashes | length'` returns ≥ 1
   - File is redacted (no vault-looking secrets or file contents from `~/.homun/` in the JSON)
9. **Prometheus `/metrics` endpoint is reachable**: `curl -sk https://localhost:18443/api/v1/metrics | head -20` returns Prometheus text format with at least one `homun_*` metric (requests_total, tool_calls_total, llm_tokens_total). If `[metrics] public = true`, also `curl -sk https://localhost:18443/metrics` works unauthenticated.
10. **X-Request-ID trace propagation end-to-end**: `curl -sk -H "X-Request-ID: smoke-test-abc123" https://localhost:18443/healthz -i | grep -i x-request-id` echoes the exact value in the response. Grep `~/.homun/logs/` or `journalctl -u homun` for `trace_id=smoke-test-abc123` to confirm log propagation.
11. **Update checker chip surfaces new releases**: temporarily create a dummy release tag `v99.0.0` on the public repo (or override `api.github.com` via `/etc/hosts` + local HTTP mock) and verify the topbar chip in the dashboard shows the "update available" notification within 60 seconds. Remove the dummy tag afterwards.

For upgrades (not fresh installs): add check 12 — **existing vault survives the upgrade** (run homun once on the old version, note a memory/secret, upgrade, verify it's still there).

> **Evidence tarball**: for each installer tested, save `~/.homun/logs/*.log` + `~/.homun/crashes/*.json` + `curl /api/v1/metrics` output into `smoke-evidence-<target>-<date>.tgz` and attach it to the GitHub Release as "Smoke test evidence".

---

## Test matrix

| Target | Installer | VM / Environment | Architecture |
|---|---|---|---|
| Ubuntu 22.04 LTS | `.deb` | Multipass VM or Docker `ubuntu:22.04` | amd64 + arm64 |
| Ubuntu 24.04 LTS | `.deb` | Multipass VM | amd64 |
| Debian 12 | `.deb` | Docker `debian:12` or VM | amd64 |
| Fedora 40 | `.rpm` | Docker `fedora:40` or VM | x86_64 |
| RHEL 9 / Rocky Linux 9 | `.rpm` | Docker `rockylinux:9` | x86_64 |
| macOS 13+ | `.dmg` | Fresh user account on host Mac, or a new VM snapshot | arm64 + x64 |
| Windows 11 | `.deb` via WSL2 | Fresh Windows 11 VM + `wsl --install` | amd64 |

The Linux `.deb` and `.rpm` cover Windows via WSL too — the WSL smoke test is really a superset of the Ubuntu .deb test, with WSL-specific checks added.

---

## Linux `.deb` (Ubuntu 22.04 amd64 — representative case)

### Environment setup

Fastest approach: **Docker container with systemd**. Docker's default images don't run systemd, so use a base that supports it (e.g. `jrei/systemd-ubuntu:22.04`), or skip the systemd check and run Homun in foreground.

```bash
docker run --rm -it --name homun-smoke ubuntu:22.04 bash
```

Inside the container, we're a non-technical user — no Rust, no Homun, nothing. This is what the smoke test validates.

### Steps

```bash
# Step 1: install base deps (simulates a minimal Ubuntu server)
apt update
apt install -y wget adduser sudo

# Step 2: download the .deb from the GitHub Release
wget https://github.com/homun-app/homun/releases/latest/download/homun_1.0.0-1_amd64.deb

# Step 3: install
apt install -y ./homun_1.0.0-1_amd64.deb
# Expected: post-install message printed, no errors

# Step 4: verify binary + layout
which homun                          # → /usr/bin/homun
homun --version                      # → homun 1.0.0
ls /lib/systemd/system/homun.service # → exists
id homun                             # → uid=xxx(homun) gid=xxx(homun)
ls -la /var/lib/homun                # → owned by homun:homun, mode 750

# Step 5: first run as the homun user
sudo -u homun homun config           # → setup wizard starts
# (walk through wizard: set provider = ollama or openai-compat, pick a model)

sudo -u homun homun gateway &        # → starts in background
sleep 5

# Step 6: reach the Web UI
curl -sk https://localhost:18443/healthz
# → expected: JSON status response

# Step 7: verify vault created
ls -la /var/lib/homun/.homun/secrets.enc   # → exists, owned by homun
ls -la /var/lib/homun/.homun/master.key    # → exists, mode 0600

# Step 8: clean stop
kill %1

# Step 9: upgrade test (requires a second .deb from a newer tag)
apt install -y ./homun_1.0.1-1_amd64.deb   # → "upgraded homun from 1.0.0 to 1.0.1"
sudo -u homun homun gateway &
sleep 3
# Verify the vault is still decryptable (the setup wizard shows saved API key)
kill %1

# Step 10: apt remove (keep data)
apt remove -y homun
ls -la /var/lib/homun/.homun/        # → still present
apt install -y ./homun_1.0.0-1_amd64.deb
# Re-install, verify data still there

# Step 11: apt purge (wipe data)
apt purge -y homun
ls -la /var/lib/homun 2>&1           # → "No such file or directory"
id homun 2>&1                        # → "no such user"
```

**Pass criteria**: all 11 steps complete without errors. Any non-zero exit code or unexpected error blocks the release.

### Known gotchas

- **`adduser` missing** on ultra-minimal distros: test with a truly minimal image (`ubuntu:22.04` is fine), not Alpine or busybox.
- **systemd tests require privileged mode**: `docker run --privileged -v /sys/fs/cgroup:/sys/fs/cgroup:ro jrei/systemd-ubuntu:22.04` or skip systemd checks entirely.

---

## Linux `.rpm` (Fedora 40 x86_64)

Same shape as the `.deb` test but with `dnf` or `rpm` commands:

```bash
docker run --rm -it fedora:40 bash

dnf install -y wget
wget https://github.com/homun-app/homun/releases/latest/download/homun-1.0.0-1.x86_64.rpm
dnf install -y ./homun-1.0.0-1.x86_64.rpm
# Same verification as above, but paths:
#   /usr/lib/systemd/system/homun.service  (RPM convention)
#   /var/lib/homun/                        (same)
```

RPM `.spec` inline scripts handle user creation + systemd reload — verify the post-install message matches.

---

## macOS `.dmg` (arm64 + x64)

The macOS test is the most different from Linux — there's no terminal-first flow, the user double-clicks a DMG and expects a graphical experience.

### Environment setup

Best: a **separate macOS user account** (or a fresh macOS VM) with no Rust toolchain, no dev tools, no prior Homun state. Create via System Settings → Users & Groups → Add Account → Standard user. Log in as that user for the test.

If VMs aren't practical, clean up the current user first:
```bash
rm -rf ~/.homun/
security delete-generic-password -s dev.homun.secrets 2>/dev/null || true
```

### Steps

1. **Download**: Safari → github.com/homun-app/homun/releases → click `Homun-1.0.0-arm64.dmg` → save to Downloads
2. **Mount**: double-click the downloaded file → Finder opens the mounted DMG showing `Homun.app` and an `Applications` symlink
3. **Install**: drag `Homun.app` onto `Applications`
4. **Eject**: Finder → right-click mounted volume → Eject
5. **First launch (signed path)**: double-click `/Applications/Homun.app`
   - Expected: Homun.app opens silently in the background, terminal window does *not* appear, default browser opens `https://localhost:18443` within 10 seconds
   - Web UI shows the setup wizard
6. **First launch (unsigned path)**: same, but first attempt shows Gatekeeper warning
   - Right-click Homun.app → Open → click "Open" in the dialog
   - Expected: same as signed path after first bypass
7. **Setup wizard**: complete provider config + pick a model
8. **Verify data dir**: `ls ~/.homun/` → should see config.toml, homun.db, secrets.enc, master.key or keychain entry
9. **Verify keychain entry** (if not file-based fallback):
   ```bash
   security find-generic-password -s dev.homun.secrets
   ```
   Should return a master key entry.
10. **Re-launch**: double-click Homun.app again → should skip the "wait for startup" loop and open the browser immediately (PID file check)
11. **Uninstall**: drag Homun.app from /Applications to Trash → `rm -rf ~/.homun/` → verify `security find-generic-password` returns "not found"

**Signed test-specific checks**:
- After step 5, right-click Homun.app → Get Info → verify the signature is shown (scroll to Preview pane)
- `codesign -dv --verbose=4 /Applications/Homun.app 2>&1 | grep Authority` → should show "Developer ID Application: <your name>"
- `spctl --assess --verbose /Applications/Homun.app` → should print "accepted, source=Notarized Developer ID"

### Known gotchas

- **Safari unquarantines by origin**: downloads from GitHub.com get the quarantine bit; test from Safari rather than `curl` to exercise the full Gatekeeper path
- **DMG "Verifying..." can take 30-60s** on first open — this is Gatekeeper scanning, normal
- **If notarization is stale** (older than 6 months), `spctl` may still warn — re-notarize if the signed smoke test fails

---

## Windows via WSL2

Full test procedure in [`INSTALL-WINDOWS-WSL.md`](./INSTALL-WINDOWS-WSL.md) — the smoke test is to literally walk through that doc step by step on a **fresh Windows 11 VM**, checking that every command succeeds and every expected message appears.

Critical checks unique to the WSL path:

- [ ] `wsl --install -d Ubuntu` completes on first try (no pre-existing WSL state)
- [ ] `apt install ./homun_*.deb` resolves deps from Ubuntu repos (ca-certificates, adduser, libsqlite3-0) without errors
- [ ] `https://localhost:18443` in Edge/Chrome **reaches the gateway inside WSL** (loopback forwarding works)
- [ ] `\\wsl.localhost\Ubuntu\var\lib\homun\.homun\` is browseable from Windows Explorer
- [ ] Task Scheduler auto-start (optional Option C path) triggers at next Windows login

---

## Smoke test runbook per release

For a v1.0 release, run these **in parallel** across 4 VM/container environments over ~2 hours of focused attention. Each lane runs the 11-step common checklist plus any OS-specific steps.

| Hour | Lane A — Ubuntu 22.04 `.deb` | Lane B — Fedora 40 `.rpm` | Lane C — macOS signed `.dmg` | Lane D — Windows 11 WSL2 |
|---|---|---|---|---|
| 00:00 | Spin up `ubuntu:22.04` container or Multipass VM | Spin up `fedora:40` container | Fresh macOS user account or VM snapshot | Boot Windows 11 VM, start `wsl --install -d Ubuntu` |
| 00:15 | `apt install ./homun_1.0.0-1_amd64.deb` | `dnf install ./homun-1.0.0-1.x86_64.rpm` | Double-click `Homun-1.0.0-arm64.dmg`, drag to Applications | Wait for WSL + Ubuntu bootstrap |
| 00:30 | Run 11-step checklist | Run 11-step checklist | Launch `Homun.app`, run 11-step checklist | Start WSL Ubuntu, `apt install ./homun_*.deb` |
| 00:45 | Save `smoke-evidence-ubuntu-amd64.tgz` | Save `smoke-evidence-fedora.tgz` | `codesign -dv`, `spctl --assess`, save `smoke-evidence-macos-signed.tgz` | Run 11-step checklist + WSL-specific checks |
| 01:00 | Run 11-step checklist on arm64 variant | — | Test `.dmg` x64 on Intel Mac if available | `https://localhost:18443` from Windows Edge |
| 01:15 | — | — | — | Save `smoke-evidence-wsl.tgz` |
| 01:30 | Consolidate: attach all 4 tarballs to the GitHub Release, note any ⚠️ in release notes, decide GO / NO-GO |

### Decision tree on failure

- **1 lane fails, error is transient** (network flake, VM boot issue): retry the lane once. If it passes, proceed.
- **1 lane fails, error is reproducible**: the failing target gets `❌ blocked` in release notes. The release does **not** ship until fixed.
- **2+ lanes fail**: stop, triage the root cause, cut a patch, re-run all 4 lanes after the fix.

**Any failure → release is blocked**. Don't ship with "minor issue, will fix in next" on the installer path — installer bugs are uniquely painful because users hit them before anything else works.

### Sprint 9 observability verification — required for every lane

The 4 new checks (8-11) are **non-negotiable for v1.0**. They verify that the Sprint 9 observability work actually lands in production:

- Check 8 proves the panic handler was installed as the first line of `main()` (crash reports reach disk).
- Check 9 proves the `/metrics` endpoint is mounted both on the auth path and (conditionally) the public path.
- Check 10 proves the `X-Request-ID` middleware runs on every HTTP request and the `tokio::task_local!` `TASK_TRACE_ID` survives across async boundaries.
- Check 11 proves the daily `spawn_update_checker` task is running and the topbar chip reads from `AppState.update_status` correctly.

Skipping any of these means the release ships without evidence that the observability plumbing works end-to-end.

---

## Current smoke test status (v1.0 release target)

At the moment this doc was written, the artifacts are ready for maintainer VM execution. Every row below is blocked on "run on a clean VM", which Claude cannot do in-session.

| Target | Status | Notes |
|---|---|---|
| Ubuntu 22.04 `.deb` amd64 | ⏸️ maintainer VM pending | `cargo-deb` metadata validated on dev machine Sprint 8. Awaits clean Ubuntu VM run pre-release |
| Ubuntu 22.04 `.deb` arm64 | ⏸️ maintainer VM pending | same as amd64, arm64 VM required |
| Ubuntu 24.04 `.deb` amd64 | ⏸️ maintainer VM pending | sanity check on newer LTS |
| Debian 12 `.deb` amd64 | ⏸️ maintainer VM pending | expected to pass (same package) |
| Fedora 40 `.rpm` x86_64 | ⏸️ maintainer VM pending | `cargo-generate-rpm` metadata validated Sprint 8 |
| RHEL 9 / Rocky Linux 9 `.rpm` x86_64 | ⏸️ maintainer VM pending | expected to pass |
| macOS `.dmg` arm64 (unsigned) | ✅ Sprint 8 local smoke | bundle structure verified, DMG mounted, `codesign -dv` expected without signing |
| macOS `.dmg` arm64 (signed + notarized) | ⏸️ Apple cert pending | requires maintainer to complete `docs/INSTALLER-SIGNING-SETUP.md` — 6 GitHub Secrets on `homun-app/homun-core` |
| macOS `.dmg` x64 (unsigned + signed) | ⏸️ maintainer VM pending | not tested locally (dev machine is arm64) |
| Windows 11 via WSL2 | ⏸️ maintainer VM pending | requires clean Windows 11 VM — full walkthrough of `docs/INSTALL-WINDOWS-WSL.md` |
| Sprint 9 checks 8-11 (all targets) | ⏸️ maintainer VM pending | crash reporter, `/metrics`, X-Request-ID, update checker chip — newly introduced for v1.0 |

Status will be updated immediately after the maintainer runs the VM lanes pre-tag.
