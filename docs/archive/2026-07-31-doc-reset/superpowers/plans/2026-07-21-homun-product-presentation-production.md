# Homun Product Presentation Production Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and rehearse a 35–40 minute English-slide/Italian-delivery Homun presentation with a verified live demo and reusable local backup clips for 2026-07-22.

**Architecture:** Keep content, website-derived visual assets, deck source, demo state and media backups independent. The deck follows Independence → Specialization → Ecosystem; existing homun.app illustrations provide the conceptual visuals, current Homun screenshots prove the product, one connected live demo proves the workflow and short local clips cover variable Docker, network and provider paths.

**Tech Stack:** Current Homun desktop build, homun.app Astro source, Playwright screenshots, PowerPoint `.pptx`, PDF/HTML previews, bundled presentations runtime, QuickTime Player screen capture, macOS `avconvert`, Markdown runbooks.

---

## File structure

All final presentation artifacts live outside the source repository under the existing launch headquarters:

```text
/Users/fabio/Projects/Homun/launch/presentation/
├── content/
│   ├── slide-copy-en.md
│   ├── speaker-notes-it.md
│   └── demo-script-it.md
├── assets/
│   ├── brand/
│   ├── site/
│   ├── screenshots/
│   ├── checkpoint/
│   └── backup-clips/
├── source/
│   └── build-deck.mjs
├── rehearsal/
│   ├── readiness-checklist.md
│   └── rehearsal-log.md
├── homun-independent-ai-workspace.pptx
├── homun-independent-ai-workspace.pdf
└── homun-independent-ai-workspace.html
```

The backup of live Homun data must never be stored under `launch/`. It belongs under `/Users/fabio/Backups/Homun/` because it contains credentials, sessions and personal state.

### Task 1: Create the presentation production package

**Files:**
- Read: `docs/superpowers/specs/2026-07-21-homun-launch-video-presentation-design.md`
- Replace: `/Users/fabio/Projects/Homun/launch/presentation/content/slide-copy-en.md`
- Replace: `/Users/fabio/Projects/Homun/launch/presentation/content/speaker-notes-it.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/content/demo-script-it.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/readiness-checklist.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/rehearsal-log.md`

- [ ] **Step 1: Create the bounded directory tree**

Run:

```bash
mkdir -p \
  /Users/fabio/Projects/Homun/launch/presentation/content \
  /Users/fabio/Projects/Homun/launch/presentation/assets/brand \
  /Users/fabio/Projects/Homun/launch/presentation/assets/screenshots \
  /Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips \
  /Users/fabio/Projects/Homun/launch/presentation/rehearsal
```

Expected: exit `0`; no path outside `/Users/fabio/Projects/Homun/launch/presentation` changes.

- [ ] **Step 2: Replace the rejected copy with the exact English slide copy**

Create `slide-copy-en.md` with 16 numbered slides from the approved redesign specification. Each slide contains one headline, at most one supporting sentence and at most four short bullets. Preserve these mandatory lines exactly:

```text
01 · Homun — The independent AI workspace
02 · The best AI tools are also deep dependencies.
03 · Use the best. Keep the right to leave.
04 · The model is replaceable. Your work is not.
05 · One system. Replaceable engines.
06 · Independence has to be structural.
07 · Real work, not isolated prompts.
08 · Intelligence is horizontal. Work is vertical.
09 · Plugins turn a workspace into a profession.
10 · One request. A connected workflow.
11 · What just happened?
12 · One open system. Many professions.
13 · Open does not mean ungoverned.
14 · We monetize capabilities, not access.
15 · Available now. Building next. Designed for later.
16 · Your work. Your models. Your system.
```

Expected: 16 slide headings; no Italian text; no `TBD`, dates, manual roadmap percentages or unsupported current-product claims. Slides 12–15 label `Available now`, `Building next` and `Long-term vision` explicitly.

- [ ] **Step 3: Write Italian speaker notes aligned one-to-one with the slides**

