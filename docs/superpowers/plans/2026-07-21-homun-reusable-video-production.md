# Homun Reusable Video Production Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an evergreen, silent-first Homun video library whose clean masters can be reused in articles, documentation, launch films and social formats.

**Architecture:** Capture real product truth once in clean 16:9 masters. Keep hook cards, captions, focus callouts, music and CTA as replaceable layers; generate canonical feature modules before assembling the 75–90 second launch film or channel-specific derivatives.

**Tech Stack:** Homun desktop, QuickTime Player, FFmpeg/FFprobe, macOS `avconvert`, Markdown/SRT captions, PNG stills, MP4/WebM/GIF exports.

---

## File structure

```text
/Users/fabio/Projects/Homun/launch/video/
├── README.md
├── manifest.csv
├── style/
│   ├── caption-style.md
│   ├── title-card.png
│   └── end-card.png
├── masters/
│   ├── 01-meet-homun/
│   ├── 02-readable-memory/
│   ├── 03-controlled-computer/
│   ├── 04-models-are-engines/
│   ├── 05-real-deliverables/
│   └── 06-work-that-continues/
├── captions/
├── modules/
├── tools/
├── launch-film/
├── exports/
│   ├── article-16x9/
│   ├── social-4x5/
│   ├── shorts-9x16/
│   └── loops/
└── stills/
```

### Task 1: Create the reusable media library contract

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/video/README.md`
- Create: `/Users/fabio/Projects/Homun/launch/video/manifest.csv`
- Create: `/Users/fabio/Projects/Homun/launch/video/style/caption-style.md`

- [ ] **Step 1: Create the exact directory tree**

Run:

```bash
mkdir -p \
  /Users/fabio/Projects/Homun/launch/video/style \
  /Users/fabio/Projects/Homun/launch/video/{captions,modules,tools,launch-film,stills} \
  /Users/fabio/Projects/Homun/launch/video/exports/{article-16x9,social-4x5,shorts-9x16,loops}
for slug in 01-meet-homun 02-readable-memory 03-controlled-computer 04-models-are-engines 05-real-deliverables 06-work-that-continues; do
  mkdir -p "/Users/fabio/Projects/Homun/launch/video/masters/$slug"
