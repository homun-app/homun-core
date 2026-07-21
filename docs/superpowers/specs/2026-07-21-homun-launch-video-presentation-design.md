# Homun launch videos and product presentation design

**Date:** 2026-07-21
**Status:** Approved design, pending user review of this written specification
**Primary deadline:** product presentation on 2026-07-22
**Public content language:** English
**Presentation delivery:** spoken Italian, English slides, Italian live prompts

## Purpose

Create one coherent launch story that can support:

1. a 35–40 minute mixed-audience product presentation;
2. a reusable library of English product videos for articles, documentation, the
   website, launch posts and social distribution;
3. a 75–90 second Homun launch film assembled from the reusable feature modules;
4. a repeatable capture workflow that remains useful as the product evolves.

The presentation and videos must start from Homun's philosophy, prove the product with
real UI and real outputs, and explain the roadmap and business model without creating
provider, account or seat lock-in.

## Verified starting point

The launch folder already provides a coherent positioning, English channel copy, X and
Discord assets, a staged go-to-market playbook and a silent-demo direction. It does not
yet contain video masters, storyboards, reusable edit components or a presentation deck.

The current public product surface supports the chosen story:

- Homun presents itself as an independent, model-independent AI workspace;
- the public homepage separates the stable system from replaceable model engines;
- the public roadmap progresses from Operational Workspace to Flow, Team, official
  workflow products and Company Intelligence;
- the marketplace currently contains official free Proactivity and Presentations
  add-ons;
- release `v0.1.1072` has macOS, Windows and Linux installers.

Two public-product inconsistencies must not be hidden in launch preparation:

- the roadmap's release-evidence block still shows `v0.1.1060` while `v0.1.1072` is
  current;
- the getting-started guide describes the contained Docker computer as optional and
  says the app bundles its backend, while the current onboarding UI presents Docker and
  Ollama as first-run prerequisites.

These inconsistencies are launch-readiness follow-ups. They do not change the approved
presentation story, but the onboarding recording must show the real current behavior.

## Product thesis

### Primary message

> The model is an engine. Your work remains the system.

Homun aims to provide the durable workspace and agentic capabilities associated with
Claude and Codex without making one closed provider the permanent owner of the user's
projects, memory, tools and working continuity.

### Supporting promise

> Your work. Your models. Your system.

Homun combines:

- provider choice across compatible cloud, open-weight and local models;
- project continuity and inspectable memory;
- visible plans, tools, permissions and approvals;
- real deliverables, including documents and presentations;
- a controlled local computer, channels and automations;
- public source and a core that remains available rather than becoming a closed access
  gate.

### License language

The presentation must be precise with a technical audience. The current code license is
FSL-1.1 with an Apache 2.0 future license effective on the second anniversary of each
version. Public copy may describe the product philosophy as an open core or publicly
available core, but must not imply that FSL-1.1 is an OSI-approved open-source license on
day one.

## Business model

Homun monetizes capabilities, not access.

### Always open and free

- the core product;
- Personal use;
- Team capabilities and collaboration;
- provider choice and the ability to self-host the core experience;
- no per-seat charge and no mandatory team subscription.

### Paid value

- official plugins and workflow products, purchased once for a team;
- a perpetual license for the purchased major version;
- paid major upgrades;
- optional paid support;
- paid customization, implementation and integration work;
- later, a revenue share on third-party marketplace sales.

The adoption thesis is that a company should be able to standardize on Homun without
incurring a seat tax. It pays when it wants a ready-to-use operational capability or
specialized implementation.

## Presentation design

### Narrative approach

Use **Philosophy → Proof → Product**. Borrow a short teaser from a demo-first structure,
but do not open with a risky live demo or an architecture lecture.

### Timing

