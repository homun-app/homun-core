# Homun Transcript and Functional Demo Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a rehearsable Italian presentation transcript and a verified five-chapter Project Atlas demonstration covering documents, MCP, research, memory, software, controlled computer, automations, Telegram/WhatsApp and Presentations.

**Architecture:** Keep public presentation content, sanitized demo data, the resettable dashboard, private Homun state and rehearsal evidence in separate roots. Every demo chapter has deterministic inputs, three independent trials, a time gate and a truthful replacement path; only observed presentation-blocking product defects enter a separate TDD fix loop.

**Tech Stack:** Current Homun desktop build, Markdown, PDF, Filesystem MCP, Node.js 25 built-in TypeScript stripping and test runner, local HTTP dashboard, Telegram/WhatsApp channel sidecars, Presentations plugin, macOS screen capture and SHA-256 manifests.

---

## File structure

Repository-tracked design and plan files remain in the launch worktree. Public or sanitized production artifacts remain in the existing launch headquarters. Private application state stays outside both locations.

```text
/Users/fabio/Projects/Homun/app/.worktrees/fabio/launch-media-production/
└── docs/superpowers/
    ├── specs/2026-07-22-homun-presentation-transcript-demo-tour-design.md
    └── plans/2026-07-22-homun-transcript-functional-demo-production.md

/Users/fabio/Projects/Homun/launch/presentation/
├── content/
│   ├── presentation-transcript-it.md
│   ├── presentation-transcript-35m-it.md
│   ├── presenter-anchor-sheet-it.md
│   ├── demo-prompt-catalog-it.md
│   └── q-and-a-it.md
├── demo/project-atlas/
│   ├── README.md
│   ├── materials/
│   │   ├── homun-launch-brief.md
│   │   ├── homun-launch-brief.pdf
│   │   ├── audience-notes.md
│   │   └── launch-constraints.csv
│   ├── dashboard/
│   │   ├── package.json
│   │   ├── README.md
│   │   ├── src/readiness.ts
│   │   ├── src/server.mjs
│   │   ├── test/readiness.test.ts
│   │   └── scripts/reset-demo.sh
│   └── evidence/
├── assets/backup-clips/
├── rehearsal/
│   ├── backup-path.txt
│   ├── demo-runbook-it.md
│   ├── query-test-log.md
│   ├── readiness-checklist.md
│   ├── rehearsal-log.md
│   └── final-manifest.sha256
└── existing deck, PDF, HTML and slide assets

/Users/fabio/Backups/Homun/
└── presentation-20260722-<generated suffix>/
```

No secret, channel token, session state, phone number or private backup may be stored under `/Users/fabio/Projects/Homun/launch` or committed to Git.

### Task 1: Freeze the approved presentation baseline and create the production tree

**Files:**
- Read: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pptx`
- Read: `/Users/fabio/Projects/Homun/launch/presentation/content/slide-copy-en.md`
- Read: `/Users/fabio/Projects/Homun/launch/presentation/content/speaker-notes-it.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/final-manifest.sha256`

- [ ] **Step 1: Create only the approved production directories**

Run:

```bash
mkdir -p \
  /Users/fabio/Projects/Homun/launch/presentation/content \
  /Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/materials \
  /Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard/src \
  /Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard/test \
  /Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard/scripts \
  /Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/evidence \
  /Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips \
  /Users/fabio/Projects/Homun/launch/presentation/rehearsal/visual-baseline
```

Expected: exit `0`; no directory outside the explicit presentation root changes.

- [ ] **Step 2: Record the immutable baseline hashes**

Run:

```bash
cd /Users/fabio/Projects/Homun/launch/presentation
shasum -a 256 \
  homun-independent-ai-workspace.pptx \
  homun-independent-ai-workspace.pdf \
  homun-independent-ai-workspace.html \
  content/slide-copy-en.md \
  content/speaker-notes-it.md \
  > rehearsal/final-manifest.sha256
shasum -a 256 -c rehearsal/final-manifest.sha256
```

Expected: five `OK` lines. The deck family is not modified by this plan unless an observed transcript mismatch requires a separately approved content correction.

- [ ] **Step 3: Verify the slide/note contract before writing the transcript**

Run:

```bash
test "$(rg -c '^## Slide (0[1-9]|1[0-6])' /Users/fabio/Projects/Homun/launch/presentation/content/slide-copy-en.md)" -eq 16
test "$(rg -c '^## Slide (0[1-9]|1[0-6])' /Users/fabio/Projects/Homun/launch/presentation/content/speaker-notes-it.md)" -eq 16
```

Expected: exit `0`; the transcript starts from exactly sixteen approved slides and notes.

- [ ] **Step 4: Preserve a visual-only baseline for the later notes rebuild**

Run:

```bash
cp /Users/fabio/Projects/Homun/launch/presentation/assets/screenshots/slide-*.png \
  /Users/fabio/Projects/Homun/launch/presentation/rehearsal/visual-baseline/
