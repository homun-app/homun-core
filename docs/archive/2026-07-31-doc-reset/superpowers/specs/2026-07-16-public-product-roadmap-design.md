# Homun Public Product Roadmap Design

**Date:** 2026-07-16
**Status:** Approved design, pending user review of this written specification
**Primary audience:** small businesses and small teams
**Secondary audience:** investors, commercial partners, and future ecosystem partners

## Purpose

Replace the current feature-led public roadmap with a product-led narrative that is
credible against Homun's implemented architecture and understandable without technical
knowledge.

The roadmap must explain how Homun evolves from an operational personal workspace into:

1. a process coordination product for small teams;
2. a platform for official vertical workflow packs;
3. a foundation for company-specific knowledge and specialized small models.

The page must communicate immediate customer value first. Platform leverage, vertical
distribution, and specialized-model potential form a second reading for investors and
partners.

## Verified Product Baseline

The roadmap is grounded in the current product rather than inferred from aspirational
component names.

- Chat, Telegram, and WhatsApp turns converge through the durable turn broker and the
  single guarded agent loop.
- The live agent engine owns reasoning, tool use, plan state, verification, and final
  delivery.
- The durable task runtime already supports dependencies, checkpoints, retries, leases,
  resources, schedules, approvals, and workflow identifiers.
- Browser delegation is a live recursive sub-turn of the same engine.
- Typed Planner, Memory, Tool, Vision, Risk, Automation, and Review subagents exist in the
  durable orchestrator path, but do not yet form a complete team workflow product.
- MCP, Composio, native tools, skills, and native workflows partially converge through
  capability discovery and common policy. Execution is not yet fully provider-agnostic.
- `ProcessSkill` defines triggers, deterministic or agentic steps, approval points, and
  safe customization overlays, but does not yet have end-to-end process execution wiring.
- The current desktop plugin UI contains Proactivity and Presentations. Public plugin
  distribution and a complete marketplace are not yet shipped.
- User and workspace scoping exist, but teams, members, assignees, organizations, and
  cross-Homun ownership do not yet exist as a complete domain model.

This baseline means that Homun Flow is an integration and productization program over
real foundations, not a claim that the team-process product already exists.

## Product Narrative

The roadmap tells one continuous story:

```text
Homun Operational Workspace
        ->
Homun Flow
        ->
Homun Team
        ->
Official Workflow Packs
        ->
Adaptive Company Intelligence
```

The same progression is expressed to customers as:

```text
Remember the work -> Coordinate the process -> Connect the team -> Adapt to the company
```

### Customer interpretation

Homun starts with capabilities already available and turns them into ready-to-use,
controlled business processes that do not require specialist AI or automation staff.

### Investor interpretation

Homun is building a reusable operational process foundation. Official vertical workflow
packs provide commercial distribution and repeatable sector positioning. Process outcomes,
reviews, corrections, and evaluation data can later support company-specific knowledge and
specialized SLMs.

## Page Message

### Hero

**Eyebrow**

> BUILT FOR SMALL TEAMS

**Headline**

> AI that keeps work moving.

**Primary description**

> Homun turns requests, messages and recurring work into visible processes that people and
> AI can complete, review and hand over together.

**Strategic supporting line**

> One operational foundation. Multiple business workflows. Your models, your tools and your
> data remain under your control.

### Overall takeaway

The complete page should leave the reader with this conclusion:

> Homun already performs real work. We are now turning those capabilities into coordinated
> processes for small teams. Those processes become official workflow products and, over
> time, the foundation for AI that adapts to each company.

## Public Status Model

The public roadmap uses four commitment bands.

### Available

The capability is usable in a current public release. The card describes only currently
available behavior. Enhancements belong in the changelog unless they change the product
program materially.

### Building now

The initiative is the current primary product program. It has an explicit first-release
scope and evidence-based milestones.

### Up next

The initiative is a decided extension of the product direction. Its order may change, but
its inclusion is not a community vote or speculative idea.

### Exploring

The initiative is being evaluated and is not a delivery commitment. The page must state
this explicitly.

### Progress rules

- Do not publish arbitrary percentages.
- Show progress only through named, demonstrable milestones.
- A milestone is complete only when its user-visible acceptance criteria are verified.
- Dates are shown only when there is a real delivery commitment.
- Every update has a stable publication date and describes evidence, not activity.

## Strategic Roadmap Inventory

### 1. Homun Operational Workspace

**Status:** Available
**Area:** Product foundation

> A model-independent workspace where Homun remembers projects, creates real deliverables,
> uses connected tools and asks before taking sensitive actions.

Current capability summary:

- project memory and continuity;
- controlled browser and local computer;
- documents and presentations;
- local and cloud model routing;
- WhatsApp and Telegram;
- connected services;
- automations and approvals.

This is one foundation card. Detailed shipped capabilities remain discoverable through the
product pages and changelog.

