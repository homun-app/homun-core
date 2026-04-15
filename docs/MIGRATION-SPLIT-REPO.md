# Migration Playbook — Split Repo (`homunbot` → `homun-app`)

> **Audience**: Fabio, the maintainer, executing manually.
> **Prerequisite**: GitHub org `homun-app` exists (already done).
> **Total time**: ~30 minutes if nothing goes wrong.
> **Reversibility**: high — every step is undoable except the final privatization.

This playbook executes the strategic decision taken in Sprint 9 to split
the Homun codebase into two repositories:

- **`homun-app/homun`** (PUBLIC) — issue tracker, GitHub Releases (binaries),
  README, docs landing, SECURITY.md, Discussions
- **`homun-app/homun-core`** (PRIVATE) — Rust source code, CI workflows,
  internal docs, sprint plans, audit findings

The decision rationale is in the Sprint 9 conversation log; this doc is
purely operational.

---

## Phase 0 — Pre-flight checklist

Before starting, verify:

- [ ] `homun-app` GitHub org exists and you have admin access
- [ ] You have a fine-grained or classic PAT with `repo` scope that can
      access **both** orgs (`homunbot` source + `homun-app` destination)
- [ ] Local working tree is clean: `git status` shows nothing uncommitted
- [ ] All Sprint 8 + Sprint 9 commits are local-only (not yet pushed) —
      if you've already pushed to `homunbot/homunbot`, you'll need to
      delete those refs after the transfer (covered in Phase 4)
- [ ] You have NOT yet tagged `v1.0.0` — the migration must happen
      **before** the first real release tag

---

## Phase 1 — Create the public repo (5 min)

1. Go to <https://github.com/organizations/homun-app/repositories/new>
2. **Name**: `homun`
3. **Description**: `Homun — your personal AI assistant. Issues, releases, docs.`
4. **Visibility**: Public
5. **Initialize**: ☑ README, ☑ `.gitignore` (None template)
6. **License**: MIT (for templates and docs only — the actual code is
   PolyForm-Noncommercial in the private repo)
7. Click **Create repository**

Then:

```bash
# Clone locally to add issue templates etc.
gh repo clone homun-app/homun /tmp/homun-public
cd /tmp/homun-public

# Create the standard structure
mkdir -p .github/ISSUE_TEMPLATE
```

Add these files (templates below — copy verbatim):

- `.github/ISSUE_TEMPLATE/bug.md`
- `.github/ISSUE_TEMPLATE/feature.md`
- `.github/ISSUE_TEMPLATE/crash.md`
- `SECURITY.md`
- `README.md` (overwrite the auto-generated one)

Commit and push:

```bash
git add .
git commit -m "chore: initial public repo scaffolding"
git push
```

---

## Phase 2 — Transfer the code repo (5 min)

This is the **risky** step. GitHub's transfer is atomic and preserves
issues/PRs/stars/forks, but you cannot easily reverse it once executed.

1. Go to <https://github.com/homunbot/homunbot/settings>
2. Scroll to the bottom → **Danger Zone** → **Transfer ownership**
3. New owner: `homun-app`
4. New repository name: `homun-core`
5. Type the confirmation string and click **I understand, transfer this repository**
6. Wait ~10 seconds for GitHub to propagate

Verify the transfer succeeded:

```bash
gh repo view homun-app/homun-core
```

Update your local clone's remote:

```bash
cd ~/Projects/Homunbot/homunbot
git remote set-url origin https://github.com/homun-app/homun-core.git
git fetch
```

---

## Phase 3 — Privatize the code repo (1 min)

1. Go to <https://github.com/homun-app/homun-core/settings>
2. Scroll to **Danger Zone** → **Change repository visibility**
3. **Make private** → confirm

⚠️ **One-way door**: this is the moment after which you cannot easily
go back to public without a fresh repo. Triple-check that:

- The public `homun-app/homun` is created and can receive issues
- All Sprint 9 commits are present in the private repo
- The local working tree has no uncommitted secrets (`.env`, certs, etc.)

---

## Phase 4 — Update Cargo.toml + dependent repos (10 min)

Update the `repository` field in `Cargo.toml`:

```toml
[package]
repository = "https://github.com/homun-app/homun"  # Public landing page
```

The `wa-rs` fork dependency also needs to move. From the maintainer's local
working tree:

```bash
# 1. Transfer homunbot/wa-rs to homun-app/wa-rs (same flow as Phase 2)
# 2. Update Cargo.toml dep:
```

```toml
[dependencies]
wa-rs = { git = "https://github.com/homun-app/wa-rs", rev = "..." }
```

(Keep the same `rev` — only the URL changes.)

The Homebrew tap also needs to move:

```bash
# Transfer homunbot/homebrew-tap → homun-app/homebrew-tap
# Update packaging/brew/README.md to reference the new tap location
```

Then commit + push to the **private** repo:

```bash
git add Cargo.toml packaging/brew/README.md
git commit -m "chore: update repo URLs to homun-app org"
git push
```

---

## Phase 5 — Configure CI cross-repo publish (10 min)

The `.github/workflows/release.yml` from Sprint 8 currently publishes to
`${{ github.repository }}` which after the transfer is `homun-app/homun-core`
(private). We need it to publish releases to `homun-app/homun` (public)
instead, so Homebrew formula + apt sources + the update checker can
download the binaries.

### Step 5.1 — Create a cross-repo PAT

1. Go to <https://github.com/settings/tokens?type=beta>
2. Create a new fine-grained PAT
3. **Resource owner**: `homun-app`
4. **Repository access**: select repositories → `homun-app/homun`
5. **Permissions**: Repository → Contents (Read+Write), Releases (Read+Write)
6. Generate, copy the token (you will only see it once)

