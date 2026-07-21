# Homun launch videos and product presentation design

**Date:** 2026-07-21
**Status:** Redesign approved in conversation, pending user review of this written specification
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
yet contain video masters, storyboards or reusable edit components.

An initial presentation deck was produced and explicitly rejected. Its narrative felt
generic and instructional rather than strategic, while its repeated dark rectangles,
simple circles and arrows reproduced only the website palette instead of the website's
actual visual identity. The rejected deck is evidence of what not to iterate on: the new
deck starts from a new narrative and directly reuses the current homun.app visual system.

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

> Use the best model. Keep the right to leave.

Claude, Codex and other leading closed products establish a high standard. Homun does
not claim that independence requires accepting a worse model. It exists so that using
the best available intelligence does not make one provider the permanent owner of the
user's projects, memory, tools and working continuity.

The presentation must not allege that providers currently discriminate between users.
It may state the durable risk plainly: pricing, policies, geographic availability,
access tiers and model allocation can change. Homun is designed so that such a change
does not require rebuilding the user's system of work.

### Supporting promise

> Your work. Your models. Your system.

Homun combines three layers:

1. **Independence:** provider choice across compatible cloud, open-weight and local
   models, while projects, memory, tools and permissions remain the stable system.
2. **Specialization:** plugins combine tools, workflows, skills, templates, connectors,
   permissions and review rules to turn a general workspace into a vertical product.
3. **Ecosystem:** a curated marketplace lets registered developers and companies build,
   verify and sell trusted plugins while Homun earns a commission.

The supporting statements are:

> The model is replaceable. Your work is not.

> Models provide intelligence. Homun provides continuity and control. Plugins provide
> specialization.

> Intelligence is horizontal. Work is vertical.

### License language

The presentation must be precise with a technical audience. FSL-1.1 permits use,
copying, modification, derivative works and redistribution for permitted purposes. It
prevents the code from being used to offer a competing commercial product or service.
Each version receives an irrevocable Apache 2.0 future license effective on its second
anniversary.

The deck must not reduce FSL to "view-only" and must not imply that it is an
OSI-approved open-source license on day one. The concise presentation language is:

> Source available now. Apache 2.0 over time.

> Inspect it. Run it. Modify it. The FSL protects Homun from competing commercial
> reuse—not from its users.

## Business model

Homun monetizes capabilities and ecosystem value, not access.

### Always open and free

- the core product;
- Personal use;
- Team capabilities and collaboration;
- provider choice and the ability to self-host the core experience;
- no per-seat charge and no mandatory team subscription.

### Paid value and ecosystem

- official plugins and workflow products, purchased once for a team;
- a perpetual license for the purchased major version;
- paid major upgrades;
- optional paid support;
- paid customization, implementation and integration work;
- later, marketplace commission on plugins sold by registered developers and companies.

The adoption thesis is that a company should be able to standardize on Homun without
incurring a seat tax. It pays when it wants a ready-to-use operational capability or
specialized implementation. In the long term, marketplace commission is intended to be
Homun's primary scalable revenue source.

Marketplace publication is curated rather than permissionless. A developer or company
registers, accepts the program terms, uses official development and verification tools,
passes automated and human review, publishes a signed plugin and receives revenue after
Homun's commission. Review covers security, privacy, permissions, compatibility,
declared behavior and quality. The deck presents this as the long-term platform vision,
not as a currently available feature.

## Presentation design

### Narrative approach

Use **Independence → Specialization → Ecosystem**, with the live product demo as proof
between the specialization and ecosystem acts.

The opening acknowledges the excellence of leading closed tools. It then asks a sober
question about autonomy rather than attacking competitors. The story moves from why an
independent workspace matters, to how plugins create vertical depth, to how a curated
marketplace can fund the project without charging for access.

### Timing

| Act | Duration | Purpose |
| --- | ---: | --- |
| Independence | 6–7 min | Credit the current leaders, establish the autonomy question and Homun principle |
| The Homun system | 5–6 min | Explain the stable workspace, replaceable engines and inspectable foundation |
| Specialization | 4–5 min | Show why models are horizontal and plugins create vertical products |
| Connected product demo | 10–12 min | Prove multilingual work, deliverables, memory and provider independence |
| Ecosystem and business | 6–7 min | Explain curated developers, marketplace review and aligned monetization |
| Current proof, roadmap and close | 3 min | Separate present, next and future, then repeat the core message |
| Questions | remaining time | Technical, product and business discussion |

### Slide sequence

All slide titles and concise on-slide copy are in English. Fabio explains them in
Italian.

1. **Homun — The independent AI workspace**
   `Your work. Your models. Your system.`
2. **The best AI tools are also deep dependencies.**
   Credit the quality of Claude, Codex and the current leaders before showing how their
   vertically integrated workspaces create dependency.
