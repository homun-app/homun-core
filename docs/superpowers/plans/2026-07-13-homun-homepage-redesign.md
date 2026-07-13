# Homun Homepage Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current feature-led Homun homepage with a polished Precision Operator experience that communicates model autonomy, real work, local control, the living ecosystem, and registration-free use.

**Architecture:** Keep Astro 6, Starlight, Tailwind 4, and the existing static-site structure. Recompose the homepage from focused Astro sections, backed by a small content contract test that inspects the built HTML. Preserve existing docs, marketplace, roadmap, and changelog routes while changing only the shared shell and homepage in this slice.

**Tech Stack:** Astro 6, Tailwind CSS 4, TypeScript-flavoured Astro components, Node.js built-in assertions, Sharp for the social image, static build verification.

---

## Scope

This plan covers the first independently shippable slice:

- shared Precision Operator visual tokens;
- global navigation and metadata;
- autonomy-first homepage hero;
- model freedom, real work, local control, ecosystem, and download sections;
- responsive, reduced-motion, keyboard, and copy-contract verification;
- refreshed social preview image.

It does not implement account authentication, voting, Marketplace installation, new Projects data models, or documentation migration. Those require separate plans after this homepage is approved visually.

## File structure

- Create `website/.gitignore` — excludes generated output and local brainstorming state.
- Create `website/scripts/check-homepage.mjs` — verifies non-negotiable positioning and route contracts in built HTML.
- Create `website/src/components/ModelFreedom.astro` — explains a persistent system with replaceable model engines.
- Create `website/src/components/WorkProof.astro` — shows credible work outputs instead of a generic feature grid.
- Create `website/src/components/Ecosystem.astro` — introduces Projects and official free Marketplace plugins.
- Modify `website/package.json` — adds `test:homepage` and `check` scripts.
- Modify `website/src/layouts/Base.astro` — updates metadata and preserves accessible progressive enhancement.
- Modify `website/src/components/Nav.astro` — aligns navigation with Product, Models, Projects, Marketplace, Docs, optional Sign in, and Download.
- Modify `website/src/components/Hero.astro` — implements autonomy-first copy and a product-activity composition.
- Modify `website/src/components/Security.astro` — reframes the existing security section as local control without absolute privacy claims.
- Modify `website/src/components/Download.astro` — advertises macOS as published and labels Windows/Linux accurately.
- Modify `website/src/components/Footer.astro` — aligns footer language and routes with the new architecture.
- Modify `website/src/pages/index.astro` — composes the six-section homepage narrative.
- Modify `website/src/styles/global.css` — evolves the current espresso theme into Precision Operator tokens and reusable section primitives.
- Modify `website/scripts/make-og.mjs` — updates the social card to the autonomy message.
- Regenerate `website/public/og.png` — reflects the new homepage promise.

### Task 1: Establish a safe website baseline

**Files:**
- Create: `/Users/fabio/Projects/Homun/website/.gitignore`
- Repository: `/Users/fabio/Projects/Homun/website/.git`

- [ ] **Step 1: Add generated and local-only exclusions**

```gitignore
node_modules/
dist/
.astro/
.superpowers/
.DS_Store
*.log
```

- [ ] **Step 2: Verify the existing website builds before versioning it**

Run: `npm run build`

Expected: exit code `0`, `47 page(s) built`, and `dist/index.html` exists. The existing Starlight `404` warning is accepted for this slice because it predates the redesign.

- [ ] **Step 3: Initialize a local repository and record the untouched baseline**

Run:

```bash
git init -b main
git add .
git commit -m "Baseline Homun website"
```

Expected: a root commit containing source, content, public assets, and package lock, while generated directories remain untracked.

### Task 2: Add homepage positioning contract tests

**Files:**
- Create: `/Users/fabio/Projects/Homun/website/scripts/check-homepage.mjs`
- Modify: `/Users/fabio/Projects/Homun/website/package.json`

