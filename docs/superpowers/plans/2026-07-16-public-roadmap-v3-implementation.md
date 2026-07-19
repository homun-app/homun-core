# Public Roadmap V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current feature-led roadmap with a customer-first product roadmap that separates committed product programs from official vertical workflow ideas and derives progress from named milestones.

**Architecture:** GitHub Issues remain the public content source and GitHub Project #1 remains the publication and ordering source. The synchronizer emits a version 3 static snapshot; Astro renders strategic programs and workflow ideas as separate projections. The rollout keeps the existing version 2 website live until the new Project data, snapshot, pages, and redirects have passed validation together.

**Tech Stack:** Astro 6, TypeScript, Node.js 22, GitHub GraphQL/REST through `gh`, static JSON snapshots, Docker/nginx.

**Repository:** `/Users/fabio/Projects/Homun/website`

**Design source:** `/Users/fabio/Projects/Homun/app/docs/superpowers/specs/2026-07-16-public-product-roadmap-design.md`

---

## File map

- Create `scripts/fixtures/roadmap-v3-project.json`: representative Project response for the new schema.
- Create `scripts/fixtures/roadmap-v3-manifest.json`: exact desired public programs, workflow ideas, and legacy migration mapping.
- Create `scripts/fixtures/roadmap-v3-preview.json`: deterministic branch-only public snapshot used before real Issue URLs exist.
- Create `scripts/fixtures/releases-v3-preview.json`: deterministic branch-only release evidence for the Available program.
- Create `scripts/lib/roadmap-schema-upgrade.mjs`: explicit one-time version 2 to version 3 publication gate.
- Create `scripts/roadmap-v3-rollout.mjs`: idempotent Project/Issue migration planner and guarded executor.
- Create `scripts/check-roadmap-v3-rollout.mjs`: offline migration contract tests.
- Delete `scripts/bootstrap-roadmap-project.mjs` and `scripts/check-roadmap-project-bootstrap.mjs`: superseded one-time version 2 bootstrap.
- Delete `scripts/roadmap-project-rollout.mjs` and `scripts/check-roadmap-project-rollout.mjs`: superseded version 2 rollout.
- Delete `scripts/fixtures/roadmap-project-inventory.json`: fixture owned only by the retired rollout.
- Create `src/components/roadmap/ProductJourney.astro`: four-part `Remember -> Coordinate -> Connect -> Adapt` story.
- Create `src/components/roadmap/WorkflowIdeas.astro`: official workflow evaluation section.
- Create `src/components/roadmap/ProgramMilestones.astro`: named milestone presentation.
- Modify `scripts/lib/github-product-data.mjs`: normalize and validate schema version 3.
- Modify `scripts/lib/publication-policy.mjs`: preserve approved version 3 records during Review.
- Modify `scripts/sync-product-data.mjs`: require and persist version 3 snapshots.
- Modify `src/lib/product-data.ts`: expose strategic programs and workflow ideas separately.
- Modify `src/lib/roadmap-presentation.mjs`: derive voting and milestone presentation.
- Modify `src/components/roadmap/FeaturedProject.astro`: present Homun Flow without percentages.
- Modify `src/components/roadmap/RoadmapJourney.astro`: render strategic commitment bands only.
- Modify `src/components/roadmap/RoadmapParticipation.astro`: allow votes only for eligible records.
- Delete `src/components/roadmap/CommunityIdeas.astro`: replace the generic proposal card with the official workflow section.
- Modify `src/pages/roadmap/index.astro`: install the approved customer-first information architecture.
- Modify `src/pages/roadmap/[slug].astro`: render the version 3 card contract.
- Modify `src/components/Ecosystem.astro`: align homepage counts and copy with the new roadmap.
- Modify `astro.config.mjs`: preserve old roadmap URLs with explicit redirects.
- Modify `scripts/check-product-data.mjs`, `scripts/check-roadmap-pages.mjs`, `scripts/check-homepage.mjs`, and `scripts/check-container-runtime.mjs`: verify the new contracts.
- Modify `docs/roadmap-operations.md`: document version 3 editorial and recovery procedures.
- Modify `package.json`: register the version 3 rollout test and commands.

