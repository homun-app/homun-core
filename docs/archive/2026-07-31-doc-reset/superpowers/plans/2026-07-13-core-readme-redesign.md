# Homun Core README Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the developer-first `homun-core` README with a concise product-first introduction that exposes downloads, website, documentation, and roadmap before technical details.

**Architecture:** Keep the README as a single GitHub-rendered Markdown entry point. Reuse the public website's positioning and a stable raw image from the website repository, while retaining a compact component map, verified development commands, security guidance, and licensing details.

**Tech Stack:** GitHub-flavored Markdown, repository shell checks, existing Make targets.

---

### Task 1: Rewrite the product introduction

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the opening**

Use the Homun wordmark, the headline `Your work. Your models. Your system.`, and a two-sentence description of Homun as a model-independent AI workspace for projects, memory, tools, and permissions.

- [ ] **Step 2: Add immediate actions**

Add macOS, Windows, Linux, and all-releases links pointing to `https://github.com/homun-app/homun-releases/releases/latest` or the release history. Add website, documentation, and roadmap links before the feature overview.

- [ ] **Step 3: Add the primary product image**

Reference the stable source image:

```markdown
![Homun desktop workspace](https://raw.githubusercontent.com/homun-app/website/main/src/assets/screenshots/chat.png)
```

- [ ] **Step 4: Add concise product reasons and examples**

Describe model freedom, continuing projects, and controlled connected action. Include development, deliverables, channels, scheduled/event automations, local-computer tools, and persistent memory as concrete examples.

- [ ] **Step 5: State the account boundary**

State explicitly that downloading and using Homun's core local capabilities does not require an account, while avoiding promises about future online services.

### Task 2: Preserve and tighten contributor information

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Retain the component map**

Keep the current table for `apps/desktop`, `crates/desktop-gateway`, `crates/*`, and the isolated runtimes. Link architecture details to `https://homun.app/reference/architecture/`.

- [ ] **Step 2: Verify development commands**

Check root scripts and Make targets before keeping these commands:

```bash
npm install
npm run dev
npm run electron:dev
npm run dist
make test
```

Remove any command not supported by current repository configuration.

- [ ] **Step 3: Update documentation links**

Replace every `docs.homun.app` URL with its corresponding `https://homun.app/...` URL. Preserve the FSL 1.1 license explanation and local security link.

### Task 3: Validate and publish

**Files:**
- Test: `README.md`

- [ ] **Step 1: Check the content contract**

Run:

```bash
rg -n 'Your work\. Your models\. Your system\.|releases/latest|https://homun.app/docs|https://homun.app/roadmap|cloud|open-source|local models|account' README.md
```

Expected: every required product and navigation concept is present.

- [ ] **Step 2: Check retired links and whitespace**

Run:

```bash
! rg -n 'docs\.homun\.app' README.md
git diff --check
```

Expected: no retired documentation domain and no whitespace errors.

- [ ] **Step 3: Verify referenced URLs**

Request the website, docs, roadmap, latest-release page, release history, and raw screenshot URL. Expected: successful HTTP responses after redirects.

- [ ] **Step 4: Commit only intended files**

Stage `README.md` and this plan. Do not stage `homun-tablet-full.png`. Commit with:

```bash
git commit -m "docs: rewrite core README for users"
```

- [ ] **Step 5: Push the current branch**

Run `git push origin main` and verify that `origin/main` points to the new commit.