Create `speaker-notes-it.md` with sections `Slide 01` through `Slide 16`. Include the target duration, spoken argument, transition and one likely technical question for every slide. The notes acknowledge that Claude and Codex set a high quality benchmark, then frame provider dependency as an architectural risk rather than a current accusation.

Expected: 16 sections; total planned talk time before questions between 35 and 40 minutes.

- [ ] **Step 4: Write the connected demo script**

Create `demo-script-it.md` with the exact live prompt and these checkpoints:

```text
1. Italian request entered in Project Atlas.
2. Visible plan appears.
3. English presentation artifact is created and opened.
4. A new chat recalls the intended decision with a source.
5. Provider switch is attempted only if the rehearsal proves it stable.
```

Expected: one connected scenario; no tour through unrelated settings.

- [ ] **Step 5: Validate content completeness**

Run:

```bash
rg -n '^## Slide (0[1-9]|1[0-6])' /Users/fabio/Projects/Homun/launch/presentation/content/slide-copy-en.md
rg -n '^## Slide (0[1-9]|1[0-6])' /Users/fabio/Projects/Homun/launch/presentation/content/speaker-notes-it.md
! rg -n 'TBD|TODO|PLACEHOLDER|lorem ipsum' /Users/fabio/Projects/Homun/launch/presentation/content
```

Expected: 16 matches in each of the first two commands; final scan returns no matches.

### Task 2: Capture the actual homun.app visual system