## Public data contract

The version 3 public item shape is:

```ts
export type RoadmapStage = "available" | "building" | "next" | "exploring";
export type RoadmapItemType = "strategic_program" | "workflow_idea";
export type EvaluationState = "evaluating" | "selected_for_pilot" | "removed";

export interface RoadmapMilestone {
	title: string;
	completed: boolean;
}

export interface RoadmapItem {
	slug: string;
	title: string;
	itemType: RoadmapItemType;
	stage: RoadmapStage;
	evaluationState: EvaluationState | null;
	area: string;
	outcome: string;
	whyNow: string;
	firstRelease: string[];
	milestones: RoadmapMilestone[];
	notIncludedYet: string[];
	strategicRole: string | null;
	featured: boolean;
	publicUpdate: string | null;
	publicUpdateDate: string | null;
	voting: "open" | "closed";
	order: number;
	githubUrl: string;
	issueNumber: number | null;
	votes: number;
	underReview: boolean;
}
```

Issue bodies use these exact sections:

```markdown
<!-- roadmap-slug: homun-flow -->

Turn recurring work into a visible process that people and Homun can complete, review and hand over together.

## Why now

Small teams need reliable process continuity without specialist automation staff.

## First release

- Processes with explicit activities and dependencies
- A lightweight board derived from canonical process state

## Milestones

- [x] Durable task and approval foundations
- [ ] Visible process board

## Not included yet

- General third-party workflow development

## Strategic role

The reusable foundation for every official business workflow developed next.
```

The first paragraph is `outcome`. Task-list checkboxes under `Milestones` are the only progress source.

### Task 0: Create the approved manifest and a branch-only preview snapshot

**Files:**
- Create: `scripts/fixtures/roadmap-v3-manifest.json`
- Create: `scripts/fixtures/roadmap-v3-preview.json`
- Create: `scripts/fixtures/releases-v3-preview.json`
- Modify: `src/data/roadmap.json`
- Modify: `src/data/releases.json`

- [ ] **Step 1: Encode the complete approved inventory**

Create thirteen manifest records using the titles, outcomes, first-release boundaries, milestones, and strategic roles from the approved design. Use orders `10` through `80` for the eight strategic programs and `110` through `150` for the five workflow ideas. Use `2026-07-16` as the initial stable public update date.

The manifest must also contain this exact legacy mapping:

```json
{
	"transform": {
		"5": "homun-mobile",
		"7": "team-spaces-roles",
		"8": "voice-meeting-capture"
	},
	"archive": {
		"2": ["homun-flow", "adaptive-company-intelligence"],
		"3": ["client-work", "sales-operations", "content-marketing", "internal-operations", "customer-support", "developer-platform"],
		"4": ["homun-flow"],
		"6": [],
		"9": ["operational-workspace"],
		"10": ["operational-workspace"],
		"11": ["operational-workspace"]
	}
}
```

- [ ] **Step 2: Create the deterministic preview**

Generate a schema version 3 public snapshot from the manifest. Reused issues use their real #5/#7/#8 URLs; new records use `https://github.com/homun-app/homun/issues/new?template=roadmap-idea.yml`, `issueNumber: null`, and `votes: 0`. Copy the current release snapshot into `releases-v3-preview.json` and add `operational-workspace` to `v0.1.1059.projectSlugs`. Both previews are valid for local rendering but forbidden from reaching `main`.

- [ ] **Step 3: Install the preview in the implementation branch**

Run:

```bash
cp scripts/fixtures/roadmap-v3-preview.json src/data/roadmap.json
cp scripts/fixtures/releases-v3-preview.json src/data/releases.json
```

Expected: the branch contains eight strategic programs, five workflow ideas, exactly one featured record, no arbitrary progress field, and published release evidence for the Available program.