| Act | Duration | Purpose |
| --- | ---: | --- |
| Why Homun exists | 6–7 min | Establish the provider-dependency problem and Homun principle |
| What the product is | 7–8 min | Explain the stable workspace, replaceable engines and visible capabilities |
| Connected product demo | 11–13 min | Prove multilingual work, deliverables, memory and provider independence |
| Roadmap and business model | 6–7 min | Show the product path and adoption-first monetization |
| Current proof and close | 2 min | Establish availability and repeat the core message |
| Questions | remaining time | Technical, product and business discussion |

### Slide sequence

All slide titles and concise on-slide copy are in English. Fabio explains them in
Italian.

1. **Homun — The independent AI workspace**
   `Your work. Your models. Your system.`
2. **Powerful tools. Closed continuity.**
   Explain the dependence created when projects, memory and workflows belong to one
   provider.
3. **The model is an engine. The workspace is the system.**
   Introduce Homun's core principle.
4. **One system. Replaceable engines.**
   Show Projects, Memory, Tools and Permissions as the stable layer, with cloud,
   open-weight and local models above it.
5. **Real work, not isolated prompts.**
   Show the capability map: software work, deliverables, local computer, channels,
   automations and approvals.
6. **Product proof in sixty seconds.**
   Play a short teaser assembled from the reusable onboarding, memory, presentation,
   computer and approval modules.
7. **One request. A connected workflow.**
   Introduce the live demo and its expected outcome.
8. **What just happened?**
   Recap the visible plan, selected engine, tools, artifact, memory and source.
9. **From capable workspace to coordinated work.**
   Operational Workspace → Flow → Open Team → Company Intelligence.
10. **Open adoption.**
    Core, Personal and Team remain open and free; no seat tax.
11. **We monetize capabilities, not access.**
    One-time plugin purchases, paid major upgrades, support, customization and future
    marketplace revenue share.
12. **Available now. Built to keep growing.**
    Public source, releases for macOS/Windows/Linux, documentation and community.
13. **Your work. Your models. Your system.**
    Close on `homun.app` and enter questions.

### Live demo design

The demo is one connected story, not a tour through settings pages.

1. Start from the user's real Homun demo profile after the approved clean start.
2. Show a short recorded onboarding module rather than spending live time downloading a
   model or waiting for prerequisites.
3. Enter an Italian prompt that requests a concrete English deliverable:

   > Prepara una presentazione in inglese per il lancio di Project Atlas. Il pubblico è
   > tecnico: evidenzia modello multi-provider, memoria ispezionabile e controllo delle
   > azioni.

4. Show the visible plan and progress instead of hiding the wait.
5. Generate a template-driven English presentation and open the real artifact preview.
6. Open a new chat in the same project and ask an Italian follow-up that requires recall
   of a prior decision.
7. Show the recalled source in inspectable memory.
8. If the path is stable during rehearsal, switch model provider for a follow-up while
   retaining the same project context.
9. Use reusable backup clips for the contained computer, takeover/approval and memory
   graph/forget flows rather than depending on network or Docker timing during the live
   demo.

The live demo proves that Italian input can drive English work. The language change is a
capability demonstration, not an inconsistency.

## Reusable video system

### Production principle

Record reusable product truth first. Build channel-specific edits second. Assemble the
launch film only after the strongest feature modules exist.

Do not bake dates, release numbers, channel logos, campaign names or launch-specific
calls to action into feature footage.

### Feature package

Every feature package contains:

1. a 60–120 second clean 16:9 master capture;
2. a 20–45 second canonical story module with a hook, visible action and outcome;
3. a captioned 16:9 article/documentation version;
4. a 4:5 social version;
5. a 9:16 short version only when the desktop UI remains readable;
6. a 6–12 second loop suitable for lightweight embeds or GIF/WebM conversion;
7. selected still frames for article illustrations and thumbnails;
8. an English subtitle file in addition to any burned-in social captions.

### Reusable layers

- untouched product footage;
- replaceable hook/title card;
- English captions;
- optional zoom and focus callouts;
- optional music that never carries essential meaning;
- neutral `homun.app` end card;
- removable campaign or channel CTA.