**Files:**
- Read: `/Users/fabio/Projects/Homun/website/src/styles/global.css`
- Read: `/Users/fabio/Projects/Homun/website/src/components/illustrations/*.astro`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/assets/site/*.png`

- [ ] **Step 1: Verify the website source before capture**

Run:

```bash
cd /Users/fabio/Projects/Homun/website
npm run build
npm run test:illustrations
```

Expected: both commands exit `0`; the source of truth renders before any asset is reused.

- [ ] **Step 2: Capture the actual illustration elements at high resolution**

Start the local website and use Playwright at a 1440×1000 viewport with device scale `2`. Capture the exact DOM elements identified by these current attributes:

```text
[data-illustration="workshop"]
[data-illustration="engines"]
[data-illustration="memory-continuity"]
[data-illustration="connected-workspace"]
[data-illustration="ecosystem"]
```

Save them as `workshop.png`, `engines.png`, `memory-continuity.png`, `connected-workspace.png` and `ecosystem.png` under `assets/site/`.

Expected: five non-empty high-resolution PNGs containing the real site illustrations, not redrawn approximations.

- [ ] **Step 3: Record the exact design tokens**

Create a constants block in `source/build-deck.mjs` using the production website values:

```js
const HOMUN = {
  bg: "050807",
  raised: "08100E",
  surface: "0B1512",
  cream: "F3FBF8",
  muted: "9AAFA9",
  faint: "698079",
  teal: "50DFC5",
  blue: "5789EE",
  pink: "EF78D8",
  yellow: "F1D070",
  sans: "Inter Variable",
  mono: "SF Mono",
};
```

Expected: the deck source contains no substitute navy/teal theme and no unrelated font family.

### Task 3: Build and approve the three-slide visual checkpoint

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/presentation/source/build-deck.mjs`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/assets/checkpoint/slide-01.png`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/assets/checkpoint/slide-05.png`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/assets/checkpoint/slide-13.png`

- [ ] **Step 1: Invoke the presentation production skill**

Before creating the deck, read and follow `presentations:Presentations`. Use the approved redesign specification, exact slide copy and captured website assets. Use its required editable PowerPoint workflow and 16:9 layout.

Expected: `source/build-deck.mjs` is the durable deck source; it does not reuse the rejected temporary build script.

- [ ] **Step 2: Build only the three representative slides**

Implement these exact checkpoint subjects:

```text
01 · Opening manifesto — Workshop illustration
05 · Stable system / replaceable engines — EngineTransition illustration
13 · Curated marketplace vision — Ecosystem illustration extended with review flow
```

Expected: three editable slides with different silhouettes; no generic circles, repeated card grid or decorative teal bar.

- [ ] **Step 3: Render and inspect the checkpoint**

Use the renderer mandated by `presentations:Presentations`, save the three PNGs at the checkpoint paths and inspect all three at original size.

Expected: typography, grain, glow, panels, semantic colors and illustrations visibly match homun.app; projector text remains readable.

- [ ] **Step 4: Reject the checkpoint if it only matches the palette**

Compare the checkpoint with a current homun.app screenshot. Reject it if the illustrations are approximations, if layouts feel like a generic pitch template, or if the deck could belong to another product after changing the logo.

Expected: the checkpoint is unmistakably Homun before the remaining slides are built.

### Task 4: Build and visually verify the complete editable deck

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pptx`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pdf`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.html`
- Replace: `/Users/fabio/Projects/Homun/launch/presentation/assets/screenshots/slide-01.png` through `slide-16.png`

- [ ] **Step 1: Complete all sixteen slides**

Use the approved slide sequence and these visual mappings:

```text
01 workshop illustration        09 connected-workspace / plugin anatomy
02 current product evidence     10 current Homun UI / demo transition
03 engines illustration         11 current Homun UI / result recap
04 workshop core crop           12 ecosystem illustration
05 engines illustration         13 ecosystem + review flow
06 memory-continuity + FSL       14 marketplace value flow
07 current Homun UI              15 roadmap orbit / three time horizons
08 ecosystem transition          16 wordmark + workshop atmosphere
```

Expected: one dominant idea per slide, varied silhouettes and no unsupported current-state marketplace claims.

- [ ] **Step 2: Add the Italian notes to the editable deck**

Map `speaker-notes-it.md` one-to-one to slides 01–16 without placing Italian paragraphs on the slide canvas.

Expected: English slide surface, Italian delivery notes and Italian live prompts.

- [ ] **Step 3: Render every slide to PNG and PDF**

Use the renderer mandated by `presentations:Presentations`. Save page images as `slide-01.png` through `slide-16.png` and the complete PDF at the exact paths above.

Expected: 16 PNG files and a 16-page PDF.

- [ ] **Step 4: Inspect every rendered slide**

Review all 16 page images at original size. Reject clipped text, unreadable contrast, small projector text, fake UI, stale screenshots, repeated nested containers or visual claims that blur current and future product state.

Expected: every slide is readable at 1280×720 projection and belongs to the homun.app brand system.

- [ ] **Step 5: Verify the final artifact family**

Run:

```bash
file \
  /Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pptx \
  /Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pdf \
  /Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.html
find /Users/fabio/Projects/Homun/launch/presentation/assets/screenshots -name 'slide-*.png' | wc -l
```

Expected: PowerPoint, PDF and HTML are recognized; PNG count is `16`.

### Task 5: Back up and clean the authorized Homun demo profile

**Files:**
- Read/backup: `/Users/fabio/.homun`
- Read/backup: `/Users/fabio/Library/Application Support/Homun`
- Create: `/Users/fabio/Backups/Homun/demo-capture-20260721-*/`

- [ ] **Step 1: Close Homun and verify its data files are not being written**

Close the application normally. Then run:

```bash
pgrep -fl 'Homun|local-first-desktop-gateway' || true
lsof /Users/fabio/.homun/memory.sqlite /Users/fabio/.homun/homun.sqlite 2>/dev/null || true
```

Expected: no Homun or gateway process and no open handles to the two primary databases.

- [ ] **Step 2: Create a private timestamped backup directory**

Run:

```bash
mkdir -p /Users/fabio/Backups/Homun
backup_dir="$(mktemp -d /Users/fabio/Backups/Homun/demo-capture-20260721-XXXXXX)"
printf '%s\n' "$backup_dir" > /Users/fabio/Projects/Homun/launch/presentation/rehearsal/backup-path.txt
printf '%s\n' "$backup_dir"
```

Expected: one explicit directory such as `/Users/fabio/Backups/Homun/demo-capture-20260721-A1B2C3`; record it in `rehearsal/readiness-checklist.md`.

- [ ] **Step 3: Copy both application-state roots**

Run:

```bash
backup_dir="$(sed -n '1p' /Users/fabio/Projects/Homun/launch/presentation/rehearsal/backup-path.txt)"
case "$backup_dir" in
  /Users/fabio/Backups/Homun/demo-capture-20260721-*) ;;
  *) echo 'Unexpected backup path' >&2; exit 2 ;;