- [ ] **Step 4: Commit**

```bash
git add scripts/fixtures/roadmap-v3-manifest.json scripts/fixtures/roadmap-v3-preview.json scripts/fixtures/releases-v3-preview.json src/data/roadmap.json src/data/releases.json
git commit -m "docs: encode the approved roadmap v3 inventory"
```

### Task 1: Lock the version 3 normalizer contract

**Files:**
- Create: `scripts/fixtures/roadmap-v3-project.json`
- Modify: `scripts/check-product-data.mjs`
- Modify: `scripts/lib/github-product-data.mjs`

- [ ] **Step 1: Add failing normalization assertions**

Add a version 3 fixture containing one strategic program and one workflow idea, then assert:

```js
const normalizedV3 = normalizeProject(roadmapV3Fixture);
const flow = normalizedV3.candidates.find(({ slug }) => slug === "homun-flow");
const clientWork = normalizedV3.candidates.find(({ slug }) => slug === "client-work");

assert.equal(normalizedV3.schemaVersion, 3);
assert.equal(flow.itemType, "strategic_program");
assert.equal(flow.stage, "building");
assert.deepEqual(flow.milestones, [
	{ title: "Durable task and approval foundations", completed: true },
	{ title: "Visible process board", completed: false },
]);
assert.equal(clientWork.itemType, "workflow_idea");
assert.equal(clientWork.evaluationState, "evaluating");
assert.equal(clientWork.voting, "open");
```

- [ ] **Step 2: Run the contract and verify the old normalizer fails**

Run: `npm run test:product-data`

Expected: FAIL because `Roadmap stage`, `Item type`, `Evaluation status`, and milestone task lists are not normalized.

- [ ] **Step 3: Implement fixed maps and Markdown parsers**

Replace the legacy public status map and add strict parsers:

```js
export const ROADMAP_STAGES = new Map([
	["Available", "available"],
	["Building now", "building"],
	["Up next", "next"],
	["Exploring", "exploring"],
]);

export const ITEM_TYPES = new Map([
	["Strategic program", "strategic_program"],
	["Workflow idea", "workflow_idea"],
]);

export const EVALUATION_STATES = new Map([
	["Evaluating", "evaluating"],
	["Selected for pilot", "selected_for_pilot"],
	["Removed", "removed"],
]);

function taskList(value = "") {
	return value.split("\n").map((line) => {
		const match = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
		return match ? { title: match[2].trim(), completed: match[1].toLowerCase() === "x" } : null;
	}).filter(Boolean);
}
```

`normalizeProjectNode` must read `Roadmap stage`, `Item type`, `Evaluation status`, and `Public area`; parse `Why now`, `First release`, `Milestones`, `Not included yet`, and `Strategic role`; and stop emitting `status`, `description`, `capabilities`, `progress`, and `targetRelease`.

- [ ] **Step 4: Add invalid-shape coverage**

Assert rejection for an unknown stage, missing item type, strategic program with an evaluation state, workflow idea without an evaluation state, non-Building featured item, open voting on an Available/Building/Up-next strategic program, malformed milestone task syntax, a Building program with zero milestones, and an Available program without evidence in a published release.

- [ ] **Step 5: Run the data contract**

Run: `npm run test:product-data`

Expected: PASS with `Product data contract passed`.

- [ ] **Step 6: Commit**

```bash
git add scripts/fixtures/roadmap-v3-project.json scripts/check-product-data.mjs scripts/lib/github-product-data.mjs
git commit -m "feat: define roadmap v3 data contract"
```

### Task 2: Upgrade publication and snapshot safety

**Files:**
- Create: `scripts/lib/roadmap-schema-upgrade.mjs`
- Modify: `scripts/lib/publication-policy.mjs`
- Modify: `scripts/lib/snapshot-store.mjs`
- Modify: `scripts/sync-product-data.mjs`
- Modify: `scripts/check-product-data.mjs`

- [ ] **Step 1: Add failing publication assertions**