### Step 5.2 — Add the token as a secret on the private repo

1. Go to <https://github.com/homun-app/homun-core/settings/secrets/actions>
2. **New repository secret**
3. Name: `PUBLIC_REPO_TOKEN`
4. Value: paste the PAT
5. Save

### Step 5.3 — Update release.yml

Find the `release` job in `.github/workflows/release.yml` and add the
publish step:

```yaml
- name: Publish to public repo
  env:
    GH_TOKEN: ${{ secrets.PUBLIC_REPO_TOKEN }}
  run: |
    gh release create "${GITHUB_REF_NAME}" \
      --repo homun-app/homun \
      --title "${GITHUB_REF_NAME}" \
      --notes-file release-notes.md \
      dist/*.deb dist/*.rpm dist/*.dmg dist/*.sha256
```

Commit and push:

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): publish to homun-app/homun public repo"
git push
```

---

## Phase 6 — Re-add Apple Code Signing secrets (5 min)

The 6 GitHub Secrets configured (or planned) on `homunbot/homunbot` need
to be re-added to `homun-app/homun-core` since secrets are scoped per repo
and don't transfer:

1. Go to <https://github.com/homun-app/homun-core/settings/secrets/actions>
2. Add (one by one):
   - `APPLE_CERTIFICATE_BASE64`
   - `APPLE_CERTIFICATE_PASSWORD`
   - `APPLE_TEAM_ID`
   - `APPLE_DEVELOPER_ID_APPLICATION`
   - `APPLE_API_KEY_ID`
   - `APPLE_API_KEY_BASE64`
3. (See `docs/INSTALLER-SIGNING-SETUP.md` for the values.)

If you haven't yet purchased an Apple Developer account, this phase can
be deferred — the CI gracefully degrades to unsigned builds.

---

## Phase 7 — Flip the Homun config (1 min)

In `~/.homun/config.toml` (or via the dashboard):

```toml
[support]
public_repo = "homun-app/homun"  # already the default in Sprint 9
crash_submit_github = true       # enable now that the public repo exists
```

Restart Homun. The crash report UI will now show "Open GitHub Issue" as
an active button.

---

## Phase 8 — Verify end-to-end (5 min)

- [ ] Visit <https://github.com/homun-app/homun> → see README, issue templates
- [ ] Visit <https://github.com/homun-app/homun-core> → must be private (404 unless logged in as you)
- [ ] Push a test tag (e.g. `v0.1.1-test`) to `homun-core` → CI publishes the release on `homun-app/homun`
- [ ] Verify `https://api.github.com/repos/homun-app/homun/releases/latest` returns the test release
- [ ] Open Homun dashboard → topbar should show no update chip (current = latest)
- [ ] Tag a fake higher version like `v0.99.0` for a moment to test the chip appears, then delete the tag + release
- [ ] Trigger a controlled panic (e.g. `kill -SEGV` the process — though that's a SIGSEGV not a Rust panic; better: temporarily add `panic!("test")` in an obvious code path) → verify a crash file appears in `~/.homun/crashes/` and the dashboard `/v1/crashes` lists it

---

## Phase 9 — Cleanup (1 min)

If the test tag worked:

```bash
# Delete the test tag locally and remotely
git tag -d v0.1.1-test
gh api -X DELETE repos/homun-app/homun-core/git/refs/tags/v0.1.1-test
gh api -X DELETE repos/homun-app/homun/releases/tags/v0.1.1-test
```

---

## Rollback procedures

| Phase | Reversible? | How |
|---|---|---|
| 1 (create public) | yes | Delete the public repo from settings |
| 2 (transfer) | yes within 60s | Transfer back: settings → transfer ownership → `homunbot` |
| 3 (privatize) | yes but messy | Make public again (issue links break for forks made during the private window) |
| 4 (Cargo.toml) | yes | git revert |
| 5 (CI workflow) | yes | git revert |
| 6 (secrets) | yes | Delete from settings |
| 7 (config) | yes | Edit `~/.homun/config.toml` |

---

## Templates

### `SECURITY.md`

```markdown
# Security policy

## Reporting vulnerabilities

**Do not** open public issues for security vulnerabilities. Instead:

- Email: `security@homun.app` (PGP key: TBD)
- Or use [GitHub Security Advisories](https://github.com/homun-app/homun/security/advisories/new)

We aim to respond within 5 business days. Coordinated disclosure is
preferred — give us a reasonable window to ship a fix before publishing
details.

## Supported versions

Only the latest released version receives security updates. Pre-releases
and prerelease tags are unsupported.
```

### `.github/ISSUE_TEMPLATE/bug.md`

```markdown
---
name: Bug report
about: Something broke or behaves unexpectedly
labels: bug
---

**Description**


**Steps to reproduce**

1.
2.
3.

**Expected**


**Actual**


**Version + OS**

- Homun version: `homun --version`
- OS: macOS / Ubuntu / Fedora / WSL
- Installer: brew / .deb / .rpm / .dmg / from source

**Logs / trace ID**

Paste the trace ID from the failed request (visible in dashboard timeline).
```

### `.github/ISSUE_TEMPLATE/crash.md`

```markdown
---
name: Crash report
about: Homun panicked or crashed
labels: crash
---

**Pasted from Homun crash reporter**

(The crash reporter generates a pre-filled issue with all fields below.
If you arrived here manually, paste the JSON from `~/.homun/crashes/`.)

```

---

## Done

When all phases pass, you are running the split-repo architecture. The
old `homunbot/homunbot` URL is now `homun-app/homun-core` (private), and
all user-facing surfaces (issue tracker, releases, docs, brew tap, update
checker) point at the new `homun-app/homun` public repo.
