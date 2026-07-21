# Homun Product Presentation Production Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and rehearse a 35–40 minute English-slide/Italian-delivery Homun presentation with a verified live demo and reusable local backup clips for 2026-07-22.

**Architecture:** Keep content, deck, demo state and media backups independent. The deck carries the philosophy, architecture, roadmap and business model; one connected live demo proves the product; short local clips cover variable Docker, network and provider paths without turning the talk into a pre-recorded film.

**Tech Stack:** Homun desktop `v0.1.1072`, PowerPoint `.pptx`, PDF/HTML previews, bundled presentations runtime, QuickTime Player screen capture, macOS `avconvert`, Markdown runbooks.

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
│   ├── screenshots/
│   └── backup-clips/
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
- Create: `/Users/fabio/Projects/Homun/launch/presentation/content/slide-copy-en.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/content/speaker-notes-it.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/content/demo-script-it.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/readiness-checklist.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/rehearsal-log.md`

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

- [ ] **Step 2: Write the exact English slide copy**

Create `slide-copy-en.md` with 13 numbered slides from the approved specification. Each slide contains one headline, at most one supporting sentence and at most four short bullets. Preserve these mandatory lines exactly:

```text
Homun — The independent AI workspace
The model is an engine. The workspace is the system.
We monetize capabilities, not access.
Your work. Your models. Your system.
```

Expected: 13 slide headings; no Italian text; no `TBD`, dates, manual roadmap percentages or unsupported product claims.

- [ ] **Step 3: Write Italian speaker notes aligned one-to-one with the slides**

Create `speaker-notes-it.md` with sections `Slide 01` through `Slide 13`. Include the target duration, spoken argument, transition and one likely technical question for every slide.

Expected: 13 sections; total planned talk time before questions between 35 and 40 minutes.

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
rg -n '^## Slide (0[1-9]|1[0-3])' /Users/fabio/Projects/Homun/launch/presentation/content/slide-copy-en.md
rg -n '^## Slide (0[1-9]|1[0-3])' /Users/fabio/Projects/Homun/launch/presentation/content/speaker-notes-it.md
! rg -n 'TBD|TODO|PLACEHOLDER|lorem ipsum' /Users/fabio/Projects/Homun/launch/presentation/content
```

Expected: 13 matches in each of the first two commands; final scan returns no matches.

### Task 2: Build and visually verify the editable deck

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pptx`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pdf`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.html`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/assets/screenshots/slide-01.png` through `slide-13.png`

- [ ] **Step 1: Invoke the presentation production skill**

Before creating the deck, read and follow `presentations:Presentations`. Use the approved design spec and `slide-copy-en.md` as sources. Use Homun's current dark surface, teal accent and wordmark; create an editable 16:9 PowerPoint with speaker notes.

Expected: the skill produces an editable `.pptx` and renderable preview without replacing approved copy with generic pitch language.

- [ ] **Step 2: Copy the approved brand sources**

Use these inputs without modifying them:

```text
/Users/fabio/Projects/Homun/launch/brand/homun-avatar.png
/Users/fabio/Projects/Homun/launch/brand/homun-x-header-1500x500.png
/Users/fabio/Projects/Homun/launch/brand/homun-discord-banner-960x540.png
```

Expected: the deck uses the actual wordmark/teal visual system and does not invent a new logo.

- [ ] **Step 3: Render every slide to PNG and PDF**

Use the renderer mandated by `presentations:Presentations`. Save page images as `slide-01.png` through `slide-13.png` and the complete PDF at the exact paths above.

Expected: 13 PNG files and a 13-page PDF.

- [ ] **Step 4: Inspect every rendered slide**

Review all 13 page images at original or high detail. Reject any slide with clipped text, unreadable contrast, small projector text, fake UI, unsupported claims or repeated nested containers.

Expected: every slide has one clear idea and remains readable at 1280×720 projection.

- [ ] **Step 5: Verify the final artifact family**

Run:

```bash
file \
  /Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pptx \
  /Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pdf \
  /Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.html
find /Users/fabio/Projects/Homun/launch/presentation/assets/screenshots -name 'slide-*.png' | wc -l
```

Expected: PowerPoint, PDF and HTML are recognized; PNG count is `13`.

### Task 3: Back up and clean the authorized Homun demo profile

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

### Task 4: Configure a deterministic demo state

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

### Task 5: Rehearse the connected live demo

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

### Task 6: Capture the presentation backup clips

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

### Task 7: Integrate proof media and finalize the deck

**Files:**
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pptx`
- Regenerate: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pdf`
- Regenerate: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.html`

- [ ] **Step 1: Add the sixty-second teaser or a deterministic click-through fallback**

Prefer a local embedded teaser only if playback is reliable in the actual presentation application. Otherwise use three full-frame product stills with manual advance.

Expected: no network-streamed video and no dependency on a browser tab.

- [ ] **Step 2: Link backup clips from the demo-introduction slide**

Use local relative media references or a single known media folder. Do not embed private backup data or absolute paths that break when the folder is moved.

Expected: every clip opens locally from the final presentation folder.

- [ ] **Step 3: Re-render and re-inspect all slides**

Repeat Task 2 Steps 3–5 after media integration.

Expected: still 13 readable slides; the PDF remains a complete media-free fallback.

### Task 8: Run the final presentation gate

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
