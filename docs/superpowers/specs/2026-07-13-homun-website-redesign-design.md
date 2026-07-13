# Homun website redesign

**Date:** 2026-07-13

**Status:** Design approved in conversation; awaiting final spec review

**Target:** `homun.app`

## Objective

Redesign `homun.app` as the single public home of Homun: product story, documentation, Projects, Marketplace, and downloads. The site must explain Homun as a complete AI work environment whose defining advantage is autonomy from any single model provider.

The first release does not compare Homun directly with Codex, Claude Code, or other products. A future comparison may be published only as a reproducible benchmark covering the complete work experience rather than a narrow feature table.

## Product position

Homun separates the work environment from the model that powers it. People keep the same projects, memory, tools, permissions, and workflows while choosing among compatible cloud providers, open-source models, and models running locally with adequate hardware.

The main promise is autonomy:

- choose and change the model without changing the work environment;
- use cloud, open-source, or local models according to the task;
- work on real projects, not only isolated conversations;
- create software, documents, presentations, research, and other deliverables;
- control local access, data, tools, and permissions.

Avoid absolute or unsupported claims such as “any model”, “same power as Codex”, “more private”, or “better than”. Use “compatible models and providers” and describe capabilities that are actually available.

## Communication policy

The first version tells Homun's own story and does not name competitors in the hero, feature sections, or marketing tables.

The category may be described without attacking other products. For example:

> Many AI tools are built around a single ecosystem. Homun is designed to let you change the model without changing your projects, tools, memory, or way of working.

A future benchmark page may compare products only when Homun can run documented, repeatable scenarios across:

- code generation and modification;
- documents and presentations;
- local-system operation;
- long-running project work;
- memory and context continuity;
- cloud, open-source, and local model support;
- permissions, account requirements, and infrastructure control.

Every future comparison must state the tested versions, date, environment, task, scoring method, and evidence.

## Visual direction

Use the approved **Precision Operator** direction:

- dark, technical, and cinematic rather than decorative;
- restrained near-black and deep green surfaces;
- bright mint accent for active state and primary actions;
- strong typography, compact labels, and generous spacing;
- product activity shown as credible live work, not generic AI artwork;
- subtle motion that communicates status, routing, or progress;
- screenshots and interface fragments used as evidence of the product.

The existing structural mockups are direction-setting drafts, not final visual design.

## Information architecture

`homun.app` contains:

- `/` — product narrative and primary download;
- `/product` — how Homun works and the complete work environment;
- `/models` — compatible providers, local and open-source models, routing, and requirements;
- `/projects` — public product ideas, planned work, voting, suggestions, and progress;
- `/marketplace` — official Homun plugins, initially all free;
- `/docs` — unified English and Italian documentation;
- `/download` — supported platforms, releases, and requirements;
- `/changelog` — shipped product changes;
- `/account` or equivalent authentication flow — optional ecosystem identity.

Documentation should live under `homun.app/docs`. The separate documentation repository can remain the editorial or synchronization source during migration, but users should experience one domain and one navigation system.

## Homepage narrative

The homepage tells one story in six sections.

### 1. Hero: autonomy

Lead with the freedom to choose the model, not with a catalogue of features.

Working message:

> **Your work. Your models. Your system.**
>
> Homun is an AI work environment that keeps your projects, memory, tools, and permissions together while you choose compatible cloud, open-source, or local models.

Primary action: **Download without registering**.

Secondary action: **See how Homun works**.

Do not imply that registration is required. Do not advertise platforms or releases that are not genuinely available.

### 2. Model freedom

Show that the model is a replaceable engine inside a persistent system. A credible routing/activity visual may show different tasks using different model types, but should avoid unsupported automatic-routing claims.

### 3. Real work

Demonstrate outcomes across several kinds of work: developing software, researching, producing documents and presentations, operating approved local tools, and continuing multi-step projects.