test "$(find /Users/fabio/Projects/Homun/launch/presentation/rehearsal/visual-baseline -name 'slide-*.png' | wc -l | tr -d ' ')" -eq 16
```

Expected: sixteen preserved PNGs that are not overwritten by the later PPTX render.

### Task 2: Write the Italian hybrid transcript package

**Files:**
- Read: `/Users/fabio/Projects/Homun/launch/presentation/content/slide-copy-en.md`
- Read: `/Users/fabio/Projects/Homun/launch/presentation/content/speaker-notes-it.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/content/presentation-transcript-it.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/content/presentation-transcript-35m-it.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/content/presenter-anchor-sheet-it.md`

- [ ] **Step 1: Write the full sixteen-slide transcript**

For each section `Slide 01` through `Slide 16`, write these exact subheadings:

```markdown
### Tempo
### Sullo schermo
### Copione
### Parole-ancora
### Blocco opzionale
### Transizione
### Regia — non pronunciare
### Domanda probabile
```

The spoken text must be conversational Italian, credit Claude and Codex as quality benchmarks, explain independence without alleging present discrimination, describe FSL-1.1-ALv2 accurately, and keep marketplace, developer registration and signed publication in the future tense.

Expected: 16 slide sections; approximately 2,900–3,300 spoken words outside stage directions and demo prompts; 23–25 minutes at 125–135 words per minute.

- [ ] **Step 2: Insert the five demo chapter bridges**

Add brief spoken bridges named `UNDERSTAND`, `REMEMBER`, `ACT`, `CONTINUE` and `DELIVER`. Each bridge states what the audience is about to verify and avoids narrating clicks.

Expected: the demo sounds like one work cycle rather than a settings tour; software is explicitly one capability among documents, research, MCP, memory, channels and deliverables.

- [ ] **Step 3: Create the 35-minute route**

Copy only the mandatory transcript paragraphs and these demo steps:

```text
UNDERSTAND: Prompt 1 plus the verified output of Prompt 2
REMEMBER: Prompt 5 recall with source
ACT: plan, regression test and final diff; controlled-computer clip if needed
CONTINUE: Telegram rule and one verified delivery
DELIVER: plan and previously verified five-slide artifact
```

Expected: the short route preserves independence, verticalization, business model and current/future boundaries; it does not merely truncate the ending.

- [ ] **Step 4: Create the one-page anchor sheet**

Limit the sheet to slide number, three anchor words, target time, demo gate and transition sentence. Use no paragraph longer than two lines.

Expected: printable in two A4 pages or fewer at 11 pt; readable from the presenter position.

- [ ] **Step 5: Validate transcript structure and language**

Run:

```bash
test "$(rg -c '^## Slide (0[1-9]|1[0-6])' /Users/fabio/Projects/Homun/launch/presentation/content/presentation-transcript-it.md)" -eq 16
test "$(rg -c '^### Parole-ancora$' /Users/fabio/Projects/Homun/launch/presentation/content/presentation-transcript-it.md)" -eq 16
test "$(rg -c '^### Blocco opzionale$' /Users/fabio/Projects/Homun/launch/presentation/content/presentation-transcript-it.md)" -eq 16
! rg -n 'TBD|TODO|PLACEHOLDER|lorem ipsum|marketplace (è|e) disponibile' /Users/fabio/Projects/Homun/launch/presentation/content/presentation-transcript*.md
```

Expected: all commands exit `0` and no unsupported marketplace availability claim appears.

### Task 3: Create the prompt catalogue, runbook skeleton and Q&A bank

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/presentation/content/demo-prompt-catalog-it.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/content/q-and-a-it.md`
- Replace: `/Users/fabio/Projects/Homun/launch/presentation/content/demo-script-it.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/demo-runbook-it.md`
- Replace: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/query-test-log.md`
- Replace: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/readiness-checklist.md`
- Replace: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/rehearsal-log.md`

- [ ] **Step 1: Write the eleven approved prompts verbatim**

Copy Prompts 1–11 from the approved design without paraphrasing. For every prompt add:

```markdown
- Chapter
- Input state
- Visible result
- Time limit
- Privacy boundary
- Pass condition
- Fallback entry point
```

Expected: headings `Prompt 01` through `Prompt 11`, one occurrence each; no credential, phone number or personal path.

- [ ] **Step 2: Write the click-by-click runbook skeleton**

For each chapter record the start screen, exact prompt, UI surface to open, one sentence Fabio says, stop time and fallback file. Use these initial limits:

```text
UNDERSTAND 04:00
REMEMBER 02:30
ACT 05:00
CONTINUE 03:00
DELIVER 04:00
```

Expected: the sum of nominal chapter limits is 18:30; no recovery sequence restarts the total timer.

- [ ] **Step 3: Create the query-test log with three trial columns**

Use one row per prompt with fields for provider/model, start state checksum, duration, selected tool, actual output, source correctness, privacy result, pass/fail and replacement. Add two end-to-end rehearsal sections with one continuous timer.

Expected: every prompt can be evaluated without relying on a narrative comment such as “looked fine”.

- [ ] **Step 4: Write at least twenty-four Q&A entries**

Cover at minimum:

```text
Positioning: Claude/Codex relationship, model aggregator difference, local-first value.
Technical: storage, provider data flow, project isolation, memory provenance,
MCP permissions, contained computer, automation failure, Telegram/WhatsApp,
local models, plugin isolation.
Product: available now, experimental surfaces, supported platforms/providers,
official plugins, developer tooling, marketplace timing.
Business/license: FSL permitted purposes, competing use, Apache 2.0 after two
years per version, free Team, one-time plugins, major upgrades, support,
customization and future commission.
```

Each entry contains a 20–30 second answer, an optional technical expansion, a current proof and a future-only boundary where applicable. License answers must be checked against `LICENSE.md`; roadmap answers must be checked against the current public roadmap and approved deck.

Add an `Unplanned live requests` section that accepts only Project Atlas work that is read-only or reversible, completes within two minutes, needs no new credential/account/provider/MCP connection, installs nothing, changes no infrastructure and sends no message outside the prepared destination. Include the three safe requests used in Task 15 and an exact refusal sentence for requests outside those boundaries.

- [ ] **Step 5: Replace the obsolete connected-demo documents**

Replace `content/demo-script-it.md` with the same five chapters and eleven prompts as the detailed runbook, keeping only spoken lines and transitions. Rewrite `readiness-checklist.md` and `rehearsal-log.md` around the chapter gates `UNDERSTAND`, `REMEMBER`, `ACT`, `CONTINUE` and `DELIVER`; remove the previous single Project Atlas deck-only flow and provider-switch timing table.

Expected: there is no active launch document that instructs Fabio to run the rejected one-request-only demo. The checklist requires three passes per chapter, two complete rehearsals, privacy verification, backup integrity, local fallbacks and an explicit GO/NO-GO result.

- [ ] **Step 6: Validate prompt and Q&A completeness**

Run:

```bash
test "$(rg -c '^## Prompt (0[1-9]|1[01])' /Users/fabio/Projects/Homun/launch/presentation/content/demo-prompt-catalog-it.md)" -eq 11
test "$(rg -c '^## Q[0-9]{2} ' /Users/fabio/Projects/Homun/launch/presentation/content/q-and-a-it.md)" -ge 24
! rg -n 'TBD|TODO|PLACEHOLDER|sk-[A-Za-z0-9]|\+[0-9]{8,}' /Users/fabio/Projects/Homun/launch/presentation/content /Users/fabio/Projects/Homun/launch/presentation/rehearsal
```

Expected: exact prompt count, at least 24 questions and no likely secret or phone-number pattern.

### Task 4: Build the sanitized Project Atlas document package

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/README.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/materials/homun-launch-brief.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/materials/homun-launch-brief.pdf`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/materials/audience-notes.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/materials/launch-constraints.csv`

- [ ] **Step 1: Write the sanitized launch brief source**

Include only these verified content groups:

```text
Purpose: independent, local-first AI workspace.
Audience: technical teams evaluating autonomy and extensibility.
Current proof: model choice, projects, sourced memory, tools, artifacts,
documents/Presentations, controlled computer, configured channels/automations.
Building next: official vertical plugins, developer tools, stronger workflows.
Long-term: registered developers, review, signed marketplace and commission.
Business: Core/Personal/Team free; optional one-time plugins, paid major
upgrades, support and customization.
License: FSL-1.1-ALv2 permitted non-competing purposes; Apache 2.0 future
license effective on the second anniversary of each version.
```

Expected: no customer, revenue, adoption or performance figure; current and future sections are visually distinct.

- [ ] **Step 2: Write audience notes with deliberate objections**

Include objections about provider lock-in, local/cloud data flow, MCP security, memory correction, automation failure, plugin governance, FSL terminology and the absence of a Team seat subscription.

Expected: at least eight objections; none contains a real person's name, company or contact detail.

- [ ] **Step 3: Create the deterministic constraint CSV**

Use this exact header and sanitized rows:

```csv
id,priority,requirement,owner,status,next_action,source
ATL-001,P0,No personal data appears in the demo,Demo team,ready,Run final privacy scan,Presentation checklist
ATL-002,P0,Deck and PDF remain available offline,Demo team,ready,Verify checksums before the event,Local artifact manifest
ATL-003,P1,Telegram delivery uses only the allowlisted demo destination,Demo team,ready,Confirm destination before activation,Channel settings
ATL-004,P1,External case-study approval,Launch team,blocked,Obtain approval before publication,Audience notes
ATL-005,P2,WhatsApp continuity proof passes three rehearsals,Demo team,in-review,Keep Telegram as the live fallback,Rehearsal log
```

Expected: Prompt 9 finds exactly one blocked P0/P1 row: `ATL-004`.

- [ ] **Step 4: Generate and visually verify the PDF**

Use the `pdf` skill to render `homun-launch-brief.md` as a clean, text-bearing PDF. Render every page to PNG and inspect at original size.

Expected: readable title, section hierarchy and current/future distinction; `pdftotext` contains `FSL-1.1-ALv2`, `Core`, `Personal`, `Team` and `Long-term`; no page overflow.

- [ ] **Step 5: Verify the sanitized material set**

Run:

```bash
pdftotext /Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/materials/homun-launch-brief.pdf - | rg -n 'FSL-1.1-ALv2|Core|Personal|Team|Long-term'
python3 - <<'PY'
import csv
from pathlib import Path
p = Path('/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/materials/launch-constraints.csv')
rows = list(csv.DictReader(p.open()))
blocked = [r for r in rows if r['priority'] in {'P0', 'P1'} and r['status'] == 'blocked']
assert [r['id'] for r in blocked] == ['ATL-004'], blocked
print('Project Atlas constraints: OK')
PY
```

Expected: required PDF terms found and `Project Atlas constraints: OK`.

### Task 5: Build the deterministic TypeScript dashboard repository

**Files:**
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard/package.json`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard/src/readiness.ts`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard/src/server.mjs`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard/test/readiness.test.ts`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard/scripts/reset-demo.sh`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard/README.md`

- [ ] **Step 1: Create the zero-dependency package contract**

Write:

```json
{
  "name": "project-atlas-readiness",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --experimental-strip-types --test test/*.test.ts",
    "start": "node --experimental-strip-types src/server.mjs"
  }
}
```

Expected: no install step and no network dependency.

- [ ] **Step 2: Add the deliberate readiness defect**

Write `src/readiness.ts` as:

```ts
export type LaunchState = {
  modelConfigured: boolean;
  memoryIndexed: boolean;
};

export function isLaunchReady(state: LaunchState): boolean {
  return state.modelConfigured || state.memoryIndexed;
}
```

The `||` is the single intentional baseline defect. The correct behavior requires both conditions.

- [ ] **Step 3: Add only the incomplete baseline tests**

Write `test/readiness.test.ts` as:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { isLaunchReady } from "../src/readiness.ts";

test("ready when the model and memory are configured", () => {
  assert.equal(isLaunchReady({ modelConfigured: true, memoryIndexed: true }), true);
});

test("not ready when neither prerequisite is configured", () => {
  assert.equal(isLaunchReady({ modelConfigured: false, memoryIndexed: false }), false);
});
```

Expected: baseline suite passes while missing the regression case named in Prompt 6.

- [ ] **Step 4: Add the local visual verification server**

Write `src/server.mjs` as:

```js
import { createServer } from "node:http";
import { isLaunchReady } from "./readiness.ts";

const host = "127.0.0.1";
const port = 4173;

createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const memoryIndexed = url.searchParams.get("memoryIndexed") === "true";
  const ready = isLaunchReady({ modelConfigured: true, memoryIndexed });
  const status = ready ? "Ready" : "Not ready";

  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Project Atlas readiness</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #050807; color: #f3fbf8; }
    main { width: min(760px, 86vw); padding: 48px; border: 1px solid #17352f; border-radius: 24px; background: #0b1512; }
    h1 { margin: 0 0 12px; font-size: 56px; }
    .state { color: ${ready ? "#50dfc5" : "#f1d070"}; font-size: 32px; font-weight: 700; }
    nav { display: flex; gap: 16px; margin-top: 36px; }
    a { color: #f3fbf8; border: 1px solid #5789ee; border-radius: 999px; padding: 12px 18px; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <p>PROJECT ATLAS · LAUNCH READINESS</p>
    <h1>${status}</h1>
    <p>Model configured: yes · Memory indexed: ${memoryIndexed ? "yes" : "no"}</p>
    <nav>
      <a href="/?memoryIndexed=false">Memory not indexed</a>
      <a href="/?memoryIndexed=true">Memory indexed</a>
    </nav>
  </main>
</body>
</html>`);
}).listen(port, host, () => {
  console.log(`Project Atlas dashboard: http://${host}:${port}/?memoryIndexed=false`);
});
```

The response must include `Cache-Control: no-store`; the page must contain no external resource.

- [ ] **Step 5: Add the bounded reset script**

Write `scripts/reset-demo.sh` as:

```sh
#!/bin/sh
set -eu

expected_root='/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard'
repo_root="$(git -C "$expected_root" rev-parse --show-toplevel)"

if [ "$repo_root" != "$expected_root" ]; then
  echo "Refusing reset outside the Project Atlas demo repository" >&2
  exit 2
fi

git -C "$repo_root" restore --source demo-baseline --staged --worktree -- \
  src/readiness.ts test/readiness.test.ts
npm --prefix "$repo_root" test
```

Make the script executable. It restores only `src/readiness.ts` and `test/readiness.test.ts` from tag `demo-baseline`. Do not use `git reset --hard`, `git clean` or a broad path.

- [ ] **Step 6: Write the dashboard README**

Document the deliberate `||` defect, the expected `&&` fix, `npm test`, `npm start`, both query-string states, the five-minute demo gate and the bounded reset command. State explicitly that the repository is synthetic and contains no production Homun code.

- [ ] **Step 7: Initialize and tag the baseline**

Run:

```bash
cd /Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard
chmod +x scripts/reset-demo.sh
git init
git add package.json README.md src/readiness.ts src/server.mjs test/readiness.test.ts scripts/reset-demo.sh
git commit -m "demo: add Project Atlas readiness baseline"
git tag demo-baseline
npm test
```

Expected: two passing tests and tag `demo-baseline`. This nested demo repository is not added to the Homun source repository.

- [ ] **Step 8: Verify the visible baseline defect**

Start the server and open `http://127.0.0.1:4173/?memoryIndexed=false`.

Expected: the baseline incorrectly shows `Ready`; after replacing `||` with `&&`, adding a regression test and rerunning, the same URL shows `Not ready` while `?memoryIndexed=true` shows `Ready`.

### Task 6: Back up and clean the authorized Homun demo profile

**Files:**
- Read/backup: `/Users/fabio/.homun`
- Read/backup: `/Users/fabio/Library/Application Support/Homun`
- Create: `/Users/fabio/Backups/Homun/presentation-20260722-*/`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/backup-path.txt`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/readiness-checklist.md`

- [ ] **Step 1: Require an unlocked Mac and close Homun normally**

Use the supported application Quit action. If Computer Use reports that the Mac is locked, stop this task without copying, deleting or resetting anything and ask Fabio to unlock it.

Expected: Homun and its gateway are no longer running.

- [ ] **Step 2: Resolve the active data files read-only**

Run:

```bash
pgrep -fl 'Homun|local-first-desktop-gateway' || true
find /Users/fabio/.homun '/Users/fabio/Library/Application Support/Homun' \
  -maxdepth 4 -type f \( -name '*.sqlite' -o -name '*.db' -o -name '*.json' \) -print 2>/dev/null | sort
```

Expected: no active Homun process; an explicit inventory is copied into the readiness log.

- [ ] **Step 3: Create a private backup with an explicit bounded target**

Run:

```bash
mkdir -p /Users/fabio/Backups/Homun
backup_dir="$(mktemp -d /Users/fabio/Backups/Homun/presentation-20260722-XXXXXX)"
case "$backup_dir" in
  /Users/fabio/Backups/Homun/presentation-20260722-*) ;;
  *) echo 'Unexpected backup path' >&2; exit 2 ;;