### 2. Homun Flow

**Status:** Building now
**Area:** Team processes
**Featured:** yes

> Turn recurring work into a visible process that people and Homun can complete, review and
> hand over together.

First-release scope:

- processes with explicit activities and dependencies;
- a lightweight native board derived from process state;
- assignment to a person, role, or Homun;
- producer-to-reviewer handoffs;
- explicit completion criteria;
- artifacts and evidence linked to activities;
- approval checkpoints;
- process history and audit;
- execution through the appropriate available tools;
- synchronization with selected external boards.

Public milestones:

1. **Process foundation:** process definition, run identity, state, and transitions.
2. **Visible board:** the native board reflects canonical process state.
3. **Review handoffs:** producer, reviewer, correction, and acceptance lifecycle.
4. **Connected execution:** native, MCP, Composio, and skill-backed actions participate
   through governed capability routing.
5. **Pilot workflow:** one complete official workflow runs end to end.
6. **Team beta:** the process works with multiple responsible people under explicit access
   and audit rules.

Strategic role:

> Homun Flow is the reusable foundation for every official business workflow developed next.

### 3. Team Spaces & Roles

**Status:** Up next
**Area:** Collaboration

> Give every person and Homun the right context, responsibilities and permissions.

First-release scope:

- members and roles;
- shared projects;
- task ownership;
- review requests;
- contextual comments;
- notifications;
- permission boundaries;
- activity and audit history;
- separation of personal and company memory.

This is contextual work communication, not a general-purpose replacement for Slack or
Microsoft Teams.

### 4. Homun Mobile

**Status:** Up next
**Area:** Apps

> Keep projects moving, review work and approve sensitive actions wherever you are.

First-release scope:

- conversations and projects;
- process status and notifications;
- review and approval;
- secure pairing with the user's Homun environment;
- photo and document capture;
- later extension to voice capture.

### 5. More Ways to Reach Homun

**Status:** Up next
**Area:** Channels

> Bring Homun into the communication channels your company already uses.

Channel sequence:

- available: WhatsApp and Telegram;
- next: email and Slack;
- later: Microsoft Teams and a web inbox or widget;
- vertical channels are added only when required by an official workflow pack.

The product and permission model must distinguish internal team channels from external
customer, lead, and supplier channels.

### 6. Adaptive Company Intelligence

**Status:** Exploring
**Area:** Company AI

> Homun learns your company's terminology, knowledge, successful examples and review
> criteria, progressively adapting to how the business works.

Research progression:

1. Company Profile;
2. Company Knowledge;
3. Process Learning;
4. Evaluation;
5. Specialized SLM.

Specialized model training is exposed only when a company has enough high-quality examples,
stable processes, and measurable evaluation criteria. RAG, memory, and fine-tuning are
complementary layers rather than interchangeable marketing terms.

### 7. Voice & Meeting Capture

**Status:** Exploring
**Area:** Input

> Bring voice conversations and meeting context into a process only when explicitly enabled.

Potential scope:

- voice conversations;
- meeting notes;
- extraction of decisions and activities;
- linking outcomes to the relevant process;
- explicit recording and privacy controls.

### 8. Developer Platform

**Status:** Exploring
**Area:** Ecosystem

> A future platform for selected partners and developers to build workflows and capabilities
> on Homun.

The developer platform follows the validation and maturation of Homun's official workflow
packs. It is not part of the first commercial plugin phase.

## Official Workflow Ideas

Vertical workflow packs appear in a separate, vote-enabled section named:

> Business workflows we are evaluating

Introductory copy:

> Homun's first workflow packs will be developed and maintained by us. Each pack combines
> process design, connected tools, permissions, templates, review rules and measurable
> outcomes.

Each idea uses one of three evaluation states:

- `Evaluating`;
- `Selected for pilot`;
- `Removed`.

Ideas are not commitments. A removed idea remains in the public history with a concise
rationale.

### Client Work

> From a client request to a researched, reviewed and approved deliverable.

```text
Request -> Brief -> Research -> Draft -> Review -> Approval -> Delivery -> Follow-up
```

Primary target: agencies, consultants, professional practices, and small service companies.
This is the recommended first pilot for Homun Flow because it uses existing project memory,
research, documents, presentations, connected services, and approvals.

### Sales Operations

> Research leads, prepare outreach, update the CRM and maintain consistent follow-up.

```text
Lead -> Research -> Qualification -> Draft -> Approval -> CRM -> Follow-up
```

### Content & Marketing

> Plan, produce, review and publish content while preserving brand rules and approvals.

```text
Idea -> Research -> Draft -> Brand review -> Approval -> Publish -> Measure
```

### Internal Operations

> Turn company procedures and recurring controls into visible, repeatable work.

```text
Trigger -> Checklist -> Data collection -> Verification -> Exception -> Report
```

