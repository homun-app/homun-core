---
name: create-presentations
description: Use when the user asks for a presentation, slides, a slide deck, a pitch deck, or "fammi delle slide / una presentazione / un deck" on any topic. Produces an ON-BRAND, VISUAL deck as an EDITABLE PowerPoint (.pptx) + an HTML/PDF preview.
---

# Create Presentations

Produce a real, **visual, on-brand** slide deck. You author only the CONTENT as a
structured `deck.json`; the bundled renderer turns it into BOTH:

- **`deck.pptx`** — a native, **editable** PowerPoint (real text boxes, logo, images) the
  user can open and tweak in PowerPoint / Google Slides;
- **`deck.html`** (+ **`deck.pdf`**) — an on-brand, image-led preview to view full-screen.

Do NOT hand-write HTML or PPTX. Write the JSON, run `deck-render`. This single
source-of-truth model is what makes the deck both beautiful AND editable.

## When to use

"fammi una presentazione su X", "slide per il consiglio", "pitch deck", "presenta
questi dati". Slides / deck / presentation / pitch.

## Process

0. **Make the plan FIRST (mandatory).** Before anything else, call `update_plan` with ALL
   the steps of this skill — set the first to `doing`, the rest `todo`:
   `get brand kit` · `generate images (≤4)` · `render deck (render_deck)` · `deliver`.
   Do NOT skip this. Then execute the steps ONE AT A TIME, calling `update_plan`
   to mark each `done` as you finish it, and do not stop until every step is `done`. (The
   runtime keeps you going only while the plan has open steps — no plan means you'll stop
   after the first action, which is wrong.)
1. **Read the brand.** Call `get_brand_kit` FIRST. The brand kit is NOT a file on disk —
   it comes ONLY from this tool. NEVER use `find`/`ls`/shell to search the filesystem for
   logo/brand/colour files. The brand is **applied AUTOMATICALLY**: calling `get_brand_kit`
   writes `brand.json` + `logo.png` into `$OUTPUT_DIR`, and `deck-render` reads them. So do
   NOT put `theme` or `logo` in deck.json, and NEVER embed the logo data URL anywhere (it's
   large and breaks the file write). Just remember the returned colours to steer your
   `generate_image` prompts on-brand.
2. **Scope.** Confirm/infer audience, goal, length (default 8–12 slides), language; read
   any source material (a file, data, or a URL via `browse_web`).
3. **Design pass (DO THIS — it's what makes the deck good, not generic).** Before any
   JSON, write a brief slide-by-slide plan: for EACH slide decide the **layout** (don't
   default everything to `bullets` — use `kpi` for a number, `image_left/right` for a key
   idea, `two_column` for contrasts, `quote` for a testimonial, `section` to divide), a
   tight **headline** (≤6 words), the **content** (≤4 bullets, numbers over adjectives),
   and a one-line **visual concept** for slides that carry an image. Aim for rhythm:
   cover → varied content (alternate text-heavy and image/KPI slides) → closing. This
   plan is the difference between a real deck and a wall of bullets.
4. **Generate the visuals — ONCE, then move on.** Generate **AT MOST 4 images total**
   (the cover + up to 3 key slides), in a SINGLE pass, with on-brand prompts (your visual
   concept + "clean, modern, [accent colour] accents, professional, minimal, no text").
   Give each a `name` (e.g. `cover`, `s3`); the PNGs land in `$OUTPUT_DIR`; reference them
   by filename in the slide's `"image"`. Once the images exist, do NOT generate more, do
   NOT re-run this skill, and do NOT redo the design pass — proceed straight to step 5.
   If image generation isn't available, omit images — the renderer still produces a strong
   on-brand design (rail, accent-underlined titles, big type). Never plain text.
5. **Render with the `render_deck` TOOL — do NOT use the shell.** Call `render_deck` with
   your `title`, optional `subtitle`, and the `slides` array (content only — NO theme/logo;
   reference your generated images by file name like `cover.png`). The tool writes the
   files, applies the brand, and runs the renderer for you, returning the produced
   artifacts. Do NOT write deck.json yourself, do NOT `run_in_sandbox`, do NOT `find`/`ls`
   for files — `render_deck` handles ALL of it. (The images you made with `generate_image`
   already exist in the output dir; never re-search for or regenerate them.)
6. **Deliver.** `deck.pptx` (editable), `deck.html` (preview) and `deck.pdf` are
   artifacts. Tell the user the .pptx is editable in PowerPoint/Google Slides and the
   .html/.pdf are for quick viewing; offer `save_artifact` to a folder. Summarise the
   structure in 1–2 lines. Never paste the JSON or HTML into chat.

## render_deck arguments (content only — pass as the tool call)

```json
{
  "title": "Deck title", "subtitle": "subtitle · ORG · date",
  // OMIT "theme" and "logo" — the renderer applies the brand kit automatically
  // (brand.json + logo.png are already in the output dir). Include ONLY content:
  "slides": [
    {"layout":"cover","title":"Deck title","subtitle":"subtitle · ORG · date"},
    {"layout":"bullets","title":"Highlights","bullets":["point","point"],"notes":"say this"},
    {"layout":"image_right","title":"Theme","bullets":["a","b"],"image":"s2.png"},
    {"layout":"kpi","title":"Metric that matters","kpi":"118%","kpi_label":"net revenue retention"},
    {"layout":"two_column","title":"X vs Y","columns":[{"title":"X","bullets":["a"]},{"title":"Y","bullets":["b"]}]},
    {"layout":"quote","quote":"...","author":"..."},
    {"layout":"section","title":"Section divider"},
    {"layout":"closing","title":"Next steps","bullets":["ask 1","ask 2"]}
  ]
}
```

Layouts: `cover`, `section`, `bullets` (optional `image`, `body`), `image_left`/`image_right`
(`bullets`+`image`), `kpi` (`kpi`+`kpi_label`), `two_column` (`columns[]`), `quote`
(`quote`+`author`), `closing`. Every slide may carry `notes` (speaker notes, PPTX only).

## Quality bar

- ON-BRAND: brand colours + fonts + logo (from the brand kit) — not generic.
- VISUAL: vary layouts; use `kpi` for numbers, `image_*` for key slides, `quote` for
  testimonials — never a wall of bullets, never plain text.
- One idea per slide; headline titles; numbers over adjectives.
- Cover + closing slides mandatory; speaker `notes` on the substantive slides.
- The **.pptx is the editable deliverable**; the .html/.pdf are the preview.