esac
printf '%s\n' "$backup_dir" > /Users/fabio/Projects/Homun/launch/presentation/rehearsal/backup-path.txt
ditto /Users/fabio/.homun "$backup_dir/.homun"
ditto '/Users/fabio/Library/Application Support/Homun' "$backup_dir/Application Support Homun"
```

Expected: two copied roots under one unique private backup directory.

- [ ] **Step 4: Verify backup size and database integrity**

Run a source/destination size comparison with `du -sk`. For every copied SQLite database run `sqlite3 <copied path> 'PRAGMA integrity_check;'`.

Expected: copied roots have coherent non-zero sizes and every database returns `ok`. Record the backup path and exact restore direction in the readiness checklist.

- [ ] **Step 5: Perform the supported in-app factory reset**

Reopen Homun and use its documented total local-data reset UI. Read the resolved target summary, confirm only after the previous step, and allow the application to restart.

Expected: onboarding appears; no previous chat, project, memory, connection or artifact is visible. If any previous state remains, stop and do not manually delete additional files.

### Task 7: Configure the sanitized Project Atlas workspace and integrations

**Files:**
- Read: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/`
- Modify through Homun UI: provider, Project Atlas, Brand Kit, MCP, Telegram and optional WhatsApp configuration
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/readiness-checklist.md`

- [ ] **Step 1: Finish onboarding without exposing credentials**

Configure the already authorized provider through Homun's secure UI. Do not record or paste keys into launch files, logs or screenshots. Run one disposable greeting in a temporary chat, then remove the chat if the product supports it.

Expected: the chosen provider/model responds and its name is recorded without credentials.

- [ ] **Step 2: Create only Project Atlas**

Create the project and connect `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas` as its working directory.

Expected: sidebar contains no personal project; Project Atlas artifacts resolve only inside the sanitized directory.

- [ ] **Step 3: Connect the bounded Filesystem MCP**

In MCP settings create `Project Files` with:

```text
Transport: stdio
Command: npx
Arguments: -y @modelcontextprotocol/server-filesystem /Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas
```

Expected: connected tool catalogue includes read/list/search capabilities. A read request inside Project Atlas succeeds; a request for `/Users/fabio/.homun` is refused or outside the configured root.

- [ ] **Step 4: Configure the Homun Brand Kit**

Use the current Homun wordmark, Inter typography and the approved site colors already present in the presentation package. Select the same clean pitch template used during verified Presentations testing.

Expected: a one-slide test artifact visibly uses Homun branding and the selected template route rather than a generic document route.

- [ ] **Step 5: Connect Telegram to one allowlisted demo destination**

Use the secure channel UI; never write the token or destination identifier into a file. Send a manual non-automation message `Project Atlas channel check` and verify the same test destination receives it.

Expected: one sanitized destination, successful delivery and no personal chats visible.

- [ ] **Step 6: Evaluate WhatsApp eligibility without assuming it is live-ready**

Connect only a sanitized test session if available. Verify an inbound message from the allowlisted test contact appears in Homun and a reply returns to the same channel.

Expected: mark `candidate` only after one clean exchange; three-trial promotion occurs in Task 10. If no sanitized session exists, keep WhatsApp out of the live route and prepare only an honest explanation.

### Task 8: Rehearse UNDERSTAND and REMEMBER three times

**Files:**
- Read: `/Users/fabio/Projects/Homun/launch/presentation/content/demo-prompt-catalog-it.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/query-test-log.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/evidence/understand-memory-*`

- [ ] **Step 1: Reset the chapter start state**

Start a fresh Project Atlas conversation with no approved positioning decision. Verify the PDF is attached and `Project Files` is connected.

Expected: only sanitized files and the selected provider are visible.

- [ ] **Step 2: Run Prompts 1–3 with one timer**

Record selected tools, whether MCP was actually invoked, every cited source and the total duration.

Expected: Prompt 1 distinguishes all three file formats; Prompt 2 uses official live sources; Prompt 3 proposes three options and does not create memory before approval.

- [ ] **Step 3: Run Prompts 4–5 and inspect provenance**

Approve the exact position, open the resulting memory/source record, create a new Project Atlas conversation and run Prompt 5.

Expected: four approved themes return with sources; rejected options are not represented as approved decisions; no cross-project fact appears.

- [ ] **Step 4: Repeat from a clean start two more times**

Use new conversations and restore the chapter state between trials. Do not count repeated inspection of the same completed result as a new trial.

Expected: three independent passes. If web verification alone misses the four-minute gate, classify it for a same-build clip while keeping document/MCP analysis live.

### Task 9: Rehearse ACT three times

**Files:**
- Read/modify during demo: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard/`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/query-test-log.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/evidence/act-*`

- [ ] **Step 1: Restore and verify the deliberate baseline**

Run:

```bash
/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard/scripts/reset-demo.sh
cd /Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/dashboard
npm test
```

Expected: two passing baseline tests and `||` still present in `src/readiness.ts`.

- [ ] **Step 2: Run Prompt 6 and reject premature mutation**

Expected: Homun identifies the missing conjunction/regression case, proposes a minimal plan and leaves Git status clean.

- [ ] **Step 3: Run Prompt 7 and verify the exact change**

Expected: `||` becomes `&&`; one regression test covers `{ modelConfigured: true, memoryIndexed: false }`; all tests pass; diff contains no unrelated file.

- [ ] **Step 4: Run Prompt 8 through the controlled computer**

Start the local server, verify the false state shows `Not ready`, switch to the true state and verify `Ready`. Capture evidence from the Homun computer surface, not a separate browser controlled by the operator.

Expected: plan, tool activity and both visual states are present; no external site or application opens.

- [ ] **Step 5: Repeat the complete chapter twice more**

Expected: three passes within five minutes each. If only the controlled-computer portion is intermittent, classify only that portion for a clip; code analysis, approval, tests and diff stay live.

### Task 10: Rehearse CONTINUE three times and decide the live channel set

**Files:**
- Read: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/materials/launch-constraints.csv`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/query-test-log.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/evidence/continue-*`

- [ ] **Step 1: Verify deterministic input and destination**

Confirm `ATL-004` is the only blocked P0/P1 row and the selected Telegram destination is the sanitized demo destination.

Expected: no automation from a previous trial remains active.

- [ ] **Step 2: Run Prompt 9 and inspect before approval**

Expected: recurrence is every five minutes, source is Project Files MCP, filter matches only blocked P0/P1 rows, Telegram destination is correct and the automation remains inactive.

- [ ] **Step 3: Run Prompt 10 and verify one immediate delivery**

Expected: exactly one message names `ATL-004`, `Launch team`, the approval block and the next action; the UI shows the next scheduled run.

- [ ] **Step 4: Disable the automation immediately**

Expected: the rule is visibly inactive and no second message arrives during a five-minute observation window.

- [ ] **Step 5: Test optional WhatsApp continuity**

From the sanitized test contact send `Qual è lo stato di Project Atlas e qual è il blocco prioritario?`.

Expected: the conversation is associated with Project Atlas and the reply returns on the same channel without showing unrelated chats.

- [ ] **Step 6: Repeat from a clean automation state twice more**

Expected: Telegram must pass three times within three minutes. WhatsApp enters the live route only if it also passes three times; otherwise its status is `clip` or `explanation`, never `live`.

### Task 11: Rehearse DELIVER three times

**Files:**
- Modify through Homun: Project Atlas Presentations artifacts
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/query-test-log.md`
- Create: `/Users/fabio/Projects/Homun/launch/presentation/demo/project-atlas/evidence/deliver-*`

