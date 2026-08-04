# Real PPTX Template Import and Provider-Agnostic Catalog

## Goal

Make Presentations useful by moving from synthetic template cards to real
PowerPoint template assets. A selected template must behave like Z.ai-style
template selection: Homun starts from a real `.pptx`/`.potx`, applies the user's
brand kit and brief, then produces an editable `.pptx` plus previews.

This is still part of the canonical template registry. Templates are catalog
entries consumed by `make_deck` and `make_document`; they are not new tools, a
parallel renderer, or a separate store.

## Product Model

Presentations has three layers:

1. Brand kit: organization name, logo, colors, fonts and product/context notes.
2. Local template packs: imported `.pptx`/`.potx` assets stored under Homun's
   template directory with thumbnails, manifest and attribution metadata.
3. Template source directory: a provider-agnostic list of places where the user
   can find, buy, download or create `.pptx`/`.potx` templates. A template only
   becomes actionable in Homun after explicit local import.

The implementation ships local import first. External providers are source
links, not a mirrored catalog, until there is an explicit provider integration
with licensing and download rules for that provider.

## Licensing Boundary

SlidesCarnival, Microsoft Create, Slidesgo, Envato Elements and similar services
can be used as template sources, but Homun must not become an unauthorized
mirror of raw template files from any provider.

Rules:

- Homun may link to provider template pages and show source metadata.
- Homun may let the user import a downloaded/acquired template for their local
  use.
- Homun must preserve attribution metadata and include attribution in generated
  decks when a source requires it.
- Homun must not silently bundle, mirror or redistribute unmodified third-party
  templates as standalone assets.
- If a source page requires attribution, the generated deck keeps a credits slide
  or an equivalent subtle attribution link/citation.
- If the template is redistributed as part of a generated client deliverable, the
  deck must contain original user content built on top of the template.

Every imported template pack stores:

- `source_provider`: `user_upload`, `homun`, or another explicit provider.
- `source_url`: original template page URL when known.
- `license`: human-readable license label.
- `attribution_required`: boolean.
- `attribution_text`: text inserted or preserved in output decks.
- `redistribution_policy`: `local_use_only`, `generated_decks_only`, or
  `owned_by_user`.

## Template Pack Format

Each imported template becomes a local pack:

```text
~/.homun/templates/<template_id>/
  manifest.json
  source.pptx
  thumbnails/
    slide-001.png
    slide-002.png
  analysis.json
```

`manifest.json` contains:

- identity: `id`, `name`, `kind`, `version`, `created_at`.
- source: provider, URL, license and attribution fields.
- visual metadata: dominant colors, aspect ratio, categories, tags, style.
- supported use cases: pitch, report, proposal, roadmap, agenda, training.
- layout inventory: slide indexes and semantic roles.
- placeholder contract: title, subtitle, bullets, image slots, KPI slots, table
  slots, quote slots, CTA slots.
- compatibility flags: whether brand colors can be applied safely, whether logo
  slots exist, whether the template has a credits slide.

`analysis.json` is derived and can be regenerated. It should never be the only
source of truth for the template pack.

## Import Pipeline

For manual import:

1. User selects `.pptx` or `.potx`.
2. Homun copies it into a local template pack.
3. Homun renders thumbnails for representative slides.
4. Homun inspects slide sizes, masters, layouts, text boxes, image placeholders
   and common slide roles.
5. Homun creates an editable manifest draft.
6. The template appears in Presentations and in `/api/templates/catalog`.

For provider-sourced import:

1. User opens a provider/source page from the source directory or supplies their
   own source.
2. User downloads, buys or creates a `.pptx`/`.potx` outside Homun when needed.
3. User imports the local file into Homun.
4. Homun records provider, URL, license and attribution metadata when available.
4. Homun runs the same local import pipeline.
5. The generated deck preserves attribution.

