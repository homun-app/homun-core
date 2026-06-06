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