Add tests proving that Review preserves the entire last approved version 3 item, Published replaces it, Archived removes it, a new Review item stays hidden, and timestamp-only fetches remain semantic no-ops. Also prove that a version 2 to version 3 transition fails unless `--allow-schema-upgrade` is supplied explicitly.

```js
assert.deepEqual(reviewed.items[0].milestones, previous.items[0].milestones);
assert.equal(reviewed.items[0].underReview, true);
assert.equal(published.items[0].underReview, false);
assert.equal(archived.items.some(({ slug }) => slug === "homun-flow"), false);
assert.equal(hasSemanticChanges(currentPair, timestampOnlyPair), false);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run test:product-data`

Expected: FAIL because the publication policy clones only legacy `capabilities` and emits schema version 2.

- [ ] **Step 3: Implement version 3 cloning and public projection**

Use explicit deep clones:

```js
function cloneApprovedRecord(record) {
	return {
		...record,
		firstRelease: [...record.firstRelease],
		milestones: record.milestones.map((milestone) => ({ ...milestone })),
		notIncludedYet: [...record.notIncludedYet],
	};
}
```

`publicRecord` must whitelist only the public version 3 fields and `applyPublicationPolicy` must return `schemaVersion: 3`.

Implement `upgradePublishedRoadmap(previousV2, candidates, manifest)` so the one-time upgrade succeeds only when every manifest slug is present, every active candidate is Published, no unexpected Published slug exists, and the result contains eight strategic programs plus five workflow ideas. The routine publication policy must never call this function implicitly.

- [ ] **Step 4: Keep the last-known-good replacement rules**

Update schema checks from version 2 to version 3 while retaining atomic pair writes, rollback journal recovery, empty-snapshot refusal, and operational timestamp stripping. Add `--allow-schema-upgrade` to `parseSyncArgs`; permit it in dry-run and write modes, reject its combination with `--allow-empty`, and keep it absent from the scheduled workflow.

- [ ] **Step 5: Run the contract**

Run: `npm run test:product-data`

Expected: PASS, including Review, Archived, empty candidate, recovery, and semantic no-op cases.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/roadmap-schema-upgrade.mjs scripts/lib/publication-policy.mjs scripts/lib/snapshot-store.mjs scripts/sync-product-data.mjs scripts/check-product-data.mjs
git commit -m "feat: publish roadmap v3 snapshots safely"
```

### Task 3: Expose separate product projections to Astro

**Files:**
- Modify: `src/lib/product-data.ts`
- Modify: `src/lib/roadmap-presentation.mjs`
- Modify: `scripts/check-roadmap-pages.mjs`

- [ ] **Step 1: Add failing projection tests**

Assert that only strategic programs enter the commitment bands, only workflow ideas enter evaluation, Homun Flow is featured, and voting is limited correctly.

```js
assert.deepEqual(strategicPrograms.map(({ slug }) => slug), [
	"operational-workspace", "homun-flow", "team-spaces-roles", "homun-mobile",
	"more-ways-to-reach-homun", "adaptive-company-intelligence",
	"voice-meeting-capture", "developer-platform",
]);
assert.equal(workflowIdeas.length, 5);
assert.equal(featuredProject.slug, "homun-flow");
assert.equal(roadmapPresentation(clientWork).canVote, true);
assert.equal(roadmapPresentation(homunFlow).canVote, false);
```

- [ ] **Step 2: Run the roadmap test and verify failure**

Run: `npm run build && npm run test:roadmap`

Expected: FAIL because the TypeScript and presentation layers still depend on legacy statuses and progress.

- [ ] **Step 3: Implement typed projections**

Export:

```ts
export const strategicPrograms = roadmapItems.filter((item) => item.itemType === "strategic_program");
export const workflowIdeas = roadmapItems.filter((item) => item.itemType === "workflow_idea");
export const featuredProject = selectFeaturedProject(strategicPrograms);
export function programsByStage(stage: RoadmapStage) {
	return strategicPrograms.filter((item) => item.stage === stage);
}
```

`roadmapPresentation` may return `canVote: true` only when the GitHub Issue URL is canonical, voting is open, and the record is a workflow idea or an Exploring strategic program.

- [ ] **Step 4: Run type and roadmap checks**

Run: `npm run build && npm run test:roadmap`

Expected: the data projections pass; page-copy assertions may still fail until Tasks 4–7.

- [ ] **Step 5: Commit**

```bash
git add src/lib/product-data.ts src/lib/roadmap-presentation.mjs scripts/check-roadmap-pages.mjs
git commit -m "feat: separate roadmap programs from workflow ideas"
```

### Task 4: Build the customer-first roadmap composition

**Files:**
- Create: `src/components/roadmap/ProductJourney.astro`
- Create: `src/components/roadmap/ProgramMilestones.astro`
- Create: `src/components/roadmap/WorkflowIdeas.astro`
- Modify: `src/components/roadmap/RoadmapJourney.astro`
- Delete: `src/components/roadmap/CommunityIdeas.astro`
- Modify: `scripts/check-roadmap-pages.mjs`

- [ ] **Step 1: Add failing rendered-copy assertions**

Require the exact journey and section boundaries:

```js
for (const required of [
	"Remember", "Coordinate", "Connect", "Adapt",
	"Available today", "Building now", "Up next", "Exploring",
	"Business workflows we are evaluating",
	"Client Work", "Sales Operations", "Content & Marketing",
	"Internal Operations", "Customer Support",
]) assert.ok(roadmapText.includes(required), `Roadmap missing: ${required}`);

