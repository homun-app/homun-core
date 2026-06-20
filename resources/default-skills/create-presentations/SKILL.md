---
name: create-presentations
description: Use when the user asks for a presentation, slides, a slide deck, a pitch deck, or "fammi delle slide / una presentazione / un deck" on any topic. Produces an ON-BRAND, VISUAL slide deck (with images) as a self-contained file + PDF artifact.
---

# Create Presentations

Produce a real, **visual, on-brand** slide deck — NOT a chat list of bullets and NOT a
plain text deck. The deliverable is a single self-contained `.html` file (opens
full-screen in any browser) plus a `.pdf`, both saved as artifacts, styled with the
user's **brand kit** and carrying **generated images**.

## When to use

"fammi una presentazione su X", "slide per il consiglio", "pitch deck", "presenta
questi dati". Slides / deck / presentation / pitch.

## Process

1. **Read the brand.** Call `get_brand_kit` FIRST. Use its `organization`,
   `primary_color` / `secondary_color` / `accent_color`, `heading_font` / `body_font`
   and `logo_data_url` throughout — the deck MUST look on-brand. (Empty values → fall
   back to a clean default palette, but still call it.)
2. **Scope + outline.** Confirm/infer audience, goal, length (default 8–12 slides),
   language, and read any source material (a file, data, or a URL via `browse_web`).
   Draft a slide-by-slide outline: one idea per slide, headline titles, few words.
3. **Generate the visuals.** For the cover and 2–4 key/section slides, call
   `generate_image` with on-brand prompts (subject + "clean, modern, [accent colour]
   accents, professional, no text"). Give each a `name` (e.g. `cover`, `s3`). The PNGs
   land in `$OUTPUT_DIR` — the SAME folder you build the deck in, so you can embed them.
   If image generation isn't available, proceed with a strong CSS-only visual design
   (brand gradients, accent bars, big type, colour blocks) — never fall back to plain text.
4. **Build the deck** with `run_in_sandbox` (one self-contained file in `$OUTPUT_DIR`):
   write a Python step that (a) base64-INLINES the logo + each generated PNG as data
   URLs (so the `.html` is fully portable), (b) emits the HTML using the template below
   with the brand colours/fonts applied, varied layouts (cover, image-led, big-KPI,
   two-column, quote, closing). Then export the PDF:
   `chromium --headless --no-sandbox --disable-gpu --print-to-pdf="$OUTPUT_DIR/<name>.pdf" "$OUTPUT_DIR/<name>.html"`.
5. **Deliver.** The `.html` (and `.pdf`) are artifacts — tell the user it's ready to
   preview, present full-screen and download; offer `save_artifact` to a folder.
   Summarise the structure in 1–2 lines. Never paste the HTML into chat.

## On-brand, image-led HTML template (fill; brand vars come from get_brand_kit)

```html
<!doctype html><html lang="LANG"><head><meta charset="utf-8"><title>TITLE</title>
<style>
  :root{--brand:PRIMARY;--brand2:SECONDARY;--accent:ACCENT;--ink:#1a202c;--muted:#4a5568;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'HEADING_FONT',-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink)}
  .slide{width:100%;min-height:100vh;padding:7vh 8vw;display:flex;flex-direction:column;
    justify-content:center;position:relative;page-break-after:always;overflow:hidden}
  .slide h1{font-size:3.2rem;line-height:1.05} .slide h2{font-size:2.2rem;color:var(--brand)}
  .body{font-family:'BODY_FONT',sans-serif}
  .slide li{font-size:1.5rem;color:var(--muted);margin:.5rem 0;list-style:none;padding-left:1.4rem;position:relative}
  .slide li::before{content:"▸";position:absolute;left:0;color:var(--accent)}
  .kpi{font-size:5rem;font-weight:800;color:var(--brand)}
  .accent-bar{position:absolute;left:0;bottom:0;height:10px;width:100%;background:var(--accent)}
  .logo{position:absolute;top:5vh;right:8vw;max-height:42px}
  .cover{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff}
  .cover h1{color:#fff} .cover .sub{font-size:1.4rem;opacity:.92;margin-top:1rem}
  .img-led{display:grid;grid-template-columns:1fr 1fr;gap:4vw;align-items:center}
  .img-led img{width:100%;border-radius:14px;object-fit:cover;max-height:62vh}
  @media print{.slide{min-height:auto;height:100vh}}
</style></head><body>
  <section class="slide cover"><img class="logo" src="LOGO_DATA_URL">
    <h1>DECK TITLE</h1><div class="sub">subtitle · ORG · date</div><div class="accent-bar"></div></section>
  <section class="slide img-led"><div><h2>Title</h2><ul class="body"><li>point</li></ul></div>
    <img src="GENERATED_IMG_DATA_URL"></section>
  <!-- …one section per slide; vary the layout… -->
</body></html>
```

## Quality bar

- ON-BRAND: brand colours + fonts + logo on the cover; not generic.
- VISUAL: every slide has a visual element (image, KPI, colour block, accent) — never a
  wall of bullets, never plain text.
- One idea per slide; headline titles; numbers over adjectives.
- Cover + closing "next steps / the ask" slides are mandatory.
- The single `.html` is fully self-contained (logo + images inlined) — it IS the deliverable.