done
```

Expected: only the declared `launch/video` hierarchy is created.

- [ ] **Step 2: Write the library README**

Document the evergreen rule, privacy rule, English-public/Italian-live language split, source-of-truth hierarchy and file naming convention.

Expected: the README explicitly forbids dates, release numbers, channel logos and launch-only CTA in master footage.

- [ ] **Step 3: Create the manifest schema**

Write this exact header to `manifest.csv`:

```csv
module_id,slug,master_path,canonical_path,article_path,social_path,short_path,loop_path,subtitle_path,trim_start,trim_duration,loop_start,loop_duration,status,privacy_review,visual_review
1,01-meet-homun,/Users/fabio/Projects/Homun/launch/video/masters/01-meet-homun/master.mov,/Users/fabio/Projects/Homun/launch/video/modules/01-meet-homun.mp4,/Users/fabio/Projects/Homun/launch/video/exports/article-16x9/01-meet-homun.mp4,/Users/fabio/Projects/Homun/launch/video/exports/social-4x5/01-meet-homun.mp4,/Users/fabio/Projects/Homun/launch/video/exports/shorts-9x16/01-meet-homun.mp4,/Users/fabio/Projects/Homun/launch/video/exports/loops/01-meet-homun.webm,/Users/fabio/Projects/Homun/launch/video/captions/01-meet-homun.srt,0,0,0,0,planned,pending,pending
2,02-readable-memory,/Users/fabio/Projects/Homun/launch/video/masters/02-readable-memory/master.mov,/Users/fabio/Projects/Homun/launch/video/modules/02-readable-memory.mp4,/Users/fabio/Projects/Homun/launch/video/exports/article-16x9/02-readable-memory.mp4,/Users/fabio/Projects/Homun/launch/video/exports/social-4x5/02-readable-memory.mp4,/Users/fabio/Projects/Homun/launch/video/exports/shorts-9x16/02-readable-memory.mp4,/Users/fabio/Projects/Homun/launch/video/exports/loops/02-readable-memory.webm,/Users/fabio/Projects/Homun/launch/video/captions/02-readable-memory.srt,0,0,0,0,planned,pending,pending
3,03-controlled-computer,/Users/fabio/Projects/Homun/launch/video/masters/03-controlled-computer/master.mov,/Users/fabio/Projects/Homun/launch/video/modules/03-controlled-computer.mp4,/Users/fabio/Projects/Homun/launch/video/exports/article-16x9/03-controlled-computer.mp4,/Users/fabio/Projects/Homun/launch/video/exports/social-4x5/03-controlled-computer.mp4,/Users/fabio/Projects/Homun/launch/video/exports/shorts-9x16/03-controlled-computer.mp4,/Users/fabio/Projects/Homun/launch/video/exports/loops/03-controlled-computer.webm,/Users/fabio/Projects/Homun/launch/video/captions/03-controlled-computer.srt,0,0,0,0,planned,pending,pending
4,04-models-are-engines,/Users/fabio/Projects/Homun/launch/video/masters/04-models-are-engines/master.mov,/Users/fabio/Projects/Homun/launch/video/modules/04-models-are-engines.mp4,/Users/fabio/Projects/Homun/launch/video/exports/article-16x9/04-models-are-engines.mp4,/Users/fabio/Projects/Homun/launch/video/exports/social-4x5/04-models-are-engines.mp4,/Users/fabio/Projects/Homun/launch/video/exports/shorts-9x16/04-models-are-engines.mp4,/Users/fabio/Projects/Homun/launch/video/exports/loops/04-models-are-engines.webm,/Users/fabio/Projects/Homun/launch/video/captions/04-models-are-engines.srt,0,0,0,0,planned,pending,pending
5,05-real-deliverables,/Users/fabio/Projects/Homun/launch/video/masters/05-real-deliverables/master.mov,/Users/fabio/Projects/Homun/launch/video/modules/05-real-deliverables.mp4,/Users/fabio/Projects/Homun/launch/video/exports/article-16x9/05-real-deliverables.mp4,/Users/fabio/Projects/Homun/launch/video/exports/social-4x5/05-real-deliverables.mp4,/Users/fabio/Projects/Homun/launch/video/exports/shorts-9x16/05-real-deliverables.mp4,/Users/fabio/Projects/Homun/launch/video/exports/loops/05-real-deliverables.webm,/Users/fabio/Projects/Homun/launch/video/captions/05-real-deliverables.srt,0,0,0,0,planned,pending,pending
6,06-work-that-continues,/Users/fabio/Projects/Homun/launch/video/masters/06-work-that-continues/master.mov,/Users/fabio/Projects/Homun/launch/video/modules/06-work-that-continues.mp4,/Users/fabio/Projects/Homun/launch/video/exports/article-16x9/06-work-that-continues.mp4,/Users/fabio/Projects/Homun/launch/video/exports/social-4x5/06-work-that-continues.mp4,/Users/fabio/Projects/Homun/launch/video/exports/shorts-9x16/06-work-that-continues.mp4,/Users/fabio/Projects/Homun/launch/video/exports/loops/06-work-that-continues.webm,/Users/fabio/Projects/Homun/launch/video/captions/06-work-that-continues.srt,0,0,0,0,planned,pending,pending
```

Expected: seven CSV lines total.

- [ ] **Step 4: Define the shared caption and CTA style**

Specify: Homun dark surface, teal `#157a6e`, white text, two lines maximum, 60 characters maximum per line, safe bottom margin 8%, neutral `homun.app` end card and no audio-dependent meaning.

Expected: one shared style contract for every derivative.

### Task 2: Install and verify the video editing runtime

**Files:**
- System dependency: Homebrew `ffmpeg`

- [ ] **Step 1: Verify FFmpeg is absent or record its existing version**

Run:

```bash
command -v ffmpeg || true
command -v ffprobe || true
```

Expected at current baseline: neither command prints a path.

- [ ] **Step 2: Install FFmpeg through Homebrew**

Run:

```bash
/opt/homebrew/bin/brew install ffmpeg
```

Expected: installation exits `0`. Do not modify the repository or the bundled Codex runtime.

- [ ] **Step 3: Verify required codecs and subtitle support**