assert.ok(!roadmapText.match(/\d+% complete/), "Roadmap exposes arbitrary progress percentages");
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run build && npm run test:roadmap`

Expected: FAIL on the new customer journey, workflow section, and percentage prohibition.

- [ ] **Step 3: Implement the three new components**

`ProductJourney.astro` renders four concise stages:

```ts
const stages = [
	{ label: "Remember", text: "Keep projects, decisions and working context continuous." },
	{ label: "Coordinate", text: "Turn recurring work into visible, reviewable processes." },
	{ label: "Connect", text: "Bring people, channels and tools into the same governed flow." },
	{ label: "Adapt", text: "Improve knowledge and behavior from measured company work." },
];
```

`ProgramMilestones.astro` renders named milestone states and `WorkflowIdeas.astro` renders evaluation badges, votes, outcome copy, and exactly one structured proposal link.

- [ ] **Step 4: Rewrite `RoadmapJourney.astro`**

Render strategic programs only in this order:

```ts
const stages = [
	{ stage: "available", label: "Available today" },
	{ stage: "building", label: "Building now" },
	{ stage: "next", label: "Up next" },
	{ stage: "exploring", label: "Exploring" },
];
```

Keep area filters scoped to strategic cards and remove all width styles derived from numeric progress.

- [ ] **Step 5: Run the roadmap tests**

Run: `npm run build && npm run test:roadmap`

Expected: PASS for section order, workflow separation, filters, links, and absence of percentages.

- [ ] **Step 6: Commit**

```bash
git add src/components/roadmap/ProductJourney.astro src/components/roadmap/ProgramMilestones.astro src/components/roadmap/WorkflowIdeas.astro src/components/roadmap/RoadmapJourney.astro src/components/roadmap/CommunityIdeas.astro scripts/check-roadmap-pages.mjs
git commit -m "feat: present the roadmap as a product journey"
```

### Task 5: Rewrite the featured program and detail pages

**Files:**
- Modify: `src/components/roadmap/FeaturedProject.astro`
- Modify: `src/components/roadmap/RoadmapParticipation.astro`
- Modify: `src/pages/roadmap/[slug].astro`
- Modify: `scripts/check-roadmap-pages.mjs`

- [ ] **Step 1: Add failing Flow and detail-page assertions**

Require `Homun Flow`, `Process foundation`, `Review handoffs`, `Connected execution`, `First usable release`, `Why now`, `Not included yet`, and `Strategic role`. Require `Evaluation status` on workflow pages and prohibit `Intended capabilities`, target-direction pills, and progress bars.

- [ ] **Step 2: Run and verify failure**

Run: `npm run build && npm run test:roadmap`

Expected: FAIL because the current featured and detail pages are percentage/capability based.

- [ ] **Step 3: Rewrite the featured card**

The featured card must assert `itemType === "strategic_program"`, `stage === "building"`, and render the first three milestone states plus the stable public update date.

```astro
<ProgramMilestones milestones={project.milestones.slice(0, 3)} compact />
<a href={`/roadmap/${project.slug}/`} class="link-accent mt-7 inline-flex items-center gap-2 text-sm font-semibold">
	See the milestones <span aria-hidden="true">→</span>