This section establishes that Homun is broader than a chat interface or coding assistant.

### 4. Local control

Explain local operation, explicit permissions, inspectable activity, and the option to use local models. Distinguish “can run locally” from “everything is always local”.

### 5. A living ecosystem

Introduce Marketplace and Projects together as evidence that Homun grows:

- Marketplace extends what Homun can do;
- Projects lets people see, support, and influence what Homun may do next.

### 6. Download

End with a direct, registration-free download action, platform truth, requirements, and links to getting started.

## Optional Homun account

The Homun application remains useful without registration. Core local work—including chat, models, projects stored locally, memory, and tools—must not be presented as account-gated.

An account is required only for account-scoped online actions:

- downloading and maintaining a Marketplace library;
- voting on Projects;
- suggesting new Projects;
- following project updates;
- future synchronized preferences or statistics, only when clearly disclosed and opted into.

Every account prompt must explain the specific online benefit instead of presenting login as the default entrance to Homun.

## Marketplace v1

The first Marketplace publishes only official Homun plugins and all listings are free.

Each listing includes:

- name, purpose, and publisher shown as Homun;
- compatibility and version requirements;
- permissions and capabilities requested;
- installation action that opens or communicates with the Homun app;
- release notes and update history;
- a clear “Free” label without implying that paid products already exist.

The architecture may allow paid products later, but pricing, checkout, subscriptions, and third-party publishing are outside the first version.

## Projects

Projects is a public, living product-development space rather than a static roadmap.

Every project has:

- a clear problem and intended outcome;
- status such as Exploring, Planned, In progress, or Shipped;
- updates and visible progress;
- vote count and follow action;
- suggestion and discussion entry points for signed-in users;
- links to related documentation, changelog entries, or Marketplace items when relevant.

Anyone may browse Projects. A Homun account is required to vote, follow, or suggest. Voting expresses interest and does not promise delivery dates or priority.

## Documentation

Documentation shares the product site's identity and navigation while retaining a reading-focused layout, search, table of contents, version awareness, and language selection.

Migration must reconcile duplicates between the existing website content and standalone documentation. A canonical source must be chosen for each page before redirects are introduced. Existing useful URLs should redirect to their new `homun.app/docs` destination.

## Content integrity

Before publication, every capability claim must be classified as:

- available now;
- in progress;
- planned or exploring.

The homepage emphasizes available capabilities. Projects holds future intent. Changelog records shipped work. This separation prevents planned capabilities from appearing as finished product behavior.

## Responsive and accessible behavior

- preserve the narrative and primary download on small screens;
- avoid horizontally scrolling marketing comparisons;
- keep body text and muted labels readable against dark surfaces;
- support keyboard navigation, visible focus, reduced motion, and meaningful alternative text;
- use animations as progressive enhancement, never as the only explanation of state.

## Success criteria

The redesign succeeds when a new visitor can understand within the first screen that:

1. Homun is a complete AI work environment;
2. it is independent from a single model provider;
3. it supports compatible cloud, open-source, and local models;
4. it can be downloaded and used without creating an account.

Within the rest of the homepage, the visitor should understand what Homun can produce, how local control works, and how Marketplace and Projects make the ecosystem extensible and participatory.

## Out of scope for the first release

- named competitor comparisons;
- paid Marketplace products;
- third-party Marketplace publishing;
- mandatory account creation;
- social profiles or a general-purpose community forum;
- claims not supported by the current application;
- a complete rewrite of product documentation before the unified shell is ready.

## Delivery sequence

1. Establish the shared visual system and final homepage composition.
2. Rewrite and implement the homepage around autonomy and real work.
3. Build Models, Projects, Marketplace, Download, and account entry pages.
4. Integrate the documentation shell and migrate canonical content.
5. Verify product claims against the current application.
6. Test responsive behavior, accessibility, routes, search, and production build.
7. Deploy to a preview environment before replacing the current live site.