3. **Use the best. Keep the right to leave.**
   Present changing price, policy, geography and access as architectural risks, not as
   accusations about current provider behavior.
4. **The model is replaceable. Your work is not.**
   Introduce Homun's core principle.
5. **One system. Replaceable engines.**
   Show Projects, Memory, Tools and Permissions as the stable layer, with compatible
   cloud, open-weight and local models as replaceable engines.
6. **Independence has to be structural.**
   Connect model choice, local data, inspectable memory, exportability and the FSL to
   the same autonomy promise.
7. **Real work, not isolated prompts.**
   Show current product evidence: software work, deliverables, local computer, channels,
   automations, visible tools and approvals.
8. **Intelligence is horizontal. Work is vertical.**
   Explain why a capable model is not yet a specialized product.
9. **Plugins turn a workspace into a profession.**
   Show tools, workflows, skills, templates, connectors, permissions and review rules as
   the anatomy of a vertical capability.
10. **One request. A connected workflow.**
    Introduce the live demo and name the concrete English deliverable it will create
    from an Italian request.
11. **What just happened?**
    Recap the visible plan, selected engine, tools, artifact, memory and source.
12. **One open system. Many professions.**
    Separate current general capabilities, official vertical plugins next and the
    external developer ecosystem later.
13. **Open does not mean ungoverned.**
    Show the future path from registered developer to tools, automated checks, Homun
    review, signed publication, sales and updates.
14. **We monetize capabilities, not access.**
    Show free Core/Personal/Team, one-time plugin purchases, paid major upgrades,
    support, customization and future marketplace commission.
15. **Available now. Building next. Designed for later.**
    State current product truth, near-term official plugins and long-term marketplace
    vision in visibly separate lanes.
16. **Your work. Your models. Your system.**
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

The approved direction is **Site-native keynote**. The presentation must not merely use
colors inspired by homun.app. It directly reuses the current website's visual system and
existing illustration assets, adapting them to 16:9 compositions.

### Source of truth

- current `homun.app` production rendering;
- `website/src/styles/global.css` for typography, color and surface tokens;
- the current Homun wordmark assets;
- `WorkshopIllustration`, `EngineTransition`, `MemoryContinuityIllustration`,
  `ConnectedWorkspaceIllustration`, `EcosystemIllustration`,
  `RoadmapOrbitIllustration` and other current website illustration components;
- current product screenshots captured from the running Homun build.

The website palette is used exactly: near-black `#050807`, raised green-black surfaces,
cream typography, muted green-gray copy and bright teal `#50dfc5`. Blue, pink and yellow
retain the semantic roles established by the site's illustrations; they are not generic
decorative accents. Headings use Inter Variable and technical labels use the site's
monospace treatment.

### Slide grammar

- manifesto openings pair large editorial typography with an actual Homun illustration;
- single-statement transitions use atmosphere, grain, glow and a restrained section
  label rather than empty black templates;
- system and ecosystem explanations adapt existing Homun illustration geometry and
  labeled technical panels rather than using generic circle-and-arrow diagrams;
- product-proof slides use large, current UI crops with the website's device treatment;
- marketplace and business slides extend the website's ecosystem visual grammar without
  introducing a disconnected presentation template;
- the closing slide uses the same wordmark, headline and atmospheric treatment as the
  public brand surface.

Every conceptual slide must have a primary visual derived from an existing website
illustration or from a deliberate extension of that exact visual grammar. Every product
claim must be supported by current UI evidence or clearly labeled as `Building next` or
`Long-term vision`.

Avoid stock footage, synthetic presenters, generated fake interfaces, generic icon
libraries, decorative card grids, repeated centered-title templates and elementary
circles/arrows. Keep real UI readable at projector distance.

### Visual approval gate

Before building all sixteen slides, render three finished representative slides:

1. the opening manifesto;
2. the stable-system / replaceable-engines architecture;
3. the curated marketplace vision.

Compare them at full size with the current website. Full-deck production starts only
after those three slides visibly belong to the same brand system.

## Verification

### Presentation

- compare the three-slide visual checkpoint with current homun.app before full-deck
  production;
- confirm conceptual visuals reuse the actual website assets or their exact visual
  grammar rather than merely matching the palette;
- confirm every product screenshot comes from the current running Homun build;
- confirm `Available now`, `Building next` and `Long-term vision` remain visually and
  verbally distinct;
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
- The audience can distinguish the two reasons Homun exists: provider independence and
  plugin-driven specialization.
- The demo proves a connected outcome rather than listing unrelated features.
- The business model is understood as open adoption plus paid capabilities, not a free
  trial leading to seat subscriptions.
- The marketplace is understood as a curated future developer ecosystem and Homun's
  intended primary scalable revenue source, not as a currently available store.
- A side-by-side comparison makes the presentation visually recognizable as the same
  brand system as homun.app.
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