</a>
```

- [ ] **Step 4: Rewrite the detail contract**

Strategic pages render Outcome, Why now, First usable release, Milestones, Not included yet, Strategic role, public update, related releases, and GitHub discussion. Workflow pages render target team, example process, likely systems, expected output, evaluation state, public update, votes, and GitHub participation.

- [ ] **Step 5: Run the roadmap tests**

Run: `npm run build && npm run test:roadmap`

Expected: PASS for both `/roadmap/homun-flow/` and `/roadmap/client-work/`.

- [ ] **Step 6: Commit**

```bash
git add src/components/roadmap/FeaturedProject.astro src/components/roadmap/RoadmapParticipation.astro src/pages/roadmap/'[slug].astro' scripts/check-roadmap-pages.mjs
git commit -m "feat: explain roadmap programs through outcomes and milestones"
```

### Task 6: Install the approved page hierarchy and message

**Files:**
- Modify: `src/pages/roadmap/index.astro`
- Modify: `scripts/check-roadmap-pages.mjs`

- [ ] **Step 1: Add exact hero and ordering assertions**

```js
for (const required of [
	"BUILT FOR SMALL TEAMS",
	"AI that keeps work moving.",
	"Homun turns requests, messages and recurring work into visible processes",
	"One operational foundation. Multiple business workflows.",
]) assert.ok(roadmapText.includes(required), `Roadmap hero missing: ${required}`);

const order = ["Remember", "Available today", "Homun Flow", "Up next", "Business workflows we are evaluating", "Adaptive Company Intelligence", "Release history"];
for (let i = 1; i < order.length; i += 1) assert.ok(roadmapText.indexOf(order[i - 1]) < roadmapText.indexOf(order[i]), `Wrong section order: ${order[i]}`);
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run build && npm run test:roadmap`

Expected: FAIL on hero copy and information architecture.

- [ ] **Step 3: Compose the approved page**

Render hero, ProductJourney, Available card, featured Homun Flow, Up-next cards, WorkflowIdeas, Adaptive Company Intelligence, other Exploring programs, ReleaseHistory, and GitHub participation in that order. Keep LatestRelease outside the strategic card grid.

- [ ] **Step 4: Run the roadmap test**

Run: `npm run build && npm run test:roadmap`

Expected: PASS with release history separate from strategic programs.

- [ ] **Step 5: Commit**

```bash
git add src/pages/roadmap/index.astro scripts/check-roadmap-pages.mjs
git commit -m "feat: publish the customer-first roadmap narrative"
```

### Task 7: Preserve old routes and align the homepage

**Files:**
- Modify: `astro.config.mjs`
- Modify: `src/components/Ecosystem.astro`
- Modify: `scripts/check-homepage.mjs`
- Modify: `scripts/check-roadmap-pages.mjs`

- [ ] **Step 1: Add failing redirect and homepage assertions**

Require redirects:

```js
const expectedRedirects = {
	"/roadmap/mobile-companion": "/roadmap/homun-mobile",
	"/roadmap/shared-spaces": "/roadmap/team-spaces-roles",
	"/roadmap/voice-capture": "/roadmap/voice-meeting-capture",
};
```

Require homepage metrics for `available`, `building`, and `next`, and copy that describes official workflow packs rather than a public developer marketplace.

- [ ] **Step 2: Run and verify failure**

Run: `npm run build && npm run test:homepage && npm run test:roadmap`

Expected: FAIL on legacy route preservation and legacy Ideas/Shipped homepage metrics.

- [ ] **Step 3: Add static redirects**

Add the redirect map to Astro configuration and include trailing-slash variants when the generated output requires them.

- [ ] **Step 4: Rewrite the ecosystem panel**

Show Available, Building, and Up next counts from strategic programs. Replace the generic public marketplace promise with official Homun workflow packs developed and maintained by Homun; state that the developer platform comes after official pack validation.

- [ ] **Step 5: Run both contracts**

Run: `npm run build && npm run test:homepage && npm run test:roadmap`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add astro.config.mjs src/components/Ecosystem.astro scripts/check-homepage.mjs scripts/check-roadmap-pages.mjs
git commit -m "feat: preserve roadmap links and align homepage positioning"
```

