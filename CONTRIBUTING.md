# Contributing to Homun

Thanks for your interest in Homun! This document explains how to report bugs, propose features, request security audit access, and understand the licensing model that shapes how contributions work here.

---

## License model — please read first

Homun is published under the [**PolyForm Noncommercial License 1.0.0**](./LICENSE). This means:

- ✅ **Free to use** for personal and non-commercial purposes
- ✅ **Free to inspect and audit** by security researchers (see below for access)
- ❌ **Not open source in the OSI sense** — the Rust source code lives in the private `homun-app/homun-core` repository
- ❌ **Public pull requests to the source are not accepted** — because there is no public source to branch from

This is deliberate. Homun's license is not OSI-approved, which means projects like Homebrew-core, `homebrew-tap`'s official process, or open-source package registries won't distribute the binary as-is. The public `homun-app/homun` repository exists for what IS public: **issues, discussions, releases, documentation, and crash reports**.

If this matches your interest, read on.

---

## What you CAN contribute (welcome!)

### 1. Report bugs

Use the issue tracker on [`homun-app/homun`](https://github.com/homun-app/homun/issues). Issue templates guide you through the required fields:

- **What you expected** to happen
- **What actually happened**
- **Steps to reproduce** (minimal, ideally)
- **Version** (`homun --version`)
- **OS and installer** (macOS .dmg, brew, Ubuntu .deb, Fedora .rpm, WSL)
- **Trace ID** — if the failure was from the web UI, the trace ID is visible in the dashboard timeline. Paste it so the maintainer can grep the logs.

### 2. Propose features

Use [GitHub Discussions](https://github.com/homun-app/homun/discussions) first. Discuss the **problem** before the **solution** — this is a single-maintainer project and scope is deliberately narrow (single-user, privacy-first, local-first).

Good feature proposals:
- Describe a real user pain point
- Explain why existing tools/skills/MCP servers don't solve it
- Accept that the answer might be "that's out of scope"

Bad feature proposals:
- "Add AI model X" (just works via OpenAI-compatible provider)
- "Add GUI for Y" (config already works)
- "Rewrite Z in language W" (no)

If the discussion lands on "yes, this is in scope", the maintainer opens an issue and triages it into a sprint.

### 3. Submit crash reports

Homun v1.0 ships with a panic handler that writes redacted crash files to `~/.homun/crashes/`. The web dashboard at `/crashes` shows them and offers 4 submission channels:

1. **Clipboard** — copies a markdown-formatted report you can paste anywhere
2. **Download** — saves the JSON file for manual inspection
3. **GitHub issue (pre-filled)** — opens a new issue on `homun-app/homun` with title, labels, body pre-populated. You review and click "Submit".
4. **Email (pre-filled)** — opens your mail client with the report as the body

The maintainer triages crash reports weekly. High-frequency crashes trigger hotfix releases.

### 4. Improve documentation

Documentation in the **public** `homun-app/homun` repository (not the private source repo) accepts pull requests:
- `README.md`
- `CONTRIBUTING.md` (this file)
- `SECURITY.md`
- Issue templates in `.github/ISSUE_TEMPLATE/`

These are the user-visible files. Typos, clarifications, and install walkthrough improvements are all welcome.

---

## What you CANNOT contribute (sorry)

### Public source code PRs

Because the source lives in the private `homun-app/homun-core` repo, there is nothing to branch from publicly. If you submit a "here's a patch" issue, the maintainer will thank you and either apply it manually (with credit) or decline with a reason. Treat it like a suggestion, not a PR workflow.

### Direct binary distribution

Do not redistribute the `.deb`, `.rpm`, `.dmg`, or compiled binary without the license terms. The PolyForm license is about **use**, not redistribution of built artifacts.

---

## Security vulnerability reporting

**Do not open public issues for security vulnerabilities.** Use one of these channels:

- **Email**: `security@homun.app` (PGP key: TBD in v1.0.x)
- **GitHub Security Advisories**: [`homun-app/homun/security/advisories/new`](https://github.com/homun-app/homun/security/advisories/new)

The maintainer aims to respond within **5 business days**. Coordinated disclosure is preferred — please give a reasonable window (30 days default) to ship a fix before publishing details.

### Security audit access

If you are a security researcher or organization doing a paid/independent audit, you can request **read-only access** to the private `homun-app/homun-core` repository. Email `security@homun.app` with:

- Who you are (affiliation, prior audits)
- Scope of the audit
- Timeline
- Willingness to follow coordinated disclosure

Access is granted on a case-by-case basis. Your findings are welcome regardless of whether a bounty program exists at the time.

### Existing audit surface

Sprint 2-6 of the Homun production roadmap included **6 internal code audits** covering 16/16 feature domains, ~41K LOC reviewed, 47 bugs tracked. The findings are documented in `docs/REALITY-AUDIT.md` in the private repo. Security researchers who get audit access can see the full findings including 5 🔴 critical bugs with known workarounds (all documented in [`CHANGELOG.md`](./CHANGELOG.md) "Known issues").

---

## Code of conduct

Be kind. Be concrete. Assume good faith.

- No harassment, personal attacks, or discriminatory language — in issues, discussions, crash reports, or email
- Technical disagreements welcome; ad hominem not welcome
- The maintainer reserves the right to lock or delete disruptive discussions
- Violations: first warning, second temporary block, third permanent

If you witness misconduct, email `conduct@homun.app`.

---

## Release cadence and how to influence it

- **Hotfixes** (`v1.0.x`) ship on-demand for security issues or crash-for-all-users regressions
- **Minor releases** (`v1.x.0`) ship every 4-6 weeks with incremental features
- **Major releases** (`v2.0.0`) ship every 12-18 months

Your **bug reports** and **crash reports** directly feed hotfix prioritization. Your **feature discussions** feed minor release scope. Major releases are strategic.

For the record: the maintainer is **one person**. Response times can vary. The goal is to ship quality, not velocity.

---

## Thank you

If you're reading this far — thanks. A single-maintainer privacy-first local-first AI assistant is an unusual project, and the community of issue reporters, crash submitters, and early users is the reason v1.0 exists. Every well-written bug report saves hours of debugging. Keep them coming.

— Fabio ([homun.app](https://homun.app))
