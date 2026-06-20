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

1. **Read the brand.** Call `get_brand_kit` FIRST. Map it into the deck `theme`:
   `primary_color`→`primary`, `secondary_color`→`secondary`, `accent_color`→`accent`,
   `heading_font`/`body_font`, and `logo_data_url`→`theme.logo` (pass the data URL
   as-is — the renderer handles it). Empty values → the renderer falls back to a clean
   default palette, but still call it.
2. **Scope + outline.** Confirm/infer audience, goal, length (default 8–12 slides),
   language; read any source material (a file, data, or a URL via `browse_web`). Outline
   one idea per slide, headline titles, few words. Plan which slides carry an image.
3. **Generate the visuals.** For the cover and 2–4 key slides, call `generate_image`
   with on-brand prompts (subject + "clean, modern, [accent colour] accents,
   professional, no text"). Give each a `name` (e.g. `cover`, `s3`); the PNGs land in
   `$OUTPUT_DIR`. Reference them by filename in the slide's `"image"` (e.g. `"cover.png"`).
   If image generation isn't available, omit images — the renderer still produces a
   strong CSS/brand design (gradients, accent bars, big type). Never fall back to plain text.
4. **Write `deck.json`** in `$OUTPUT_DIR` (schema below). One idea per slide; vary the
   layout (`cover`, `image_left`/`image_right`, `kpi`, `two_column`, `quote`, `section`,
   `bullets`, `closing`). Add `notes` (speaker notes) where useful. A cover and a
   closing "next steps / the ask" slide are mandatory.
5. **Render** with `run_in_sandbox`:
   ```sh
   cd "$OUTPUT_DIR" && deck-render deck.json --prefix deck
   chromium --headless --no-sandbox --disable-gpu --print-to-pdf="$OUTPUT_DIR/deck.pdf" "$OUTPUT_DIR/deck.html"
   ```
   `deck-render` writes `deck.html` + `deck.pptx`; chromium turns the HTML into `deck.pdf`.
6. **Deliver.** `deck.pptx` (editable), `deck.html` (preview) and `deck.pdf` are
   artifacts. Tell the user the .pptx is editable in PowerPoint/Google Slides and the
   .html/.pdf are for quick viewing; offer `save_artifact` to a folder. Summarise the
   structure in 1–2 lines. Never paste the JSON or HTML into chat.

## deck.json schema

```json
{
  "title": "Deck title", "subtitle": "subtitle · ORG · date",
  "theme": {"primary":"#2b6cb0","secondary":"#1a202c","accent":"#ed8936",
            "heading_font":"Inter","body_font":"Inter","logo":"<logo_data_url or logo.png>"},
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