### Task 8: Add an idempotent version 3 migration tool

**Files:**
- Modify: `scripts/fixtures/roadmap-v3-manifest.json`
- Create: `scripts/roadmap-v3-rollout.mjs`
- Create: `scripts/check-roadmap-v3-rollout.mjs`
- Delete: `scripts/bootstrap-roadmap-project.mjs`
- Delete: `scripts/check-roadmap-project-bootstrap.mjs`
- Delete: `scripts/roadmap-project-rollout.mjs`
- Delete: `scripts/check-roadmap-project-rollout.mjs`
- Delete: `scripts/fixtures/roadmap-project-inventory.json`
- Modify: `package.json`

- [ ] **Step 1: Create the exact desired manifest**

The manifest contains these active records:

| Order | Slug | Type | Stage / evaluation | Source action |
|---:|---|---|---|---|
| 10 | `operational-workspace` | Strategic program | Available | Create |
| 20 | `homun-flow` | Strategic program | Building now | Create, featured |
| 30 | `team-spaces-roles` | Strategic program | Up next | Transform issue #7 |
| 40 | `homun-mobile` | Strategic program | Up next | Transform issue #5 |
| 50 | `more-ways-to-reach-homun` | Strategic program | Up next | Create |
| 60 | `adaptive-company-intelligence` | Strategic program | Exploring | Create |
| 70 | `voice-meeting-capture` | Strategic program | Exploring | Transform issue #8 |
| 80 | `developer-platform` | Strategic program | Exploring | Create |
| 110 | `client-work` | Workflow idea | Evaluating | Create |
| 120 | `sales-operations` | Workflow idea | Evaluating | Create |
| 130 | `content-marketing` | Workflow idea | Evaluating | Create |
| 140 | `internal-operations` | Workflow idea | Evaluating | Create |
| 150 | `customer-support` | Workflow idea | Evaluating | Create |

The manifest archives issues #2, #3, #4, #6, #9, #10, and #11 with the supersession mapping from the approved design. It includes the complete issue body sections defined in the Public data contract and uses `2026-07-16` as the initial stable public update date.

- [ ] **Step 2: Add failing migration tests**

Prove dry-run planning, marker-based issue reuse, transformation of issues #5/#7/#8, creation of ten missing issues, creation of four new Project fields, archiving of seven legacy items, supersession comments, guarded confirmation, and a zero-operation second run.

```js
assert.deepEqual(plan.fieldsToCreate.map(({ name }) => name), [
	"Roadmap stage", "Item type", "Evaluation status", "Public area",
]);
assert.equal(plan.issuesToCreate.length, 10);
assert.equal(plan.issuesToTransform.length, 3);
assert.equal(plan.itemsToArchive.length, 7);
```

- [ ] **Step 3: Run and verify failure**

Run: `node scripts/check-roadmap-v3-rollout.mjs`

Expected: FAIL because the version 3 rollout tool does not exist.