- [ ] **Step 1: Verify the prerequisite decision and Brand Kit**

Expected: approved decision and sources are visible in project memory; selected Homun Brand Kit and clean pitch template are active.

- [ ] **Step 2: Run Prompt 11 without restating the approved themes**

Expected: plan appears within 30 seconds and explicitly uses the project decision and verified sources.

- [ ] **Step 3: Inspect the complete five-slide artifact**

Open cover, architecture, evidence, roadmap and artifact entry. Verify English content, Homun branding, correct template routing, source visibility and separation of current proof from future direction.

Expected: PPTX, PDF and HTML open; the artifact is associated with Project Atlas; no unsupported claim appears.

- [ ] **Step 4: Repeat from a fresh artifact state twice more**

Expected: three plans within 30 seconds and three previews within four minutes. If rendering misses the gate, use the immediately preceding verified artifact while keeping plan/tool activity live.

### Task 12: Diagnose presentation blockers without broadening scope

**Files:**
- Modify only after root-cause evidence: exact Homun files implicated by an observed failed gate
- Test: nearest targeted unit/integration test for the implicated behavior
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/query-test-log.md`

- [ ] **Step 1: Classify every failed gate**

Use exactly one classification:

```text
data/setup error
prompt ambiguity
current product defect
environment/network variability
future capability incorrectly assumed
```

Expected: each failure has evidence, reproduction steps and one owner; no speculative code change.

- [ ] **Step 2: Fix data or prompt problems outside product code**

For deterministic input or wording failures, change only the Project Atlas material or prompt catalogue, rerun the affected prompt three times and record both versions.

Expected: no Homun repository change for a demo-data problem.

- [ ] **Step 3: Route confirmed product defects through systematic debugging**

Invoke `superpowers:systematic-debugging`, reproduce on the current branch, identify the first incorrect state transition and write a failing targeted test before implementation. Then invoke `superpowers:test-driven-development` for the minimal fix.

Expected: one focused bugfix commit per confirmed blocker, no unrelated refactor, targeted tests pass and the original demo gate passes three times. If the exact fix cannot be safely verified before the event, replace the module or use the honest fallback.

- [ ] **Step 4: Record non-fix decisions explicitly**

For environment variability or future-only capability, set the route to `clip`, `explanation` or `cut` with the reason and the exact sentence Fabio will use.

Expected: no flaky path remains labelled `live`.

### Task 13: Finalize transcript, prompts, runbook and Q&A from observed behavior

**Files:**
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/content/presentation-transcript-it.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/content/presentation-transcript-35m-it.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/content/presenter-anchor-sheet-it.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/content/demo-prompt-catalog-it.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/content/q-and-a-it.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/demo-runbook-it.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/content/speaker-notes-it.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/source/build-deck.mjs`
- Replace notes only: `/Users/fabio/Projects/Homun/launch/presentation/homun-independent-ai-workspace.pptx`