Run:

```bash
ffmpeg -version
ffprobe -version
ffmpeg -filters | rg 'subtitles|scale|crop|drawtext'
```

Expected: both binaries report a version and all four filters are present.

### Task 3: Create reusable title and end cards

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/video/style/title-card.png`
- Create: `/Users/fabio/Projects/Homun/launch/video/style/end-card.png`

- [ ] **Step 1: Build a neutral title-card template**

Create a 1920×1080 dark card with the Homun wordmark, teal eyebrow and one replaceable headline area. Do not include a social platform name.

Expected: the card remains readable at 1280×720 and can accept any module title.

- [ ] **Step 2: Build the neutral end card**

Use only:

```text
homun
Your work. Your models. Your system.
homun.app
```

Expected: no date, release version, Discord invite or campaign-specific CTA.

- [ ] **Step 3: Inspect both cards at original resolution**

Expected: no clipping, high contrast and consistent brand geometry.

### Task 4: Capture the six clean masters

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/video/masters/*/master.mov`
- Create: `/Users/fabio/Projects/Homun/launch/video/masters/*/shot-log.md`

- [ ] **Step 1: Prepare the approved clean Homun demo state**

Reuse the verified backup/reset and Project Atlas setup from the presentation plan. Confirm notifications are disabled and no private provider fields are open.

Expected: only fictional/demo data is visible.

- [ ] **Step 2: Record one module at a time with QuickTime Player**

For each module: microphone `None`, Homun-window region only, 3 seconds of clean handle before and after the action, deliberate pointer movement and no unrelated navigation.

Expected: six independent `.mov` files, each 60–120 seconds.

- [ ] **Step 3: Write a shot log for each master**

Record timestamps for hook candidate, action start, outcome reveal, safe trim boundaries and any frame that must be excluded. Copy the chosen numeric values into the matching manifest row as `trim_start`, `trim_duration`, `loop_start` and `loop_duration`.

Expected: each master has exact editing coordinates and a declared outcome.

- [ ] **Step 4: Run the privacy review before editing**

Inspect the complete master, not selected frames only. Update `manifest.csv` to `privacy_review=passed` only after confirming there are no keys, contacts, personal names, customer data, old project names or notifications.

Expected: only privacy-passed masters proceed.