The videos are silent-first and understandable without audio. Generated visual material
may be used for short abstract intro/outro motion, but product behavior is always shown
with the real Homun UI.

### Capture rules

- Published recordings use English UI and English prompts.
- The presentation's live prompt remains Italian.
- Use demo-only content with no private customer data, keys or personal identifiers.
- Move the pointer deliberately and keep important text readable.
- Record extra clean time before and after each action to leave editing handles.
- Capture one feature and one outcome per master flow.
- Avoid notifications, unrelated windows and transient personal data.
- Retain clean masters even after final exports.

### Initial evergreen modules

| Module | Canonical story | Primary proof |
| --- | --- | --- |
| 01 · Meet Homun | Onboarding and model choice | Local-first start with provider freedom |
| 02 · Memory you can read | Recall, graph, wiki and forget | Inspectable and correctable continuity |
| 03 · A computer you control | Visible browser, permission and takeover | Agentic power under user control |
| 04 · Models are engines | Local/cloud selection and continuity | The workspace survives engine changes |
| 05 · From work to deliverable | Create and preview a presentation | Real output, not chat-only assistance |
| 06 · Work that continues | Automation, channel and approval | Work can begin later or from an event |

### Assembly order

1. onboarding module;
2. memory module;
3. computer/control module;
4. provider-independence module;
5. deliverables module;
6. automations/channels module;
7. 60-second presentation teaser;
8. 75–90 second launch film;
9. channel-specific derivatives.

## User-data and reset policy

The user's existing Homun profile is the authorized demo profile. No separate Homun
profile is created.

Before any destructive factory reset:

1. locate the exact active Homun data directory;
2. create a timestamped backup outside that directory;
3. verify the backup contains the expected database, configuration and asset structure;
4. record the restoration path;
5. perform the reset only after the backup is verified;
6. confirm the application opens at onboarding and no private content remains visible.

The factory reset is not part of the design phase. It occurs only during the approved
production plan.

## Visual direction

- Reuse the current Homun dark surface, teal accent and wordmark.
- Prefer real UI scale and legibility over cinematic distortion.
- Use minimal motion graphics: short title cards, focus callouts and neutral transitions.
- Keep typography large enough for article embeds and presentation projectors.
- Use the same caption, title and end-card system across every module.
- Avoid stock footage, synthetic presenters and generated fake interfaces.

## Verification

### Presentation

- rehearse the complete deck once at normal speaking speed;
- verify the deck fits 35–40 minutes before questions;
- run the live demo from the same clean state intended for the event;
- confirm every generated artifact opens and visually matches its selected template;
- confirm the memory follow-up recalls the intended decision and displays a source;
- verify provider switching only if it is included in the live path;
- keep local backup clips immediately accessible without changing applications visibly;
- test the projector/display aspect ratio and text size.

### Videos

- review each clean master for private data and notifications before editing;
- verify captions against the actual UI action and result;
- verify each canonical feature module makes sense without surrounding narration;
- inspect every export at its target aspect ratio;
- confirm UI text remains readable in vertical derivatives; omit vertical versions when it
  does not;
- verify article versions work without platform-specific CTA or audio;
- preserve subtitle, thumbnail and clean-master assets alongside final exports.

## Success criteria

- A mixed technical audience can explain Homun in one sentence after the opening act.
- The demo proves a connected outcome rather than listing unrelated features.
- The business model is understood as open adoption plus paid capabilities, not a free
  trial leading to seat subscriptions.
- Every launch-film product moment comes from a reusable feature module.
- Each module can be embedded in an article without re-editing its core story.
- No public artifact overstates the current license, release evidence or product behavior.

## Non-goals

- changing Homun's software license in this work;
- implementing product fixes before the presentation unless a rehearsal exposes a
  presentation-blocking defect;
- publishing posts, articles or social content before the reusable masters are approved;
- producing synthetic presenter or talking-head footage;
- creating a separate demo user profile;
- monetizing core or Team access through subscriptions or per-seat pricing.
