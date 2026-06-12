# Decision 0011: Agnostic core + addon ecosystem with bounded, prompt-only customization

Date: 2026-06-05

## Status

Accepted (direction). Sets the product/business shape on top of the existing
local-first assistant. Implemented in phases; the addon-host primitives reuse
existing pieces (skills, operational-plan, capability registry, approval gates,
artifacts, memory entities, channels).

## Context

We want a product that is useful today AND monetizable tomorrow, differentiated
from the two obvious neighbours:

- **Manus / horizontal agents** = a blank task canvas: you must know what to ask;
  generic, cloud, not embedded in the business's own tools/channels.
- **n8n / Zapier / Make** = "no-code" but really "build the automation yourself":
  drag nodes, map fields, configure auth — a builder's mindset a non-technical
  SMB owner won't adopt. "Without IT" for our users means **without flow-building
  or configuration work**, not "without any setup".

Target wedge: small businesses without IT, who should adapt the system to their
work by talking to it, not by engineering it.

## Decision

**1. Agnostic core, vertical value in addons.** The core stays domain-neutral and
exposes PRIMITIVES (channels, browser automation, memory, durable task runtime,
approval gates, scheduler, the procedure/skill executor). All verticality lives
in **addons** outside the core. This is the prerequisite for an ecosystem (the
same discipline as "no per-domain logic in the engine").

**2. Land-and-expand business model.** Today: a free/low-friction **personal
assistant** (drives adoption). Tomorrow: **addons** (built by us or partners) that
turn it into a work tool for a vertical. Adoption bottoms-up → upsell via addons.

**3. Addons are "process skills".** An addon is more than a prompt pack: it
declares a **trigger** (channel inbound / schedule / observed event), **steps**
(deterministic where possible, agent/browser where the data/UI varies), **data &
config** (e.g. price list, document template), **approval points**, and a
**channel binding**. Three origins, one shared shape: installed (marketplace),
authored by the user (simply), or **generated** by the system from
conversation/observation (the apprentice loop) — the generated artifact is a
reviewable process skill, not a vague "automation".

**4. Generation emits CONFIG, not per-customer code.** The capable coding model is
used (a) at build-time to extend the PLATFORM's curated component library (code we
review), and (b) at runtime to assemble **validated configuration** over a fixed
runtime for a customer. Spectrum, in order of preference: declarative config >
sandboxed scripts (existing `run_in_sandbox`) > NEVER arbitrary per-customer apps
(unmaintainable for an SMB-without-IT). Regulated/solved domains (invoicing:
SdI/e-fattura, VAT, legal numbering) ship as **vetted components configured** by
the user — not generated from scratch. Generation shines for the bespoke parts.

**5. Bounded, prompt-only customization (the "customization contract").** Each
addon declares two zones:
- **Locked core (invariants):** data contract, calculations, fiscal/legal fields,
  the steps that make it work. Untouchable.
- **Open surface (adaptation):** labels, optional custom fields, display
  order/visibility, document wording/branding, defaults, optional steps.