### Customer Support

> Coordinate incoming requests, proposed answers, escalation and human handoff across
> channels.

```text
Request -> Classify -> Retrieve context -> Draft -> Review -> Reply -> Follow-up
```

Each idea detail page includes:

- problem solved;
- target team;
- example process;
- likely connected systems;
- expected output;
- GitHub participation;
- latest evaluation status.

## Existing Roadmap Migration

Existing issues and discussions are preserved. Superseded items are closed or archived with
a comment that links to the replacement program.

| Current item | Migration |
|---|---|
| The Apprentice | Merge its process-learning direction into Homun Flow and Adaptive Company Intelligence. |
| Plugin & addon marketplace | Replace with Official Workflow Packs and the later Developer Platform. |
| Autonomous multi-step tasks | Merge into Homun Flow as a technical foundation, not a separate public product. |
| Mobile companion | Rename and rewrite as Homun Mobile. |
| Non-destructive chat branching | Remove from the strategic roadmap; track as a product feature and in the changelog. |
| Shared, permissioned spaces | Rename and promote to Team Spaces & Roles. |
| Voice & ambient capture | Rewrite as Voice & Meeting Capture. |
| Connected actions | Consolidate under Homun Operational Workspace. |
| Bring-your-own-model routing | Consolidate under Homun Operational Workspace. |
| Contained local computer | Consolidate under Homun Operational Workspace. |

## Page Information Architecture

The public page uses this order:

1. hero and product promise;
2. `Remember -> Coordinate -> Connect -> Adapt` journey;
3. Available today;
4. featured Homun Flow program;
5. Up next programs;
6. Official Workflow Ideas;
7. Adaptive Company Intelligence;
8. other Exploring programs;
9. release history;
10. GitHub participation.

The release history remains separate from the strategic roadmap. It proves delivery without
turning every shipped feature into a permanent strategic card.

## Card Contract

Every strategic roadmap item supports these fields:

- `outcome`: the customer-visible change;
- `whyNow`: why Homun is building it;
- `firstRelease`: bounded initial scope;
- `milestones`: evidence-based progress;
- `notIncludedYet`: explicit expectation boundary;
- `latestUpdate`: stable, dated public evidence;
- `githubUrl`: public context and participation;
- `strategicRole`: optional secondary reading for investors and partners.

The compact journey card shows only status, area, title, outcome, latest update, and milestone
summary. Detailed fields belong on the item's detail page.

## Editorial Rules

- Lead with work, outcomes, review, responsibility, and continuity.
- Do not expose internal names such as `TaskRecord`, `ExecutionPlan`, provider adapters, or
  queue implementation details.
- Do not use `autonomous` without explaining controls, approvals, and limits.
- Distinguish channels, connectors, capabilities, plugins, and workflows.
- Do not call a connector integration a workflow pack.
- Do not publish unsupported percentages or invented dates.
- State what the first usable release includes and excludes.
- Separate `Available`, committed direction, and research clearly.
- Present specialized-model training as a measured progression based on real process data.
- Keep the public promise local-first and model-independent.
- Use the changelog for shipped feature increments and the roadmap for product programs.

## GitHub and Synchronization Rules

GitHub Project remains the editorial source of truth for public roadmap data. The website
continues to consume its synchronized snapshot.

- Roadmap status and publication status remain separate fields.
- Only `Published` items appear publicly.
- Strategic items and workflow ideas use distinct item types or an equivalent explicit field.
- Voting is open for workflow ideas and selected Exploring items, not for committed programs.
- Vote counts remain advisory and never change status automatically.
- Milestone progress is derived from named milestone state, not manually entered percentages.
- Empty or invalid synchronization never replaces the last valid website snapshot.
- Existing issue history is preserved through redirects, links, or supersession comments.

## Non-Goals

This roadmap redesign does not:

- implement Homun Flow;
- introduce a second agent engine;
- define the final FlowEngine architecture;
- implement team identity or cloud synchronization;
- open the plugin platform to third-party developers;
- promise automatic SLM training in a delivery release;
- turn the public roadmap into an engineering backlog;
- redesign unrelated website pages.

## Acceptance Criteria

The redesign is successful when:

1. a small-business reader can explain what Homun does today and what Homun Flow adds;
2. the page clearly identifies Homun Flow as the primary Building program;
3. mobile, team spaces, and new channels appear as decided extensions;
4. official vertical workflows are visible as ideas without becoming delivery commitments;
5. Adaptive Company Intelligence communicates a credible path from company profile and RAG
   to evaluation and specialized SLMs;
6. no card uses an unsupported percentage or date;
7. shipped capabilities remain provable through the changelog;
8. the GitHub Project and website snapshot remain synchronized;
9. old roadmap discussions remain traceable;
10. the page offers a customer-first reading and a coherent investor-level platform thesis.