- [ ] **Step 1: Write the failing built-HTML contract test**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

for (const required of [
  "Your work. Your models. Your system.",
  "Download without an account",
  "Cloud, open source, or local",
  "Real work, not isolated prompts",
  "Official Homun plugins. Free at launch.",
  "Browse Projects",
]) {
  assert.match(text, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
}

for (const forbidden of ["Codex", "Claude Code", "any model", "every platform"]) {
  assert.doesNotMatch(text, new RegExp(forbidden, "i"));
}

for (const href of ["/docs", "/marketplace", "/roadmap", "/guides/download/"]) {
  assert.match(html, new RegExp(`href=["']${href.replaceAll("/", "\\/")}`));
}

console.log("Homepage positioning contract passed");
```

- [ ] **Step 2: Add repeatable test commands**

Add to `package.json` scripts:

```json
"test:homepage": "node scripts/check-homepage.mjs",
"check": "npm run build && npm run test:homepage"
```

- [ ] **Step 3: Run the contract test and confirm it fails against the old homepage**

Run: `npm run check`

Expected: build succeeds, then `AssertionError` reports that `Your work. Your models. Your system.` is missing.

- [ ] **Step 4: Commit the failing contract**

```bash
git add package.json scripts/check-homepage.mjs
git commit -m "test: define homepage positioning contract"
```

### Task 3: Implement Precision Operator foundations and shared shell

**Files:**
- Modify: `/Users/fabio/Projects/Homun/website/src/styles/global.css`
- Modify: `/Users/fabio/Projects/Homun/website/src/layouts/Base.astro`
- Modify: `/Users/fabio/Projects/Homun/website/src/components/Nav.astro`

- [ ] **Step 1: Replace the theme description and adjust the visual tokens**

Keep existing token names to avoid breaking inner pages, but use this palette:

```css
@theme {
  --color-bg: #050807;
  --color-bg-raised: #08100e;
  --color-surface: #0b1512;
  --color-surface-2: #10201c;
  --color-cream: #f3fbf8;
  --color-muted: #9aafa9;
  --color-faint: #698079;
  --color-line: rgba(191, 235, 224, 0.09);
  --color-line-strong: rgba(191, 235, 224, 0.18);
  --color-accent: #20a991;
  --color-accent-bright: #50dfc5;
  --color-accent-glow: #67efd5;
  --color-accent-soft: #b6f6e9;
  --color-accent-deep: #0c6657;
}
```

Add `.section-shell`, `.operator-panel`, `.status-dot`, `.section-rule`, and `.metric-label` primitives. Keep focus-visible styles and ensure the reduced-motion query disables reveal transforms and non-essential animation.

- [ ] **Step 2: Update default metadata**

Use:

```ts
const {
  title = "Homun — Your work. Your models. Your system.",
  description = "Homun is a model-independent AI work environment for software, research, documents and presentations, powered by compatible cloud, open-source or local models.",
} = Astro.props;
```

Keep canonical, Open Graph, Twitter, favicon, and theme-colour tags.

- [ ] **Step 3: Replace navigation labels and destinations**

Use this navigation contract:

```ts
const links = [
  { label: "Product", href: "/#product" },
  { label: "Models", href: "/#models" },
  { label: "Projects", href: "/roadmap" },
  { label: "Marketplace", href: "/marketplace" },
  { label: "Docs", href: "/docs" },
];
```

Keep the mobile disclosure behaviour. Add a subdued `Sign in` item with `aria-disabled="true"` and a `Soon` badge rather than linking to an unimplemented account page. Keep Download as the only primary navigation action and point it to `/#download`.

- [ ] **Step 4: Run build verification**

Run: `npm run build`

Expected: exit code `0`; all existing routes still build.

- [ ] **Step 5: Commit the shared foundation**

```bash
git add src/styles/global.css src/layouts/Base.astro src/components/Nav.astro
git commit -m "feat: establish Precision Operator site shell"
```

### Task 4: Rebuild the autonomy-first hero

**Files:**
- Modify: `/Users/fabio/Projects/Homun/website/src/components/Hero.astro`

- [ ] **Step 1: Replace the centred feature hero with a two-column composition**

The left column uses this exact content hierarchy:

```text
MODEL-INDEPENDENT AI WORKSPACE
Your work. Your models. Your system.
Homun keeps your projects, memory, tools and permissions together while you choose compatible cloud, open-source or local models.
Download without an account
See how Homun works
macOS available now · Windows and Linux builds in progress
```

The primary CTA links to `/guides/download/`; the secondary CTA links to `#product`.

- [ ] **Step 2: Build a semantic activity panel in the right column**

Use an ordered list headed `LIVE WORKSPACE` with these rows:

```ts
const activity = [
  { task: "Refactor project", mode: "Cloud model", state: "Running" },
  { task: "Review private files", mode: "Local model", state: "Ready" },
  { task: "Build presentation", mode: "Chosen model", state: "Queued" },
];
```

Add a footer strip reading `Projects persist · Models can change`. The panel must be HTML/CSS, not a misleading screenshot. Do not name model vendors or claim automatic routing.

- [ ] **Step 3: Verify hero behaviour**

Run: `npm run build`

Expected: build passes and `dist/index.html` includes the new headline, registration-free CTA, and all three activity rows.

- [ ] **Step 4: Commit the hero**

```bash
git add src/components/Hero.astro
git commit -m "feat: lead homepage with model autonomy"
```

### Task 5: Explain model freedom and real work

**Files:**
- Create: `/Users/fabio/Projects/Homun/website/src/components/ModelFreedom.astro`
- Create: `/Users/fabio/Projects/Homun/website/src/components/WorkProof.astro`
- Modify: `/Users/fabio/Projects/Homun/website/src/pages/index.astro`

- [ ] **Step 1: Create the model freedom section**

Set `id="models"` and use:

```ts
const choices = [
  { label: "Cloud", detail: "Use compatible hosted providers when reach and speed matter." },
  { label: "Open source", detail: "Choose models whose weights and ecosystem stay accessible." },
  { label: "Local", detail: "Run models on your own hardware when the task and machine allow it." },
];
```

Headline: `Cloud, open source, or local.`

Supporting line: `The model is an engine. Your projects, memory, tools and permissions remain the system.`

Render the three choices around a persistent central `Homun workspace` panel. Use CSS grid that collapses into a single column below `48rem`.

- [ ] **Step 2: Create the real-work section**

Set `id="product"` and define:

```ts
const outcomes = [
  { index: "01", title: "Develop software", body: "Explore a codebase, modify files, run checks and keep the project context together." },
  { index: "02", title: "Create deliverables", body: "Turn work into documents, presentations, research and structured outputs." },
  { index: "03", title: "Operate locally", body: "Use approved tools and applications on the system where the work actually lives." },
  { index: "04", title: "Continue the project", body: "Keep ideas, decisions and future work connected beyond a single prompt." },
];
```

Headline: `Real work, not isolated prompts.` Include one existing product screenshot only when it directly supports an outcome; use `chat.png` as evidence of project work and give it meaningful alt text.

- [ ] **Step 3: Compose the new first half of the homepage**

Replace `Pillars`, `Apprentice`, and `Features` imports with:

```astro
<Hero />
<ModelFreedom />
<WorkProof />
```

Keep Security and Download temporarily so every build stays complete.

- [ ] **Step 4: Run the contract test**

Run: `npm run check`

Expected: it advances past the hero and model/work assertions, then fails because the Marketplace and Projects copy has not been added yet.

- [ ] **Step 5: Commit the narrative core**

```bash
git add src/components/ModelFreedom.astro src/components/WorkProof.astro src/pages/index.astro
git commit -m "feat: show model freedom and real project work"
```

### Task 6: Reframe local control without absolute claims

**Files:**
- Modify: `/Users/fabio/Projects/Homun/website/src/components/Security.astro`

- [ ] **Step 1: Replace security guarantees with verifiable control statements**

Use:

```ts
const controls = [
  { title: "Choose what leaves the machine", body: "Local and cloud models can coexist; you decide which configured provider handles the work." },
  { title: "Grant access explicitly", body: "Local tools and connectors operate through the permissions you approve." },
  { title: "Inspect the activity", body: "Plans, tool use and results remain visible while Homun works." },
  { title: "Keep local options open", body: "Compatible local models can run on suitable hardware without making a cloud provider the permanent centre of the system." },
];
```

Set `id="control"`, eyebrow `LOCAL CONTROL`, headline `Your system remains yours to direct.`, and keep the existing privacy screenshot only as supporting product evidence.

- [ ] **Step 2: Remove unsupported absolutes**

Confirm the component no longer says “without sending any of it away”, “every action”, “full audit trail”, or “the core won't act” unless the current product has been separately verified for those exact claims.

- [ ] **Step 3: Build and commit**

Run: `npm run build`

Expected: exit code `0`.

```bash
git add src/components/Security.astro
git commit -m "feat: present local control with precise claims"
```

### Task 7: Add the living ecosystem section

**Files:**
- Create: `/Users/fabio/Projects/Homun/website/src/components/Ecosystem.astro`
- Modify: `/Users/fabio/Projects/Homun/website/src/pages/index.astro`

- [ ] **Step 1: Create a paired Projects and Marketplace section**

Use two unequal cards under the headline `A system designed to keep growing.`

Projects card:

```text
PROJECTS
See what Homun is exploring, what is being built and what has shipped. Follow the direction now; community voting and suggestions will require an optional Homun account when enabled.
Browse Projects
```

Marketplace card:

```text
MARKETPLACE
Official Homun plugins. Free at launch.
Browse verified plugins, understand their permissions and add new capabilities to Homun. Marketplace downloads will use an optional Homun account when enabled.
Explore Marketplace
```

Link Projects to `/roadmap` until the dedicated `/projects` route is implemented. Link Marketplace to `/marketplace`. Label voting, suggestions, and account-backed downloads as `Coming later`, not as active features.

- [ ] **Step 2: Insert Ecosystem before Download**

The final order becomes:

```astro
<Hero />
<ModelFreedom />
<WorkProof />
<Security />
<Ecosystem />
<Download />
```

- [ ] **Step 3: Run the homepage contract**

Run: `npm run check`

Expected: all required and forbidden copy assertions pass, unless Download still contains `every platform`; that failure is intentionally resolved in Task 8.

- [ ] **Step 4: Commit the ecosystem section**

```bash
git add src/components/Ecosystem.astro src/pages/index.astro
git commit -m "feat: introduce Homun Projects and Marketplace"
```

### Task 8: Make download and footer claims accurate

**Files:**
- Modify: `/Users/fabio/Projects/Homun/website/src/components/Download.astro`
- Modify: `/Users/fabio/Projects/Homun/website/src/components/Footer.astro`

- [ ] **Step 1: Replace the three equal download cards with published-versus-upcoming states**

Use the verified release status already documented in `src/content/docs/guides/download.md`:

```ts
const systems = [
  { os: "macOS", status: "Available", detail: "Signed and notarized · Apple silicon and Intel", active: true },
  { os: "Windows", status: "In progress", detail: "Build available internally · public signing pending", active: false },
  { os: "Linux", status: "In progress", detail: "AppImage and .deb builds · public release pending", active: false },
];
```

Headline: `Start without creating an account.` Only the macOS card is an active link to `/guides/download/`. Upcoming cards use non-link markup and must not look clickable. Keep the self-hosting link as a separate secondary option.

- [ ] **Step 2: Align footer routes and promise**

Footer tagline: `Your work · your models · your system`. Use Product, Models, Projects, Marketplace, Docs, Changelog, Download, GitHub, and privacy/security links. Do not create dead Account links.

- [ ] **Step 3: Run the complete positioning contract**

Run: `npm run check`

Expected:

```text
Homepage positioning contract passed
```

- [ ] **Step 4: Commit accurate conversion surfaces**

```bash
git add src/components/Download.astro src/components/Footer.astro
git commit -m "feat: clarify account-free download availability"
```

### Task 9: Refresh the social image

**Files:**
- Modify: `/Users/fabio/Projects/Homun/website/scripts/make-og.mjs`
- Modify: `/Users/fabio/Projects/Homun/website/public/og.png`

- [ ] **Step 1: Update the generated social-card copy and colours**

Use the Precision Operator background `#050807`, accent `#50dfc5`, headline `Your work. Your models. Your system.`, and microcopy `CLOUD · OPEN SOURCE · LOCAL`.

- [ ] **Step 2: Regenerate the asset**

Run: `node scripts/make-og.mjs`

Expected: `✓ wrote /Users/fabio/Projects/Homun/website/public/og.png` and the image remains `1200 × 630`.

- [ ] **Step 3: Inspect the generated image**

Run: `sips -g pixelWidth -g pixelHeight public/og.png`

Expected: `pixelWidth: 1200`, `pixelHeight: 630`. Open or render the image and confirm the headline is not clipped.

- [ ] **Step 4: Commit**

```bash
git add scripts/make-og.mjs public/og.png
git commit -m "feat: refresh Homun social preview"
```

### Task 10: Responsive and visual acceptance

**Files:**
- Modify if needed: `/Users/fabio/Projects/Homun/website/src/styles/global.css`
- Modify if needed: homepage components from Tasks 3–8

- [ ] **Step 1: Run the site locally**

Run: `npm run dev -- --host 127.0.0.1`

Expected: Astro reports a local URL and the homepage returns HTTP `200`.

- [ ] **Step 2: Inspect desktop at 1440 × 1000**

Confirm:

- hero headline and both CTAs are visible without scrolling;
- activity panel reads as product state, not a decorative code block;
- section rhythm clearly separates autonomy, work, control, ecosystem, and download;
- no old “personal assistant” or vendor-comparison message dominates the page;
- there is no horizontal overflow.

- [ ] **Step 3: Inspect mobile at 390 × 844**

Confirm:

- mobile menu opens, closes, and exposes all active destinations;
- headline does not overflow and primary CTA is at least 44px high;
- all multi-column sections become one readable column;
- upcoming download platforms are clearly non-interactive;
- focus order follows visual order.

- [ ] **Step 4: Inspect reduced motion and keyboard navigation**

Emulate `prefers-reduced-motion: reduce`, reload, and confirm all content is immediately visible. Tab from the navigation through all interactive elements; every control must have a visible focus indicator and no hidden element may receive focus.

- [ ] **Step 5: Run final verification**

Run:

```bash
npm run check
git status --short
```

Expected: build and homepage contract pass. Only intentional source changes are present; `dist`, `.astro`, `.superpowers`, and `node_modules` remain ignored.

- [ ] **Step 6: Commit visual QA fixes**

```bash
git add src package.json scripts public/og.png .gitignore
git commit -m "fix: complete homepage responsive polish"
```

If no files changed during visual QA, do not create an empty commit.

## Completion criteria

- `npm run check` passes from a clean checkout.
- Desktop and mobile visual review passes in a real browser.
- The first screen communicates a complete AI work environment, model independence, local/open-source/cloud choice, and registration-free use.
- No competitor names or unsupported universal claims appear in the homepage.
- Existing docs, Marketplace, roadmap, and changelog routes still build.
- Windows and Linux are not presented as currently published downloads.
- Account-backed ecosystem functions are explicitly labelled as future behaviour.