Customization is a **data overlay** on the vetted addon, authored **via prompt**
(the LLM maps the user's request into changes within the open surface),
**validated** against the contract (anything touching an invariant is rejected
with an explanation), **previewed + reversible (versioned overlay)**, and
**upgrade-safe**: the overlay re-applies/migrates when the addon is updated
centrally — so a single component fix benefits every customer, and there are no
forked snowflakes.

## Consequences

- The core's "definition of done" for shipping addons is the **addon-host**: the
  process-skill abstraction + the customization-contract mechanism, on top of the
  consolidated runtime primitives (see roadmap gap-audit steps 2-5). NOT
  auto-learning and NOT cloud — those come when needed.
- Build the abstraction by **extracting it from one real vetted addon (invoicing)**
  end-to-end, then generalize. Do not build a generic customization engine in a
  vacuum.
- A **partner SDK + marketplace + revenue model** is a later phase; it must not
  pull focus from finishing the addon-host.

## Non-goals

- NOT a multi-tenant SaaS that sees everyone's data: stays **single-tenant /
  self-hostable** ("your instance, your data"), consistent with local-first.
- NOT generating arbitrary per-customer applications/code.
- NOT a flow-builder (n8n-style); customization is conversational, within the
  contract.

## Addendum 2026-06-13: addon = panel + engine; proactivity is the FIRST addon; A→B path

Design session refinements (decisioni utente):

**6. An addon is SELF-CONTAINED: its own panel (UI) + its own engine (logic).**
Detach the addon → its nav entry, panel AND engine all disappear together. This is
the "extension" model (VS Code / Obsidian): a plugin contributes both views and
behaviour; uninstalling removes everything. The core becomes a **host** with:
- **UI extension point**: a nav slot + a panel region the plugin fills (panel
  CONTENT belongs to the plugin).
- **Capability API (engine extension point)**: the host-provided calls a plugin may
  use — read context/connectors, **emit a suggestion card**, **propose an action**
  (→ approval gate), schedule, read/write its own config+state — all inside the
  security perimeter. No raw system access.
- **Lifecycle**: install / enable / disable / detach → de-registers nav + panel +
  engine atomically.

**7. The shared user-facing surface is the SUGGESTION CARD (a dashboard), not chat.**
A chat thread is the wrong container for proactivity: unanswered prompts pile up and
read as debt (observed live — the Homun thread accumulated 20+ unanswered check-ins).
Instead, addons (and the proactive supervisor) emit **cards into a dashboard**:
- **Zen-but-expandable**: per project show the latest/most-relevant card + a count
  ("+N altre"), expandable with filters (urgency, scope).
- **No-repeat**: dedup against prior cards INCLUDING dismissed ones (generalize the
  existing `curiosities` queue: pending|delivered|dismissed).
- **Feedback → memory**: accept/dismiss is low-friction training signal; liked/
  disliked is stored and CONDITIONS future suggestions (this is the precision/trust
  mechanism — a clic, not a rule).
- **Engage → chat in the correct workspace**: the card is the entry point; acting on
  it lazily creates/opens a chat in that scope's workspace, seeded with the card
  context. This DISSOLVES the proactive-task workspace-scoping problem: the engine
  runs centrally, emits scope-tagged cards; the heavy chat materializes on demand in
  the right place.

**8. The proactivity supervisor is ADAPTIVE (LLM-driven), NOT a rule catalog.**
No hardcoded observers (staleness/deadline/pattern were examples, not rules). The
engine assembles context for a scope (project graph + memory/decisions + connected
sources read via Composio/MCP — e.g. Trello/Mattermost) and an LLM **review turn**
decides what's worth surfacing ("there are these things to do; I looked at the
project, maybe the issue is this"). Guardrails (the user endorses guardrails, not
rules): read-only/autonomous to observe+propose, **gated to act**; every card
**grounded** in real context (no speculation); **no-repeat** durable. Triggered (idle
/ new connector activity — Auto-G2 ConnectorPoll), not constant polling.

**9. The PROACTIVE DASHBOARD is the FIRST addon** (not invoicing). It is OUR addon, so
it both ships value AND proves/shapes the addon contract (panel + engine + capability
API + lifecycle). **Invoicing becomes the SECOND addon**, reusing the same contract —
confirming it generalizes (consistent with "extract the contract from a real addon").

**10. Path A (now) → B (later).** The decision that sizes the work is internal vs
external plugins:
- **A — internal modules, now**: plugins are modules inside the app, each panel+engine,
  behind a **registry** + enable/disable (detachable = gated). No sandbox, no dynamic
  loading. Build proactivity as the first addon on this; design the manifest +
  capability-API + UI-slot **in the shape of B** so conversion is mechanical, not a
  rewrite. Ship the product on A.
- **B — external/third-party, later** (the business model: free + PAID plugins):
  dynamically-loaded, sandboxed (iframe panel + typed postMessage bridge), versioned
  API, marketplace + licensing + payment.

**B concrete analysis (grounded 2026-06-13 — "mesi" was imprecise).** Substrate already
present: declarative engine (`process-skill`: Trigger/Step/Config → NO arbitrary code),
zip install + ClawHub catalog (packaging/distribution), `CapabilityFacade` (the broker),
sandboxed renderer + `<iframe>` precedent (UI sandbox). Decomposition (dev effort,
assuming declarative engine): package format ~1–2d; declarative-engine loader ~2–3d;
**iframe panel + typed bridge to capabilities (the real security boundary) ~1wk**;
host↔plugin API versioning ~2–3d + ongoing; per-plugin permission/consent + signing
~3–5d; marketplace (reuse skill catalog) ~3–5d; **licensing + payment ~1–2wk, partly
external (Stripe/license server)**. Bottom line: the **technical core of B** (external,
free, signed-by-us, declarative engine, sandboxed panel) is realistically **~1.5–2
weeks** — not months, because the substrate exists and the engine is declarative. **Paid
third-party** is **+2–4 weeks**, mostly PRODUCT/EXTERNAL (marketplace, licensing,
payment, review/trust), not core engineering. Three levers that keep it small:
(1) **declarative engine** (no code sandbox — already ADR 0011's choice); (2) start with
**signed-by-us plugins only** (even paid) → defer the untrusted-code sandbox; (3) payment
via **external integration**, not built in-house.

Implication: do A now (contract shaped for B), launch; open B when selling plugins — and
the gating work there is marketplace+payment+trust (product), not the loader.