### Task 5: Write English canonical stories and subtitles

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/video/captions/*.srt`
- Create: `/Users/fabio/Projects/Homun/launch/video/masters/*/story.md`

- [ ] **Step 1: Write one hook/action/outcome story per module**

Each `story.md` contains:

```text
Hook: one sentence
Action: the exact UI sequence
Outcome: one concrete result
Canonical duration: 20–45 seconds
```

Expected: each module is intelligible without the launch film.

- [ ] **Step 2: Write synchronized English SRT captions**

Use no more than two lines and 60 characters per line. Captions describe the demonstrated value, not every pointer movement.

Expected: valid ascending SRT timestamps within the canonical duration.

- [ ] **Step 3: Validate subtitle structure**

Run:

```bash
for f in /Users/fabio/Projects/Homun/launch/video/captions/*.srt; do
  rg -q -- '-->' "$f" || exit 1
done
```

Expected: exit `0` for all six subtitle files.

### Task 6: Produce the six canonical 16:9 modules

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/video/tools/export-modules.sh`
- Create: `/Users/fabio/Projects/Homun/launch/video/modules/*.mp4`

- [ ] **Step 1: Create a manifest-driven canonical export script**

Write this exact script to `/Users/fabio/Projects/Homun/launch/video/tools/export-modules.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

video_root=/Users/fabio/Projects/Homun/launch/video
mkdir -p "$video_root/modules" "$video_root/stills"

tail -n +2 "$video_root/manifest.csv" |
while IFS=, read -r module_id slug master_path canonical_path article_path social_path short_path loop_path subtitle_path trim_start trim_duration loop_start loop_duration status privacy_review visual_review; do
  test "$privacy_review" = "passed"
  test "$trim_duration" != "0"

  clean_path="$video_root/modules/${slug}-clean.mp4"
  midpoint="$(awk -v duration="$trim_duration" 'BEGIN { printf "%.3f", duration / 2 }')"

  ffmpeg -y -ss "$trim_start" -i "$master_path" -t "$trim_duration" \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black" \
    -r 30 -an -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p "$clean_path"

  ffmpeg -y -i "$clean_path" \
    -vf "subtitles=${subtitle_path}:force_style='FontName=Arial,FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=70,Alignment=2'" \
    -r 30 -an -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p "$canonical_path"

  ffmpeg -y -ss 1 -i "$canonical_path" -frames:v 1 "$video_root/stills/${slug}-start.png"
  ffmpeg -y -ss "$midpoint" -i "$canonical_path" -frames:v 1 "$video_root/stills/${slug}-mid.png"
  ffmpeg -y -sseof -1 -i "$canonical_path" -frames:v 1 "$video_root/stills/${slug}-end.png"

  ffprobe -v error -show_entries stream=width,height,pix_fmt \
    -show_entries format=duration -of default=noprint_wrappers=1 "$canonical_path"
done
```

Expected: the script reads all paths and edit coordinates from the manifest; no manual path substitution is required.

- [ ] **Step 2: Run all six canonical exports**

Run:

```bash
chmod +x /Users/fabio/Projects/Homun/launch/video/tools/export-modules.sh
/Users/fabio/Projects/Homun/launch/video/tools/export-modules.sh
```

Expected: six clean intermediates, six canonical captioned modules and 18 review stills.

- [ ] **Step 3: Verify duration and media format for every module**

Run:

```bash
find /Users/fabio/Projects/Homun/launch/video/modules -maxdepth 1 -type f \
  -name '[0-9][0-9]-*.mp4' ! -name '*-clean.mp4' -print0 |
  xargs -0 -n1 ffprobe -v error -show_entries stream=width,height,pix_fmt \
  -show_entries format=filename,duration -of csv=p=0
```

Expected: six canonical files; each is 1920×1080, `yuv420p`, 30 fps and 20–45 seconds.

- [ ] **Step 4: Inspect captions and visual truth**

Watch each full canonical clip and inspect its three stills. Confirm captions remain in the safe lower region, never cover critical UI and match the visible result before setting `visual_review=passed`.

Expected: every canonical module is independently understandable and visually approved.

### Task 7: Produce reusable article, social and loop derivatives

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/video/tools/export-derivatives.sh`
- Create: `/Users/fabio/Projects/Homun/launch/video/exports/article-16x9/*.mp4`
- Create: `/Users/fabio/Projects/Homun/launch/video/exports/social-4x5/*.mp4`
- Create conditionally: `/Users/fabio/Projects/Homun/launch/video/exports/shorts-9x16/*.mp4`
- Create: `/Users/fabio/Projects/Homun/launch/video/exports/loops/*.webm`

- [ ] **Step 1: Create a manifest-driven derivative export script**

Write this exact script to `/Users/fabio/Projects/Homun/launch/video/tools/export-derivatives.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

video_root=/Users/fabio/Projects/Homun/launch/video

tail -n +2 "$video_root/manifest.csv" |
while IFS=, read -r module_id slug master_path canonical_path article_path social_path short_path loop_path subtitle_path trim_start trim_duration loop_start loop_duration status privacy_review visual_review; do
  test "$privacy_review" = "passed"
  test "$visual_review" = "passed"

  ffmpeg -y -i "$canonical_path" -map_metadata -1 -c copy "$article_path"

  ffmpeg -y -i "$canonical_path" \
    -vf "scale=1080:-2:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:black" \
    -an -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p "$social_path"

  if [ "$short_path" != "omitted-ui-unreadable" ]; then
    ffmpeg -y -i "$canonical_path" \
      -vf "scale=1080:-2:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black" \
      -an -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p "$short_path"
  fi

  test "$loop_duration" != "0"
  ffmpeg -y -ss "$loop_start" -i "$canonical_path" -t "$loop_duration" \
    -an -c:v libvpx-vp9 -crf 32 -b:v 0 -pix_fmt yuv420p "$loop_path"
done
```

Expected: article, social, optional short and loop outputs are all derived from approved canonical modules.

- [ ] **Step 2: Decide which vertical exports remain readable**

Preview each canonical module on a 1080×1920 padded canvas. For any module whose UI text is not legible, replace its `short_path` in `manifest.csv` with `omitted-ui-unreadable` before running the script.

Expected: the manifest explicitly records each omitted vertical derivative; no cropped or unreadable UI is published.

- [ ] **Step 3: Run the derivative exports**

Run:

```bash
chmod +x /Users/fabio/Projects/Homun/launch/video/tools/export-derivatives.sh
/Users/fabio/Projects/Homun/launch/video/tools/export-derivatives.sh
```

Expected: complete Homun UI remains visible; no output is produced from a module lacking both passed reviews.

- [ ] **Step 4: Verify every derivative**

Run:

```bash
find /Users/fabio/Projects/Homun/launch/video/exports -type f \
  \( -name '*.mp4' -o -name '*.webm' \) -print0 |
  xargs -0 -n1 ffprobe -v error -show_entries stream=width,height,pix_fmt \
  -show_entries format=filename,duration -of csv=p=0
```

Expected: article files are 16:9, social files are 4:5, included shorts are 9:16 and each loop lasts 6–12 seconds.

- [ ] **Step 5: Update and validate the manifest**

Expected: every path is populated or explicitly marked omitted; all six rows have `status=approved`, `privacy_review=passed`, `visual_review=passed` before launch-film assembly.

### Task 8: Assemble the 75–90 second launch film

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/video/launch-film/sequence.txt`
- Create: `/Users/fabio/Projects/Homun/launch/video/launch-film/homun-launch-16x9.mp4`
- Create: `/Users/fabio/Projects/Homun/launch/video/launch-film/homun-launch-4x5.mp4`

- [ ] **Step 1: Select only approved module segments**

Use this narrative order:

```text
Independent workspace → model freedom → readable memory → real deliverable → controlled computer → work that continues → homun.app
```

Expected: total planned duration 75–90 seconds; no feature appears twice.

- [ ] **Step 2: Normalize selected segments to one codec and frame rate**

Run the Task 6 normalization command for every segment with `-r 30` and identical audio-free H.264 settings.

Expected: concatenation inputs share resolution, pixel format, codec and frame rate.

- [ ] **Step 3: Concatenate the normalized segments**

Write `sequence.txt` with absolute `file` entries, then run:

```bash
ffmpeg -y -f concat -safe 0 -i /Users/fabio/Projects/Homun/launch/video/launch-film/sequence.txt \
  -c copy /Users/fabio/Projects/Homun/launch/video/launch-film/homun-launch-16x9.mp4
```

Expected: one silent 75–90 second film with no black gaps or broken transitions.

- [ ] **Step 4: Produce the 4:5 launch derivative**

Use the same padded-canvas command from Task 7.

Expected: 1080×1350 with all UI and captions readable.

- [ ] **Step 5: Review the complete film and objective attention flow**

Watch start to finish without skipping. Verify the first product proof appears within 5 seconds, no segment requires narration and the CTA appears only at the end.

Expected: approved launch film; if a segment fails, replace it from the approved module library rather than patching the master.

### Task 9: Final verification and handoff

**Files:**
- Update: `/Users/fabio/Projects/Homun/launch/video/README.md`
- Update: `/Users/fabio/Projects/Homun/launch/video/manifest.csv`

- [ ] **Step 1: Verify every declared file exists**

Run a manifest-driven check that resolves every non-omitted path and exits non-zero for a missing file.

Expected: zero missing paths.

- [ ] **Step 2: Verify all MP4/WebM media metadata**

Run:

```bash
find /Users/fabio/Projects/Homun/launch/video -type f \( -name '*.mp4' -o -name '*.webm' \) -print0 |
  xargs -0 -n1 ffprobe -v error -show_entries format=filename,duration -of csv=p=0
```

Expected: every file has a positive duration; no corrupt media.

- [ ] **Step 3: Verify privacy and shareability**

Watch every canonical module and the launch film. Confirm no private data, dates, release numbers, platform names or campaign-specific CTA exists in reusable footage.

Expected: manifest reviews remain `passed` after final export.

- [ ] **Step 4: Document reuse recipes**

Add exact guidance to `README.md` for article embed, README loop, social 4:5 post, optional vertical short and future launch-film replacement.

Expected: another editor can create a new channel derivative without touching the clean master.