- [ ] **Step 4: Implement the guarded planner/executor**

The CLI contract is:

```text
node scripts/roadmap-v3-rollout.mjs --project-number 1 --dry-run
node scripts/roadmap-v3-rollout.mjs --project-number 1 --apply
node scripts/roadmap-v3-rollout.mjs --project-number 1 --publish
```

Apply must require typing `roadmap-v3`, leave the thirteen active records in Review, never delete issues or Project items, preserve stable issue URLs for transformed records, add a supersession comment before closing archived issues, and re-fetch until its own follow-up plan has zero operations. Publish must require typing `publish-v3` and change only the thirteen active records from Review to Published.

- [ ] **Step 5: Register commands and run tests**

Add:

```json
"test:roadmap-v3-rollout": "node scripts/check-roadmap-v3-rollout.mjs",
"roadmap:v3-rollout": "node scripts/roadmap-v3-rollout.mjs"
```

Remove `test:roadmap-rollout`, `test:roadmap-bootstrap`, `roadmap:project-rollout`, and `roadmap:project-bootstrap` from `package.json`, then delete their superseded scripts and private fixture. Git history remains the audit trail for the completed version 2 migration.

Run: `npm run test:roadmap-v3-rollout`

Expected: PASS with `Roadmap v3 rollout contract passed`.

- [ ] **Step 6: Commit**

```bash
git add scripts/fixtures/roadmap-v3-manifest.json scripts/roadmap-v3-rollout.mjs scripts/check-roadmap-v3-rollout.mjs scripts/bootstrap-roadmap-project.mjs scripts/check-roadmap-project-bootstrap.mjs scripts/roadmap-project-rollout.mjs scripts/check-roadmap-project-rollout.mjs scripts/fixtures/roadmap-project-inventory.json package.json
git commit -m "feat: add guarded roadmap v3 migration"
```

### Task 9: Update operations and complete local verification

**Files:**
- Modify: `docs/roadmap-operations.md`
- Modify: `scripts/check-container-runtime.mjs`
- Modify: `package.json`

- [ ] **Step 1: Update editorial operations**

Document:

```text
Strategic program: Available | Building now | Up next | Exploring
Workflow idea: Evaluating | Selected for pilot | Removed
Publication: Draft | Review | Published | Archived
Progress: named milestone checkboxes only
Voting: workflow ideas and selected Exploring programs only
```

Include the migration freeze, dry-run, apply, local snapshot generation, full validation, publication, and no-op reconciliation sequence from the rollout plan. Remove version 2 bootstrap and rollout commands from the operations guide.

- [ ] **Step 2: Update the container smoke routes**

Replace legacy route expectations with `/roadmap/`, `/roadmap/homun-flow/`, `/roadmap/client-work/`, and the three redirect routes.

- [ ] **Step 3: Include the new migration test in `npm run check`**

Insert `npm run test:roadmap-v3-rollout` before the page and container tests. The retired version 2 rollout and bootstrap checks must no longer appear.

- [ ] **Step 4: Run complete verification**

Run: `npm ci && npm run check`

Expected: exit 0 for build, homepage, product data, roadmap rollout, roadmap v3 rollout, roadmap pages, and container/static runtime contracts.

- [ ] **Step 5: Inspect the production build manually**

Run: `npm run dev -- --host 127.0.0.1`

Inspect desktop and mobile widths for `/roadmap/`, `/roadmap/homun-flow/`, `/roadmap/client-work/`, and one old redirected URL. Verify no card clipping, no nested links, clear status hierarchy, and keyboard-visible focus states.

- [ ] **Step 6: Commit**

```bash
git add docs/roadmap-operations.md scripts/check-container-runtime.mjs package.json
git commit -m "docs: document roadmap v3 operations"
```

## Completion gate

Do not mutate GitHub Project #1 or merge the website branch as part of this plan. Completion means the implementation branch is internally green, the guarded migration dry-run is understandable, and the separate rollout plan is ready to execute.