- [ ] **Step 1: Replace planned UI language with observed labels**

Use exact names seen in the current build for Project, Memory, Sources, Plan, Tools, Automations, Channels, MCP and Presentations. Do not retain an instruction for a control that was not observed.

Expected: every click instruction maps to a visible current control or a declared fallback.

- [ ] **Step 2: Insert measured timings and stop points**

Use the slowest passing trial plus a 15% buffer. Keep the full tour at or below 20 minutes and the whole presentation at or below 45 minutes.

Expected: short route remains at or below 35 minutes without changing the conclusion.

- [ ] **Step 3: Update answers with verified current facts**

Use the current app, `LICENSE.md`, public roadmap and successful trials. Mark unsupported or future behavior explicitly.

Expected: no answer depends on an unverified marketing inference.

- [ ] **Step 4: Synchronize the deck's Italian presenter notes**

Replace the obsolete 37-minute connected-demo note set with concise notes derived from the full transcript. Slides 10–11 introduce and close the five-chapter tour; no note instructs Fabio to execute the old one-request-only flow. Rebuild the editable PPTX with `source/build-deck.mjs` while leaving slide copy, geometry and images unchanged.

Render the rebuilt PPTX to sixteen PNGs and compare them to `rehearsal/visual-baseline` with:

```bash
for baseline in /Users/fabio/Projects/Homun/launch/presentation/rehearsal/visual-baseline/slide-*.png; do
  name="$(basename "$baseline")"
  metric="$(magick compare -metric RMSE \
    "$baseline" \
    "/Users/fabio/Projects/Homun/launch/presentation/assets/screenshots/$name" \
    null: 2>&1 || true)"
  printf '%s %s\n' "$name" "$metric"
  test "$metric" = '0 (0)'
done
```