esac
ditto /Users/fabio/.homun "$backup_dir/.homun"
ditto '/Users/fabio/Library/Application Support/Homun' "$backup_dir/Application Support Homun"
```

Expected: both commands exit `0`. Do not store this backup in Git or under `launch/`.

- [ ] **Step 4: Verify backup structure and database integrity**

Run:

```bash
backup_dir="$(sed -n '1p' /Users/fabio/Projects/Homun/launch/presentation/rehearsal/backup-path.txt)"
case "$backup_dir" in
  /Users/fabio/Backups/Homun/demo-capture-20260721-*) ;;
  *) echo 'Unexpected backup path' >&2; exit 2 ;;
esac
du -sh /Users/fabio/.homun "$backup_dir/.homun"
du -sh '/Users/fabio/Library/Application Support/Homun' "$backup_dir/Application Support Homun"
sqlite3 "$backup_dir/.homun/memory.sqlite" 'PRAGMA integrity_check;'
sqlite3 "$backup_dir/.homun/homun.sqlite" 'PRAGMA integrity_check;'
```

Expected: source and backup sizes are comparable; both SQLite checks print `ok`.

- [ ] **Step 5: Perform the factory reset through Homun's supported UI**

Reopen Homun, navigate to Settings, invoke the existing total local-data/factory-reset action, read the destructive confirmation, and confirm only after the backup path and integrity checks are recorded.

Expected: Homun restarts at onboarding; no prior chats, projects, memory entities, connectors or secrets are visible.

### Task 6: Configure a deterministic demo state

**Files:**
- Modify through UI only: `/Users/fabio/.homun/*`
- Update: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/readiness-checklist.md`

- [ ] **Step 1: Complete onboarding with the intended model path**

Use the current real onboarding. Record the clean onboarding flow separately before entering any private key. Choose a stable local or cloud provider that is already approved for the demo.

Expected: the main workspace opens and a basic chat returns a valid answer.

- [ ] **Step 2: Verify Docker and Ollama explicitly**

Run:

```bash
docker info >/dev/null && echo 'Docker ready'
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null && echo 'Ollama ready'
```

Expected: both readiness messages print. If either fails, mark its demo segment as clip-only.

- [ ] **Step 3: Create only the Project Atlas demo project**

Create one project named `Project Atlas`. Do not import personal files. Seed only the fictional positioning decision used by the demo.

Expected: a clean project with no personal or customer context.

- [ ] **Step 4: Confirm sensitive screens are clean**

Inspect provider settings, channels, memory and recent artifacts. No API keys, phone numbers, customer names, personal file names or old chats may be visible.

Expected: readiness checklist marks `private-data scan` as passed.

### Task 7: Rehearse the connected live demo

**Files:**
- Update: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/rehearsal-log.md`
- Update: `/Users/fabio/Projects/Homun/launch/presentation/content/demo-script-it.md`

- [ ] **Step 1: Run the Italian prompt from a clean Project Atlas chat**

Enter exactly:

```text
Prepara una presentazione in inglese per il lancio di Project Atlas. Il pubblico è tecnico: evidenzia modello multi-provider, memoria ispezionabile e controllo delle azioni.
```

Expected: a visible plan and a presentation-generation path, not a generic prose answer.

- [ ] **Step 2: Verify the generated artifact visually**

Open the generated presentation preview. Confirm the selected template is reflected in the output and the artifact is not a generic Markdown/PDF fallback.

Expected: a real deck artifact whose layout matches the selected template.

- [ ] **Step 3: Verify memory continuity in a new chat**

Open a new chat in Project Atlas and ask:

```text
Quale posizionamento avevamo scelto per Project Atlas e da quale decisione lo ricordi?
```

Expected: the intended decision is recalled with source/provenance visible.

- [ ] **Step 4: Decide the provider-switch gate**

Switch provider only if two rehearsals preserve the same project context and complete within 45 seconds. Otherwise remove provider switching from the live path and use the provider-independence slide plus a reusable clip.

Expected: `provider switch = live` or `provider switch = clip` is recorded, never left undecided.

- [ ] **Step 5: Time the complete demo twice**

Record start/end times in `rehearsal-log.md`.

Expected: both runs complete in 11–13 minutes with no hidden manual recovery.

### Task 8: Capture the presentation backup clips

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips/onboarding.mov`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips/computer-control.mov`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips/memory-recall.mov`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips/presentation-output.mov`

- [ ] **Step 1: Record only the Homun window with QuickTime Player**

Use New Screen Recording, microphone `None`, and select the exact Homun window area. Capture each flow separately and keep the raw `.mov` file.

Expected: four independent recordings; no desktop notifications or unrelated windows.

- [ ] **Step 2: Trim clips with macOS `avconvert`**

Create `/Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips/trim.csv` with this header and one row per captured clip. Fill `start_seconds` and `duration_seconds` from the reviewed raw recording:

```csv
raw_path,final_path,start_seconds,duration_seconds
```

Then run:

```bash
tail -n +2 /Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips/trim.csv |
while IFS=, read -r raw_path final_path start_seconds duration_seconds; do
  test -n "$raw_path" && test -n "$final_path"
  /usr/bin/avconvert \
    --source "$raw_path" \
    --preset Preset1920x1080 \
    --output "$final_path" \
    --start "$start_seconds" \
    --duration "$duration_seconds" \
    --replace \
    --disableMetadataFilter
done
```

Expected: each final clip is 15–45 seconds and contains only the intended flow.

- [ ] **Step 3: Verify media metadata**

Run:

```bash
mdls -name kMDItemDurationSeconds -name kMDItemPixelWidth -name kMDItemPixelHeight \
  /Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips/*.mov
```

Expected: every clip has non-zero duration and a readable HD frame size.

- [ ] **Step 4: Review first, middle and last frames**

Open every clip and inspect the start, midpoint and end. Reject any clip with secrets, notifications, pointer drift or frozen progress that suggests failure.

Expected: all four clips can be understood without narration.

### Task 9: Integrate fallback media and finalize the deck

**Files:**
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pptx`
- Regenerate: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pdf`
- Regenerate: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.html`

- [ ] **Step 1: Add a deterministic product-proof fallback**

Use three current full-frame product stills with manual advance. Embed a local clip only if playback is verified in the exact presentation application and the PDF still communicates the same proof without it.

Expected: no network-streamed video and no dependency on a browser tab.

- [ ] **Step 2: Link backup clips from the demo-introduction slide**

Use local relative media references or a single known media folder. Do not embed private backup data or absolute paths that break when the folder is moved.

Expected: every clip opens locally from the final presentation folder.

- [ ] **Step 3: Re-render and re-inspect all slides**

Repeat Task 4 Steps 3–5 after media integration.

Expected: still 16 readable slides; the PDF remains a complete media-free fallback.

### Task 10: Run the final presentation gate

**Files:**
- Update: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/readiness-checklist.md`
- Update: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/rehearsal-log.md`

- [ ] **Step 1: Rehearse the full talk at 1280×720 or the target projector resolution**

Expected: 35–40 minutes before questions; no clipped slide content.

- [ ] **Step 2: Run the live demo from the exact event state**

Expected: presentation artifact and memory recall both succeed. Provider switching is included only if its gate is green.

- [ ] **Step 3: Test the offline fallback**

Disable network access and confirm the PDF, local slides and backup clips still open.

Expected: the talk remains deliverable even if live inference is unavailable.

- [ ] **Step 4: Verify the final folder and checksums**

Run:

```bash
find /Users/fabio/Projects/Homun/launch/presentation -maxdepth 3 -type f -print | sort
shasum -a 256 \
  /Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pptx \
  /Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pdf
```

Expected: all required artifacts exist and both checksums are recorded in `readiness-checklist.md`.