Automated download/scraping is not part of the current contract. If it is added
later for a specific provider, it must be explicit, source-compliant and fall
back to "Open source page" + "Import downloaded PPTX".

## Generation Pipeline

`make_deck(template_ref=...)` must resolve template references in this order:

1. Local imported template pack.
2. Built-in Homun-owned template pack.
3. Existing declarative `monet/*` catalog entry fallback.

When a real PPTX pack is selected:

1. The model generates content structure only: narrative, sections, slide intent,
   text, data and image requests.
2. The first renderer slice opens the real `.pptx`/`.potx`, keeps its slide
   size, master and media, trims it to the requested slide count, and edits text
   conservatively.
3. Later renderer slices should choose matching real slides/layouts and replace
   explicit placeholders/slots with higher confidence.
4. Brand kit application is conservative:
   - use the user's logo where there is a logo slot;
   - map primary/accent colors to theme-safe elements when confidence is high;
   - avoid destroying a strong template style;
   - keep credits/attribution.
5. Existing QA runs on the HTML/PDF/PPTX preview outputs.
6. Artifact provenance records template id, source provider, source URL, license,
   attribution and QA status.

Current implementation note: `deck.pptx` can already be produced from a real
imported PPTX source. The HTML/PDF previews still come from Homun's synthetic
HTML renderer, so visual parity between preview and PowerPoint is not yet a
contract.

The renderer should prefer preserving visual quality over over-branding. If a
template's palette conflicts with the brand kit, Homun should report the tradeoff
and offer a conservative or aggressive brand application mode.

## Presentations UX

The Presentations page should become a compact working surface:

- Brand kit summary at the top, with edit affordance rather than a long form by
  default.
- Search and filters for template discovery.
- Real thumbnails, not synthetic cards.
- Source badges: `Local`, `Homun`, and the recorded provider for imported packs.
- Template source directory with provider links and clear copy: "find/download or
  buy a PPTX, then import it".
- License/attribution badge visible before import/use.
- Primary actions:
  - `Use template`
  - `Import PPTX`
  - `Open source`
  - `Edit manifest`
- After template selection, the composer can create a deck using the selected
  `template_ref` and the current brand kit.

The UI must not imply a template is available locally until it has been imported
and analyzed successfully.

## Error Handling

- Unsupported PPTX: keep the uploaded source, show why analysis failed, and do
  not add it to the active catalog.
- Missing thumbnails: template can remain imported but gets a warning and a
  retry action.
- Unknown placeholders: allow manual manifest correction before use.
- Attribution missing for known external source: block generation until the user
  confirms or fixes attribution metadata.
- QA failure after generation: keep artifacts with warning metadata, but do not
  claim the deck is polished.

## Testing And Gates

Minimum gates for the first implementation slice:

- Import a local `.pptx` into a template pack.
- Generated manifest includes source/license fields.
- Thumbnails are produced or a clear warning is shown.
- `/api/templates/catalog` exposes imported template packs without duplicating
  seed entries.
- `make_deck(template_ref=<imported>)` resolves to the real PPTX pack.
- Generated artifacts record template provenance and attribution metadata.
- Existing deck QA still runs.
- UI contract prevents showing fake availability or missing attribution.

Runtime smoke:

1. Import one third-party or user-owned PPTX manually.
2. Confirm it appears with real thumbnail.
3. Generate a branded Homun pitch deck from that template.
4. Open the `.pptx` and verify it preserves visual design, logo/brand data,
   source attribution and editable slides.

## Initial Slice

Do not start with provider search/scraping or automated downloads. Start with:

1. Manual PPTX import into local template pack.
2. Manifest + thumbnail generation.
3. Catalog API exposure.
4. `make_deck` real-template resolution path.
5. One runtime smoke with a provider-sourced PPTX imported by the user.

After that is reliable, grow Homun-owned templates and optionally add explicit
provider integrations one by one. No provider becomes the default catalog unless
it satisfies licensing, attribution and UX requirements.
