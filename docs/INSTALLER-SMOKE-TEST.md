# Installer Smoke Test — Fresh Install Procedure

> **Purpose**: verify that each Homun installer works end-to-end on a genuinely clean machine (or VM / container), not just on the maintainer's dev box where Rust, cargo, and Homun's dependencies are already present.
>
> **When to run**: before cutting a tagged release (v0.1.1, v0.2.0, v1.0.0...). Every installer that passes the checklist gets ✅ in the release notes; any that fails blocks the release.
>
> **Scope**: this is a manual procedure. The pipeline in `.github/workflows/release.yml` validates that the artifacts *build* cleanly, but only a human can verify that a non-technical user can *install and use* them.

---

## Common checklist (per installer)

Each installer must pass these 7 checks before the release is cut:

1. **Install succeeds** without any error output
2. **Binary is on PATH** or launchable from the UI
3. **First launch creates `~/.homun/`** with expected subdirs (config.toml prompted, db initialized, tls/ created)
4. **Web UI at `http://localhost:8777`** is reachable in a browser
5. **Setup wizard completes** (provider config, at least one channel test message)
6. **Vault stores a secret** (via setup wizard's API key entry for any LLM provider)
7. **Uninstall + reinstall preserves data** (apt remove → apt install does NOT wipe `/var/lib/homun/.homun/`)

For upgrades (not fresh installs): add check 8 — **existing vault survives the upgrade** (run homun once on the old version, note a memory/secret, upgrade, verify it's still there).

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
wget https://github.com/homunbot/homun/releases/latest/download/homun_0.1.0-1_amd64.deb

# Step 3: install
apt install -y ./homun_0.1.0-1_amd64.deb
# Expected: post-install message printed, no errors

# Step 4: verify binary + layout
which homun                          # → /usr/bin/homun
homun --version                      # → homun 0.1.0
ls /lib/systemd/system/homun.service # → exists
id homun                             # → uid=xxx(homun) gid=xxx(homun)
ls -la /var/lib/homun                # → owned by homun:homun, mode 750

# Step 5: first run as the homun user
sudo -u homun homun config           # → setup wizard starts
# (walk through wizard: set provider = ollama or openai-compat, pick a model)

sudo -u homun homun gateway &        # → starts in background
sleep 5

# Step 6: reach the Web UI
curl -s http://localhost:8777/healthz
# → expected: JSON status response

# Step 7: verify vault created
ls -la /var/lib/homun/.homun/secrets.enc   # → exists, owned by homun
ls -la /var/lib/homun/.homun/master.key    # → exists, mode 0600

# Step 8: clean stop
kill %1

# Step 9: upgrade test (requires a second .deb from a newer tag)
apt install -y ./homun_0.1.1-1_amd64.deb   # → "upgraded homun from 0.1.0 to 0.1.1"
sudo -u homun homun gateway &
sleep 3
# Verify the vault is still decryptable (the setup wizard shows saved API key)
kill %1

# Step 10: apt remove (keep data)
apt remove -y homun
ls -la /var/lib/homun/.homun/        # → still present
apt install -y ./homun_0.1.1-1_amd64.deb
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
wget https://github.com/homunbot/homun/releases/latest/download/homun-0.1.0-1.x86_64.rpm
dnf install -y ./homun-0.1.0-1.x86_64.rpm
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

1. **Download**: Safari → github.com/homunbot/homun/releases → click `Homun-0.1.0-arm64.dmg` → save to Downloads
2. **Mount**: double-click the downloaded file → Finder opens the mounted DMG showing `Homun.app` and an `Applications` symlink
3. **Install**: drag `Homun.app` onto `Applications`
4. **Eject**: Finder → right-click mounted volume → Eject
5. **First launch (signed path)**: double-click `/Applications/Homun.app`
   - Expected: Homun.app opens silently in the background, terminal window does *not* appear, default browser opens `http://localhost:8777` within 10 seconds
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
- [ ] `http://localhost:8777` in Edge/Chrome **reaches the gateway inside WSL** (loopback forwarding works)
- [ ] `\\wsl.localhost\Ubuntu\var\lib\homun\.homun\` is browseable from Windows Explorer
- [ ] Task Scheduler auto-start (optional Option C path) triggers at next Windows login

---

## Smoke test runbook per release

For a v1.0 release, I'd run these in parallel over 1-2 hours:

| Hour | Activity |
|---|---|
| 00:00 | Kick off smoke test VMs/containers for Ubuntu 22.04 amd64, Fedora 40, Windows 11 WSL, macOS signed |
| 00:15 | Wait for wsl --install + Ubuntu setup |
| 00:30 | Execute the 11-step Linux `.deb` test on Ubuntu |
| 00:45 | Execute the `.rpm` test on Fedora |
| 01:00 | Execute the macOS signed test on a fresh user account |
| 01:15 | Execute the Windows WSL test (end-to-end walkthrough of INSTALL-WINDOWS-WSL.md) |
| 01:30 | Consolidate findings, note any ⚠️ in release notes |

**Any failure → release is blocked**. Don't ship with "minor issue, will fix in next" on the installer path — installer bugs are uniquely painful because users hit them before anything else works.

---

## Current smoke test status (Sprint 8 snapshot)

| Target | Status | Notes |
|---|---|---|
| Ubuntu 22.04 `.deb` amd64 | 🟡 local metadata validated | cargo-deb produces well-formed package on macOS; full install test deferred to first tag push on CI |
| Ubuntu 22.04 `.deb` arm64 | 🟡 local metadata validated | same as amd64 |
| Fedora 40 `.rpm` x86_64 | 🟡 local metadata validated | cargo-generate-rpm produces RPM v3 binary cleanly; installation test deferred to CI |
| macOS `.dmg` arm64 (unsigned) | ✅ local smoke test | built on dev machine, mounted, bundle structure verified |
| macOS `.dmg` arm64 (signed + notarized) | ⏸️ pending | requires maintainer to complete INSTALLER-SIGNING-SETUP.md |
| macOS `.dmg` x64 (unsigned) | 🟡 CI-only | not tested locally (dev machine is arm64) |
| Windows via WSL2 | ⏸️ pending | requires Windows 11 VM — deferred to first actual user installation |

Status will be updated on each real release.