Every slide must return `0 (0)`; a non-zero result means the visual deck changed and the rebuilt PPTX must not replace the approved file.

Expected: updated embedded notes, pixel-identical slide surfaces, 16 notes sections and no visual change.

- [ ] **Step 5: Run the final content scans**

Run:

```bash
! rg -n 'TBD|TODO|PLACEHOLDER|lorem ipsum' /Users/fabio/Projects/Homun/launch/presentation/content /Users/fabio/Projects/Homun/launch/presentation/rehearsal
test "$(rg -c '^## Slide (0[1-9]|1[0-6])' /Users/fabio/Projects/Homun/launch/presentation/content/presentation-transcript-it.md)" -eq 16
test "$(rg -c '^## Prompt (0[1-9]|1[01])' /Users/fabio/Projects/Homun/launch/presentation/content/demo-prompt-catalog-it.md)" -eq 11
test "$(rg -c '^## Q[0-9]{2} ' /Users/fabio/Projects/Homun/launch/presentation/content/q-and-a-it.md)" -ge 24
```

Expected: all scans pass.

### Task 14: Record only the required fallback clips

**Files:**
- Create as required: `/Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips/understand-web.mov`
- Create as required: `/Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips/computer-control.mov`
- Create as required: `/Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips/whatsapp-continuity.mov`
- Create as required: `/Users/fabio/Projects/Homun/launch/presentation/assets/backup-clips/presentation-output.mov`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/final-manifest.sha256`

- [ ] **Step 1: Derive the clip list from failed or variable gates**

Do not record a clip for a module that passed reliably unless it is the offline artifact fallback. Record only the failed step, from the same current build and sanitized Project Atlas state.

Expected: clip list matches `query-test-log.md` route decisions.

- [ ] **Step 2: Capture silent full-frame evidence**

Use no microphone input, disable notifications, keep pointer movement calm and avoid all system or personal windows. Preserve the raw `.mov`.

Expected: beginning, middle and end contain only Homun and Project Atlas.

- [ ] **Step 3: Verify playback and privacy**

Open every clip locally, inspect at full resolution and confirm it works without network access. Record duration and route entry point in the runbook.

Expected: one-click local playback; no secret, contact, notification or unrelated file path.

- [ ] **Step 4: Add clip hashes to the manifest**

Run:

```bash
cd /Users/fabio/Projects/Homun/launch/presentation
find assets/backup-clips -maxdepth 1 -type f -name '*.mov' -print \
  | sort \
  | while IFS= read -r clip; do shasum -a 256 "$clip"; done \
  >> rehearsal/final-manifest.sha256
