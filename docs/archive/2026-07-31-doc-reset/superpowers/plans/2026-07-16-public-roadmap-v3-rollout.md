# Public Roadmap V3 Rollout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the approved roadmap atomically across GitHub Project #1, public Issues, release evidence, the website snapshot, and the deployed Astro site without exposing a partially migrated state.

**Architecture:** Temporarily disable automatic product-data reconciliation while the old static snapshot remains live. Apply the idempotent version 3 migration, inspect the complete candidates, publish them, generate and verify the new snapshot on the implementation branch, then deploy code and data together. Re-enable reconciliation only after the live site is correct and prove the next synchronization is a no-op.

**Tech Stack:** GitHub CLI, GitHub Project V2, GitHub Issues/Releases, Node.js 22, Astro 6, Git, GitHub Actions, Coolify.

**Prerequisite:** Every task in `docs/superpowers/plans/2026-07-16-public-roadmap-v3-implementation.md` is complete and `npm run check` passes on its website branch.

**Website branch:** `fabio/public-roadmap-v3`, created in a dedicated website worktree before executing the implementation plan.

---

### Task 1: Capture the live baseline and freeze automatic synchronization

**Files:**
- Read: `/Users/fabio/Projects/Homun/website/.github/workflows/sync-product-data.yml`
- Create locally during execution: `/tmp/homun-roadmap-v2-baseline.json`
- Create locally during execution: `/tmp/homun-releases-v2-baseline.json`

- [ ] **Step 1: Verify clean execution context**

Run:

```bash
git -C /Users/fabio/Projects/Homun/website status --short --branch
gh auth status
gh project item-list 1 --owner homun-app --format json --limit 100
gh release view -R homun-app/homun-releases --json tagName,publishedAt,url
export HOMUN_GITHUB_TOKEN="$(gh auth token)"
```

Expected: authenticated account with `project`, `read:org`, and `repo` scopes; Project #1 accessible; current release visible.

- [ ] **Step 2: Preserve the checked-in last-known-good pair**

Run:

```bash
cp /Users/fabio/Projects/Homun/website/src/data/roadmap.json /tmp/homun-roadmap-v2-baseline.json
cp /Users/fabio/Projects/Homun/website/src/data/releases.json /tmp/homun-releases-v2-baseline.json
```

Expected: both files are non-empty valid JSON and the roadmap contains ten version 2 items before migration.

- [ ] **Step 3: Disable only the synchronization workflow**

Run:

```bash
gh workflow disable sync-product-data.yml -R homun-app/website
gh workflow view sync-product-data.yml -R homun-app/website
```

Expected: workflow state reports disabled. The existing website remains served from its checked-in static snapshot.

- [ ] **Step 4: Record the exact remote state in the execution log**

Record the ten current issue numbers and latest release. The verified planning baseline on 2026-07-16 was issues #2–#11 and release `v0.1.1060`; if live values differ, stop and reconcile the manifest before any write.

### Task 2: Review and apply the guarded Project migration

**Files:**
- Read: `scripts/fixtures/roadmap-v3-manifest.json`
- Execute: `scripts/roadmap-v3-rollout.mjs`

- [ ] **Step 1: Run the live dry-run**

Run:

```bash
npm run roadmap:v3-rollout -- --project-number 1 --dry-run
```

Expected: four new fields, ten issue creations, three issue transformations, seven archives, one featured program (`homun-flow`), thirteen active records, and no destructive deletion.

- [ ] **Step 2: Compare every planned mutation with the manifest**

Verify that #5 becomes Homun Mobile, #7 becomes Team Spaces & Roles, #8 becomes Voice & Meeting Capture; #2/#3/#4/#6/#9/#10/#11 receive archive reasons and supersession links; and all new issues use the exact public copy and stable slugs from the approved specification.

- [ ] **Step 3: Restate the external write scope and obtain approval**

Before apply, report the exact counts, transformed issue numbers, archived issue numbers, and release note change planned in Task 3. Do not infer approval from the earlier design approval.

- [ ] **Step 4: Apply once with the explicit guard**

Run:

```bash
npm run roadmap:v3-rollout -- --project-number 1 --apply
```

Type: `roadmap-v3`

Expected: the command re-fetches Project #1 and ends with a zero-operation follow-up plan.

- [ ] **Step 5: Prove idempotence**

Run:

```bash
npm run roadmap:v3-rollout -- --project-number 1 --dry-run
```

Expected: zero fields, issues, transformations, archives, comments, and Project field updates.

### Task 3: Attach release evidence to the consolidated Available program

**Files:**
- Create locally during execution: `/tmp/homun-v0.1.1059-notes.md`

- [ ] **Step 1: Preserve the published release body**

Run:

```bash
gh release view v0.1.1059 -R homun-app/homun-releases --json body --jq .body > /tmp/homun-v0.1.1059-notes.md
```

Expected: the file contains `Roadmap: connected-actions, model-freedom, local-computer`.

- [ ] **Step 2: Change only the Roadmap evidence line**

Replace it with:

```text
Roadmap: connected-actions, model-freedom, local-computer, operational-workspace
```

Do not alter highlights, fixes, assets, tag, publication date, or release state.

- [ ] **Step 3: Apply and verify release metadata**

Run:

```bash
gh release edit v0.1.1059 -R homun-app/homun-releases --notes-file /tmp/homun-v0.1.1059-notes.md
gh release view v0.1.1059 -R homun-app/homun-releases --json tagName,publishedAt,isDraft,isPrerelease,body,assets
```

