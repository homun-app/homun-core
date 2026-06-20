---
name: create-documents
description: Use when the user asks for a written document, report, proposal, business letter, contract draft, meeting minutes, one-pager, or "scrivimi un documento / una relazione / una proposta / una lettera". Produces a formatted document (PDF) as an artifact.
---

# Create Documents

Produce a real, formatted **document** the user can send or print — a PDF artifact — not
just text in chat. Covers reports, proposals/quotes (the prose, not the e-invoice),
business letters, contract drafts, meeting minutes, one-pagers.

## When to use

"Scrivimi una relazione/proposta/lettera/report", "metti questo in un documento",
"preparami una proposta per il cliente", "verbale della riunione".

## Process

1. **Scope + brand.** Infer doc type, audience, tone (formal/neutral), language, and
   length from the request and any source material (read attached files / a URL with
   `browse_web`). Call `get_brand_kit` and apply its colours/fonts/logo to the HTML
   shell (a branded header bar + the logo) so the document is on-brand. At most one
   short clarifying question.
2. **Draft the content** in clean Markdown: a clear title, sensible headings, short
   paragraphs, lists where they help, a table where structure helps. Be concrete and
   complete — a document stands on its own (the reader has no chat context).
3. **Render to PDF** with `run_in_sandbox`. Write the Markdown to
   `$OUTPUT_DIR/<name>.md`, wrap it in the print-ready HTML shell below (inline CSS,
   self-contained), then:
   `chromium --headless --no-sandbox --disable-gpu --print-to-pdf="$OUTPUT_DIR/<name>.pdf" "$OUTPUT_DIR/<name>.html"`.
   If `pandoc` is available and the user wants `.docx`, also run
   `pandoc <name>.md -o <name>.docx` — otherwise PDF is the deliverable.
4. **Deliver.** The PDF (and `.md` source) are artifacts: tell the user it's ready to
   download/send, offer `save_artifact` to a folder, and give a one-line summary. Don't
   paste the whole document into chat.

## Print-ready HTML shell

```html
<!doctype html><html lang="LANG"><head><meta charset="utf-8"><title>TITLE</title>
<style>
  body{font-family:Georgia,"Times New Roman",serif;color:#1a202c;max-width:820px;
    margin:0 auto;padding:48px;line-height:1.55}
  h1{font-size:1.9rem;border-bottom:2px solid #2b6cb0;padding-bottom:.3rem}
  h2{font-size:1.35rem;color:#2b6cb0;margin-top:1.6rem}
  table{border-collapse:collapse;width:100%;margin:1rem 0}
  th,td{border:1px solid #cbd5e0;padding:.5rem .7rem;text-align:left}
  th{background:#edf2f7} .muted{color:#4a5568;font-size:.9rem}
  @page{margin:2cm}
</style></head><body>
  <!-- rendered Markdown goes here -->
</body></html>
```

## Quality bar

- Self-standing: a header with title/date/parties where relevant, then the substance.
- Proposals/quotes: scope, deliverables, timeline, price, terms, next step.
- Letters: proper salutation, body, sign-off.
- Match the user's language. Never deliver only chat text when a document was requested.