```

Expected: one unique checksum line per actual clip.

### Task 15: Run two complete rehearsals and make the GO/NO-GO decision

**Files:**
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/rehearsal-log.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/readiness-checklist.md`
- Modify: `/Users/fabio/Projects/Homun/launch/presentation/rehearsal/final-manifest.sha256`

- [ ] **Step 1: Run the complete presentation with one timer**

Deliver all 16 slides, five demo chapters and closing. Do not pause the timer for loading or fallback transitions.

Expected: 42–45 minutes before questions; every live step follows the final runbook.

- [ ] **Step 2: Run the complete presentation a second time from reset state**

Restore the dashboard baseline, remove or archive prior demo artifacts, disable stale automations and start new Project Atlas conversations.

Expected: second independent route also completes within 45 minutes with no privacy exposure.

- [ ] **Step 3: Exercise the short route and three safe audience requests**

Run the 35-minute transcript and these safe requests:

```text
Compare two document claims and show their sources.
Recall the approved position and explain its evidence.
Explain the regression test without changing code.
```

Expected: every request finishes within two minutes and remains inside Project Atlas.

- [ ] **Step 4: Verify offline and fallback operation**

Open the approved deck/PDF and every required clip with network unavailable. Do not attempt live web, provider or channel operations in this route.

Expected: presentation can still reach the closing honestly using local evidence.