Expected: published non-prerelease release with the four-slug Roadmap line and unchanged assets.

### Task 4: Publish candidates and generate the new snapshot on the branch

**Files:**
- Modify through synchronization: `src/data/roadmap.json`
- Modify through synchronization: `src/data/releases.json`

- [ ] **Step 1: Inspect normalized candidates before publication**

Run the synchronizer in dry-run mode while new records are in Review:

```bash
HOMUN_PROJECT_NUMBER=1 npm run sync:product-data -- --dry-run --allow-schema-upgrade
```

Expected: normalization succeeds; the last approved snapshot remains protected because version 3 records are not Published yet.

- [ ] **Step 2: Publish the reviewed version 3 records**

Use the rollout tool's publication subcommand:

```bash
npm run roadmap:v3-rollout -- --project-number 1 --publish
```

Type: `publish-v3`

Expected: thirteen active items become Published; archived legacy items remain Archived; exactly Homun Flow is featured; voting is open only on five workflow ideas and any explicitly selected Exploring program.

- [ ] **Step 3: Generate the snapshot pair locally**

Run:

```bash
HOMUN_PROJECT_NUMBER=1 npm run sync:product-data -- --write --allow-schema-upgrade
```

Expected: the branch-only preview is replaced by a schema version 3 snapshot with eight strategic programs, five workflow ideas, and real Issue URLs; releases remain ordered with `v0.1.1060` latest and `v0.1.1059` proving `operational-workspace`. Assert that no `/issues/new` URL remains before committing.

- [ ] **Step 4: Run the complete verification gate**

Run:

```bash
npm ci
npm run check
```

Expected: exit 0 for all checks. If any check fails, restore the branch-only preview from Git, keep synchronization disabled, and fix the implementation branch before continuing.

- [ ] **Step 5: Commit only the generated pair**

```bash
git add src/data/roadmap.json src/data/releases.json
git commit -m "chore: publish roadmap v3 product data"
```

### Task 5: Review, merge, deploy, and verify production

**Files:**
- No additional source files.

- [ ] **Step 1: Review the complete branch diff**

Run:

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD --check
git log --oneline origin/main..HEAD
```

Expected: only roadmap schema, synchronization, migration, page, test, documentation, redirect, and generated snapshot changes.

- [ ] **Step 2: Push and open a ready pull request**

Run:

```bash
git push -u origin fabio/public-roadmap-v3
gh pr create -R homun-app/website --base main --head fabio/public-roadmap-v3 --title "feat: publish the customer-first product roadmap" --body-file /tmp/homun-roadmap-v3-pr.md
```

The prepared PR body lists the version 3 data contract, customer-facing page changes, remote migration already applied, full verification command, and rollback procedure.

- [ ] **Step 3: Merge only after CI succeeds**

After CI succeeds and merge approval is explicit, run:

```bash
gh pr merge -R homun-app/website --squash --delete-branch
```

Confirm Coolify builds the merge commit and serves the new static snapshot.

- [ ] **Step 4: Verify the deployed routes without relying on browser cache**

Check with a cache-busting query and direct HTTP requests:

```bash
curl -fsSL 'https://homun.app/roadmap/?roadmap-v3=1' | grep -F 'AI that keeps work moving.'
curl -fsSL 'https://homun.app/roadmap/homun-flow/?roadmap-v3=1' | grep -F 'Review handoffs'
curl -fsSL 'https://homun.app/roadmap/client-work/?roadmap-v3=1' | grep -E 'Selected for pilot|Evaluating'
curl -sI 'https://homun.app/roadmap/mobile-companion/' | grep -Ei '^(HTTP|location:)'
```

Expected: new hero and detail content are present, old routes redirect, and latest release remains `v0.1.1060` or a newer actually published release.

- [ ] **Step 5: Re-enable synchronization and prove a no-op run**

Run:

```bash
gh workflow enable sync-product-data.yml -R homun-app/website
gh workflow run sync-product-data.yml -R homun-app/website
run_id="$(gh run list -R homun-app/website --workflow sync-product-data.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run_id" -R homun-app/website --exit-status
```

Expected: workflow succeeds and prints `Public product data is already current.` without creating a new commit.

### Task 6: Rollback procedure if production verification fails

**Files:**
- Restore through Git: `src/data/roadmap.json`
- Restore through Git: `src/data/releases.json`

- [ ] **Step 1: Keep automatic synchronization disabled**

Run: `gh workflow disable sync-product-data.yml -R homun-app/website`

- [ ] **Step 2: Revert the website merge commit**

Create a normal revert commit; do not reset shared history. Redeploy the revert through the ordinary Coolify path.

- [ ] **Step 3: Preserve remote history**

Leave created and transformed issues intact. Set active version 3 Project records to Review instead of deleting them. The old version 2 snapshot remains the public last-known-good state after the website revert.

- [ ] **Step 4: Diagnose before retrying**

Compare deployed HTML, generated snapshot, Project fields, and the failed check. Resume at Task 4 only after the branch passes `npm run check` again.

## Completion gate

The rollout is complete only when production displays the customer-first roadmap, all thirteen active items link to valid public Issues, legacy routes/history remain traceable, Coolify serves the intended merge commit, automatic synchronization is re-enabled, and the first reconciliation is a semantic no-op.
