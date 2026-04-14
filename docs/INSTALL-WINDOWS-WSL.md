# Installing Homun on Windows via WSL2

> **Who this is for**: Windows 10 build 19041+ or Windows 11 users who want to run Homun on their Windows machine.
>
> **Approach**: Homun is distributed as a Linux binary for Windows users via WSL2 (Windows Subsystem for Linux 2). WSL2 runs a real Linux kernel inside a lightweight Hyper-V VM and transparently forwards localhost so the Homun Web UI is reachable from your Windows browser. A native Windows installer will come in a future release once code signing is configured — see [Roadmap](#roadmap) at the bottom.
>
> **Time required**: ~15 minutes the first time (WSL install is the slow part). Subsequent upgrades: 30 seconds.

---

## Why WSL instead of a native installer?

Three reasons, in order of weight:

1. **Security model parity**: running the same Linux binary on all platforms (Ubuntu, Fedora, macOS-via-brew, Windows-via-WSL) gives us a single attack surface to audit, a single set of files in `~/.homun/`, and identical behavior across operating systems. Native Windows binaries work but have a subtly different security model (Windows Credential Manager vs file-based vault, different path separators in edge cases, different sandboxing) that's worth sharing audit effort on.
2. **Code signing cost**: a Windows-native MSI installer requires Microsoft Authenticode code signing with an EV certificate ($400–600/year) **plus** a hardware security module for the CA/Browser Forum baseline compliance (post-2023). We'd rather invest that budget into shipping features until we have paying users who need a native Windows UX.
3. **Performance is actually fine**: WSL2 is not an emulator. It's a real Linux kernel in a lightweight Hyper-V VM, and I/O-bound tools like Homun see no measurable overhead. The localhost loopback is forwarded automatically.

If you prefer a native Windows binary anyway, one is built by CI for every release (`homun-windows-x64.exe`) and available as a raw asset on the [GitHub Releases page](https://github.com/homunbot/homun/releases). It's **unsupported for v1.0** — you'll get Windows SmartScreen warnings on first run. Use at your own risk.

---

## Step 1 — Enable WSL2 (one-time, ~5 min + reboot)

Open **PowerShell as Administrator** and run:

```powershell
wsl --install -d Ubuntu
```

That single command:
- Enables the "Virtual Machine Platform" and "Windows Subsystem for Linux" Windows features
- Downloads the latest Ubuntu LTS (Ubuntu 22.04 or 24.04)
- Registers it as the default WSL distribution

If you're on Windows 10 < build 19041 or Windows 11 builds older than 22H2, follow the [manual install steps](https://learn.microsoft.com/en-us/windows/wsl/install-manual) instead.

**Reboot** after the command completes. On next login, Ubuntu finishes setup and asks you to create a username + password for the Linux side. Pick anything — this is a local UNIX account isolated from Windows.

### Verify WSL2 is actually running

Open PowerShell again (regular user is fine) and run:

```powershell
wsl --list --verbose
```

You should see something like:

```
  NAME      STATE           VERSION
* Ubuntu    Running         2
```

If **VERSION** is `1` not `2`, upgrade with:

```powershell
wsl --set-default-version 2
wsl --set-version Ubuntu 2
```

WSL2 is a hard requirement — WSL1 is a translation layer that lacks the full Linux kernel and has known issues with systemd, Docker-in-WSL, and some crypto operations Homun uses.

---

## Step 2 — Install the Homun .deb package (~2 min)

Open an Ubuntu terminal (Start menu → Ubuntu, or `wsl` in PowerShell). Then:

```bash
# Download the latest .deb from GitHub Releases (substitute v0.1.0 with the current version)
wget https://github.com/homunbot/homun/releases/latest/download/homun_0.1.0-1_amd64.deb

# Install it — dpkg resolves deps via apt
sudo apt install ./homun_0.1.0-1_amd64.deb
```

The installer will:
- Create a dedicated `homun` system user with home at `/var/lib/homun`
- Place the binary at `/usr/bin/homun`
- Install a systemd unit at `/lib/systemd/system/homun.service` (but **not** start it — that's your choice)
- Print a post-install message with the next steps

To upgrade later, just `apt install ./homun_<newer-version>_amd64.deb` over the old one. Your `~/.homun/` data is preserved across upgrades.

To remove (keeping data): `sudo apt remove homun`
To remove everything (wipes `/var/lib/homun`): `sudo apt purge homun`

---

## Step 3 — First run (choose one)

### Option A — Simple: interactive foreground

Best if you only use Homun occasionally or want to see logs directly.

```bash
sudo -u homun homun config    # one-time: run the setup wizard
sudo -u homun homun gateway   # start the gateway in foreground
```

Open `http://localhost:8777` in your **Windows browser** (not inside WSL). You should see the Web UI. ✨

Close the terminal → Homun stops. Re-run to restart.

### Option B — Persistent: systemd service

Best if you want Homun to run in background and auto-start when WSL starts.

First, enable **systemd inside WSL**. Ubuntu 22.04+ via `wsl --install` has systemd enabled by default, but let's verify:

```bash
cat /etc/wsl.conf 2>/dev/null | grep -A 1 '\[boot\]'
```

If you see `systemd=true`, you're good. Otherwise, add it:

```bash
sudo tee /etc/wsl.conf > /dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Restart WSL from PowerShell (Windows side):

```powershell
wsl --shutdown
```

Then reopen an Ubuntu terminal and:

```bash
sudo systemctl enable --now homun
systemctl status homun       # verify it's running
journalctl -u homun -f       # tail logs
```

Homun now starts automatically whenever you open a WSL session. Your Windows browser can reach `http://localhost:8777` any time.

### Option C — Advanced: Windows Task Scheduler auto-start

Best if you want Homun to start at Windows login without needing to open a WSL terminal first.

1. Open **Task Scheduler** (Start menu)
2. Create Task (not "Basic Task")
3. **General** tab: name "Homun Gateway", "Run whether user is logged on or not" if you have admin
4. **Triggers** tab: Add → At log on
5. **Actions** tab: Add → Program: `wsl.exe`, Arguments: `-d Ubuntu -u homun -- /usr/bin/homun gateway`
6. **Conditions** tab: uncheck "Start the task only if the computer is on AC power" if you're on a laptop
7. Save

At next Windows login, Homun starts in the background via WSL. The Web UI is reachable at `http://localhost:8777`. This works even if you never explicitly open a WSL terminal — Windows keeps the WSL VM alive in the background.

---

## Accessing Homun from Windows

### Web UI

Open `http://localhost:8777` in **Edge/Chrome/Firefox on Windows** — WSL2 forwards loopback automatically. No firewall rules, no port forwarding, nothing to configure. This just works.

### Files

Your Homun data lives **inside** the WSL Linux filesystem at `/var/lib/homun/.homun/` (when installed as a service) or `~/.homun/` (when run as your own user). From Windows Explorer, you can reach it via:

```
\\wsl.localhost\Ubuntu\var\lib\homun\.homun\
```

or

```
\\wsl.localhost\Ubuntu\home\<yourusername>\.homun\
```

Copy files in and out by drag-drop like any normal Windows folder.

### CLI from PowerShell

You can invoke Homun from PowerShell without opening a WSL terminal:

```powershell
wsl -d Ubuntu -u homun -- homun --help
wsl -d Ubuntu -u homun -- homun chat -m "hello"
```

Wrap it in a PowerShell function in your `$PROFILE` for a clean one-word invocation:

```powershell
function homun { wsl -d Ubuntu -u homun -- homun $args }
```

Now `homun chat -m "hello"` in PowerShell routes through WSL transparently.

---

## Gotchas

### Vault stores the master key in a file, not Windows Credential Manager

Homun's encrypted vault (`~/.homun/secrets.enc`) uses a master key stored in the OS keychain. On WSL2 without a desktop environment, there's no D-Bus session and no Secret Service API, so `keyring` (the Rust crate Homun uses) falls back to file-based master key storage at `~/.homun/master.key` with `chmod 0600` permissions.

**Security impact**: the master key file is readable only by the `homun` user inside WSL, protected by the Linux filesystem. The Windows host filesystem cannot read it directly — WSL files are isolated from Windows processes. An attacker would need shell access as the `homun` user inside WSL to exfiltrate the key, which is the same threat model as a Linux desktop install.

If you want OS-level key storage on WSL (Secret Service via gnome-keyring), install it explicitly:

```bash
sudo apt install gnome-keyring dbus-user-session
```

Then restart WSL. Homun will pick up Secret Service on next launch.

### WSL hibernation and background processes

Windows may pause the WSL2 VM when no WSL terminal has been open for ~8 seconds (WSL 0.67+ default behavior). This kills background Homun processes started from a foreground `homun gateway`. Two fixes:

1. **Use the systemd service** (Option B in Step 3) — systemd-managed processes keep WSL alive.
2. **Disable auto-shutdown**: create `C:\Users\<you>\.wslconfig` with:
   ```ini
   [wsl2]
   vmIdleTimeout=-1
   ```
   Then `wsl --shutdown` and reopen. This keeps WSL running indefinitely at the cost of ~200MB RAM always reserved.

### Antivirus slowdowns

Windows Defender's real-time scanning can significantly slow down WSL file I/O. For a dev-tool-level improvement, add the WSL filesystem to Defender's exclusion list:

1. Windows Security → Virus & threat protection → Manage settings
2. Exclusions → Add → Folder
3. Add `\\wsl.localhost\Ubuntu\` (or `\\wsl$\Ubuntu\` on older Windows)

This is optional and trades a small amount of security for WSL filesystem performance. Most users won't notice a difference either way with Homun's workload.

### First run takes a while

On first `homun gateway` invocation, Homun:
1. Creates `~/.homun/` directory structure
2. Generates TLS certs for the Web UI
3. Initializes the SQLite database and runs 53 migrations
4. Downloads an embedding model if `fastembed` is enabled

Expect 20-30 seconds before the Web UI becomes reachable. Subsequent launches are near-instant.

---

## Troubleshooting

### `localhost:8777` from Windows browser times out

Check that:
1. Homun is actually running: `wsl -d Ubuntu -u homun -- pgrep -a homun`
2. Homun is bound to `127.0.0.1` (not `0.0.0.0` or a specific interface). Check `~/.homun/config.toml` → `[web] bind = "127.0.0.1:8777"`.
3. No Windows firewall rule is blocking localhost-to-WSL traffic. This is rare but happens with some corporate security tools.

Fallback: bind Homun to `0.0.0.0:8777` and use the WSL IP directly. Find it with `wsl -d Ubuntu -- ip addr show eth0 | grep inet`.

### `sudo systemctl enable homun` fails with "Failed to connect to bus"

systemd isn't enabled in WSL. Go back to Step 3 Option B and make sure `/etc/wsl.conf` has `[boot]\nsystemd=true` and you restarted WSL with `wsl --shutdown`.

### `apt install ./homun_*.deb` fails with "adduser: command not found"

You're on a very minimal WSL image. Install the missing deps first:

```bash
sudo apt update
sudo apt install adduser ca-certificates libsqlite3-0
sudo apt install ./homun_0.1.0-1_amd64.deb
```

### Upgrade broke my vault

Shouldn't happen, but if it does: the vault is stored at `~/.homun/secrets.enc` and the master key at `~/.homun/master.key`. Both survive `apt remove`/`apt install` of a new version. Only `apt purge` wipes them. Report an issue at github.com/homunbot/homun if you see data loss.

---

## Roadmap

A **native Windows installer** (`.msi` via cargo-wix + Authenticode signing) is planned for a future release when Homun has enough traction to justify the certificate investment (~$400-600/year + HSM). Until then, the WSL path is the officially supported Windows install method.

We track this in [REALITY-AUDIT.md](./REALITY-AUDIT.md) as issue #67 — "Windows native installer deferred post-v1.0".

If you're interested in sponsoring Windows code signing for the project, [get in touch](mailto:hello@homun.dev).