- [ ] **Step 5: Finalize the manifest and record GO or NO-GO**

Run:

```bash
cd /Users/fabio/Projects/Homun/launch/presentation
: > rehearsal/final-manifest.sha256
shasum -a 256 \
  homun-independent-ai-workspace.pptx \
  homun-independent-ai-workspace.pdf \
  homun-independent-ai-workspace.html \
  content/slide-copy-en.md \
  content/speaker-notes-it.md \
  content/presentation-transcript-it.md \
  content/presentation-transcript-35m-it.md \
  content/presenter-anchor-sheet-it.md \
  content/demo-prompt-catalog-it.md \
  content/q-and-a-it.md \
  >> rehearsal/final-manifest.sha256
find assets/backup-clips -maxdepth 1 -type f -name '*.mov' -print \
  | sort \
  | while IFS= read -r clip; do shasum -a 256 "$clip"; done \
  >> rehearsal/final-manifest.sha256
find demo/project-atlas -type f -not -path '*/.git/*' -print \
  | sort \
  | while IFS= read -r demo_file; do shasum -a 256 "$demo_file"; done \
  >> rehearsal/final-manifest.sha256
shasum -a 256 -c rehearsal/final-manifest.sha256
```

Mark `GO` only if the two complete rehearsals pass, the transcript and prompts are final, privacy checks pass, each live module has three passes, and every fallback opens locally. Otherwise mark `NO-GO` and use the PDF/clip route.

Expected: explicit signed result in `readiness-checklist.md`; no ambiguous “mostly ready” state.
