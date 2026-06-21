---
name: create-presentations
description: Use when the user asks for a presentation, slides, a slide deck, a pitch deck, or "fammi delle slide / una presentazione / un deck" on any topic. Produces an ON-BRAND, VISUAL deck as an EDITABLE PowerPoint (.pptx) + an HTML/PDF preview.
---

# Create Presentations

Produce a real, **visual, on-brand** slide deck as an EDITABLE PowerPoint (.pptx)
plus an HTML/PDF preview. **The engine does the whole job in ONE tool call.**

## When to use

"fammi una presentazione su X", "slide per il consiglio", "pitch deck", "presenta
questi dati". Slides / deck / presentation / pitch.

## Process — ONE call, nothing else

Call the **`make_deck`** tool with:

- `brief`: the user's request **verbatim**, plus any structure, sections, points,
  audience or data they gave. Include source material you were asked to use.
- `language`: the user's language (e.g. `it`, `en`).
- `slides`: the requested slide count if any (otherwise omit — default is 6).

That's it. `make_deck` does EVERYTHING deterministically: it applies the brand
kit (colours, fonts, logo), writes the slide content, generates the on-brand
images, and renders `deck.pptx` + `deck.html` + `deck.pdf`. When it returns, the
deck is **DONE**.

**Do NOT** make a plan (`update_plan`), **do NOT** call `get_brand_kit`,
`generate_image`, `render_deck` or `create_artifact`, **do NOT** use the shell,
**do NOT** write files, and **do NOT** search the filesystem. One call to
`make_deck` replaces all of that. After it returns, do not re-run it, re-render,
or "verify" — just summarise.

## Deliver

`deck.pptx` (editable), `deck.html` and `deck.pdf` are returned as artifacts.
Tell the user the .pptx is editable in PowerPoint / Google Slides and the
.html/.pdf are for quick viewing, summarise the deck in ONE line, and offer
`save_artifact` if they want it copied to a folder. Never paste the JSON or HTML
into chat.

## Quality bar (handled by the engine, stated here for reference)

- ON-BRAND: brand colours + fonts + logo, applied automatically.
- VISUAL: cover image + a couple of key visuals; cover and closing slides always
  present; speaker notes on the substantive slides.
- One idea per slide; headline titles; numbers over adjectives.
- The **.pptx is the editable deliverable**; the .html/.pdf are the preview.
