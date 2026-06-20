---
name: create-presentations
description: Use when the user asks for a presentation, slides, a slide deck, a pitch deck, or "fammi delle slide / una presentazione / un deck" on any topic. Produces a self-contained slide deck file (and PDF) as an artifact.
---

# Create Presentations

Produce a real, downloadable **slide deck** — not a chat list of bullet points. The
deliverable is a single self-contained `.html` file (opens in any browser, presents
full-screen) plus a `.pdf` export, both saved as artifacts.

## When to use

The user wants slides / a presentation / a deck / a pitch: "fammi una presentazione su
X", "slide per il consiglio", "pitch deck per gli investitori", "presenta questi dati".

## Process

1. **Scope the deck.** Confirm (or infer from the request): audience, goal, length
   (default 8–12 slides), language, and any source material (a document, data, a URL —
   read it first; use `browse_web` if research is needed). Don't ask more than one short
   question; if the brief is clear, proceed.
2. **Outline first.** Draft a slide-by-slide outline (title + 3–5 tight bullets or one
   visual idea per slide). A good deck = one idea per slide, headline-style titles, few
   words, concrete numbers. Open with the takeaway, close with next steps / the ask.
3. **Build the file** with `run_in_sandbox`. Write a SELF-CONTAINED HTML deck to
   `$OUTPUT_DIR/<name>.html` — inline CSS, NO external CDNs (works offline, one portable
   file). Use the template below: one `<section class="slide">` per slide, a print
   stylesheet so each slide is one page. Keep it clean and legible (large type, generous
   spacing, a single accent colour).
4. **Export to PDF** in the same sandbox:
   `chromium --headless --no-sandbox --disable-gpu --print-to-pdf="$OUTPUT_DIR/<name>.pdf" "$OUTPUT_DIR/<name>.html"`
   (fall back to `chromium-browser` / `google-chrome` if `chromium` isn't the binary).
5. **Deliver.** Tell the user the deck is ready as an artifact (they can preview it,
   download it, and present it full-screen), and offer to `save_artifact` it to a folder.
   Summarise the structure in 1–2 lines. Don't paste the whole HTML into chat.

## Self-contained HTML template (fill, don't reinvent)

```html
<!doctype html><html lang="LANG"><head><meta charset="utf-8">
<title>DECK TITLE</title>
<style>
  :root{--accent:#2b6cb0;--ink:#1a202c;--muted:#4a5568;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink)}
  .slide{width:100%;min-height:100vh;padding:8vh 9vw;display:flex;flex-direction:column;
    justify-content:center;border-bottom:1px solid #edf2f7;page-break-after:always}
  .slide h1{font-size:3rem;line-height:1.1;margin-bottom:1rem}
  .slide h2{font-size:2.1rem;color:var(--accent);margin-bottom:1.2rem}
  .slide ul{list-style:none} .slide li{font-size:1.5rem;color:var(--muted);
    margin:.6rem 0;padding-left:1.4rem;position:relative}
  .slide li::before{content:"▸";position:absolute;left:0;color:var(--accent)}
  .kpi{font-size:4rem;font-weight:700;color:var(--accent)}
  .cover{background:var(--accent);color:#fff} .cover h1{color:#fff}
  .cover .sub{font-size:1.4rem;opacity:.9;margin-top:1rem}
  @media print{.slide{min-height:auto;height:100vh}}
</style></head><body>
  <section class="slide cover"><h1>DECK TITLE</h1><div class="sub">subtitle · author · date</div></section>
  <section class="slide"><h2>Slide title</h2><ul><li>point</li><li>point</li></ul></section>
  <!-- …one section per slide… -->
</body></html>
```

## Quality bar

- One idea per slide; headline titles; numbers over adjectives.
- The cover and the closing "next steps / ask" slides are mandatory.
- If the deck visualises data, prefer a simple chart image or a big KPI number over a table.
- Never deliver only chat text when slides were requested — the file IS the deliverable.
