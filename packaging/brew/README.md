# Homebrew packaging

This directory contains the template for the Homebrew formula that publishes
Homun to the `homunbot/homebrew-tap` tap.

## Files

- `homun.rb.template` — formula template with `@@VERSION@@` and
  `@@SHA256_MACOS_ARM64@@` / `@@SHA256_MACOS_X64@@` placeholders substituted
  at release time by `.github/workflows/release.yml`.

## One-time manual setup (not yet done)

The Homebrew tap repository `github.com/homunbot/homebrew-tap` must be
created **manually** — Claude cannot create repos on behalf of the user.

Steps to set up the tap the first time:

1. Create a new public repo at `github.com/homunbot/homebrew-tap` (empty, no README)
2. Clone it locally
3. Create a directory `Formula/`
4. Copy the first release's rendered `homun.rb` from the `homebrew-formula`
   release artifact into `Formula/homun.rb`
5. Commit and push
6. Users can now `brew tap homunbot/tap && brew install homun`

## Automated update flow (future, not implemented yet)

Once the tap repo exists, add a step to `release.yml` that:

1. Clones `homunbot/homebrew-tap`
2. Downloads the rendered `homun.rb` from the current release artifact
3. Commits + pushes the updated formula to the tap repo

This requires a `HOMEBREW_TAP_PUSH_TOKEN` secret with contents write scope
on the tap repo. Not configured in Sprint 8 — tracked for post-v1.0.

## Why not just use the official `homebrew-core` tap?

`homebrew-core` requires:
- Open-source license approved by the Open Source Initiative
- No cloud service dependencies at runtime without opt-in
- Stable API + tagged releases for >30 days

Homun currently uses `PolyForm-Noncommercial-1.0.0` which is **not** OSI-approved,
so `homebrew-core` is not an option until the license is changed (if ever). A
self-hosted tap (`homunbot/homebrew-tap`) has none of these requirements and is
the standard path for commercial OSS projects.
