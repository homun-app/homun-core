# Presentations Studio Redesign

## Goal

Turn the Presentations addon from a settings-like form page into a compact
template workspace. The page must feel consistent with Homun's new island UI and
support the real-PPTX template workflow: import a template, inspect it in the
catalog, then use it to start a guided chat.

## Product Direction

Use the "studio workspace" direction:

- brand configuration is a compact rail, not the main page;
- template discovery and selection are the primary content;
- real local PPTX templates are first-class catalog items;
- the page is operational and dense, closer to Linear/Claude cleanliness than a
  marketing gallery;
- Z.ai-style template detail is used only for the template modal and previews.

## Layout

The page is a two-column workspace inside the existing plugin page:

1. `Brand kit` rail on the left.
   - Organization name.
   - Logo upload/remove.
   - Three color controls.
   - Heading/body fonts.
   - Small preview and save action.
   - The rail remains visually quiet and should not dominate the screen.

2. `Template workspace` on the right.
   - Header with title, short status, search, and `Import PPTX`.
   - Filter chips for `All`, `Local`, `SlidesCarnival`, `Homun`,
     `Presentations`, and `Documents`.
   - Responsive template grid with larger visual cards.
   - Empty and import-error states that are clear but not loud.

On narrow widths the two columns stack, with the catalog first and the brand kit
below or collapsed into a compact block if needed.

## Template Cards

Cards should show what the user needs to choose a template:

- visual preview at the top;
- template name and short description;
- file-type badge (`PPTX` / `DOCX`);
- source badges (`Local`, `SlidesCarnival`, `Homun`, attribution);
- a small set of human-readable fit notes;
- one primary action: `Use template`.

Avoid exposing internal registry tokens as the dominant content. Technical tokens
can remain small metadata when useful, but they should not be the card's visual
identity.

## Template Detail Modal

The detail modal follows a Z.ai-style pattern:

- large preview;
- title, description, source/license metadata;
- thumbnail strip for layouts/slides when available;
- one clear `Use template` call to action.

`Use template` opens a new guided chat with the selected template. If the
template has a local PPTX source, the source is attached through the authorized
template-source path. The modal does not encourage manual `template_ref` copying
as the primary workflow.

## Brand Kit Behavior

Brand kit remains persistent and shared by deck/document generation. The
redesign does not change storage or runtime semantics. It only changes visual
hierarchy:

- save remains explicit;
- logo rasterization behavior remains unchanged;
- color/font fields remain editable;
- preview becomes smaller and more representative.

## Constraints

- Do not introduce a second template registry or store.
- Do not make templates callable tools.
- Do not change `make_deck` routing in this slice.
- Keep the existing API/bridge contracts.
- Preserve current import and `Use template` behavior.
- Keep the design consistent with the sidebar island, settings island, and
  workspace island: subtle borders, compact typography, restrained shadows.

## Verification

Minimum gates:

- `npm run test:ui-contract`
- `npm run build`
- `git diff --check`

Manual/runtime checks:

- Open Presentations.
- Confirm the brand rail is compact and usable.
- Confirm imported PPTX templates are visible as catalog cards.
- Confirm search and filters do not hide all templates unexpectedly.
- Confirm `Use template` still opens a guided chat.
- Confirm the page remains usable in light and dark themes.

## Non-Goals

- Full SlidesCarnival search/download automation.
- PPTX thumbnail generation for every imported template in this slice.
- New document-generation behavior.
- New artifact storage or memory behavior.
