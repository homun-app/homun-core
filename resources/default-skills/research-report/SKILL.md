---
name: research-report
description: Use when the user asks to research a topic on the web and produce a written report — market/competitor analysis, supplier comparison, due diligence, "ricerca su X e fammi un report / analisi di mercato / confronto / sintesi delle fonti". Produces a sourced report artifact.
---

# Research Report

Do real web research and deliver a **sourced, structured report** — gather from multiple
sources, synthesise, and produce a document the user can act on. Pairs the browser with
the `create-documents` rendering.

## When to use

"Analisi di mercato su X", "confronta questi fornitori/competitor", "ricerca e fammi un
report su Y", "cosa dice il web su Z", "due diligence rapida su questa azienda".

## Process

1. **Frame the question.** Restate the research goal and the key sub-questions you'll
   answer (3–6). Note the decision the report should support.
2. **Gather** with `browse_web`: visit several independent, credible sources (not one).
   For comparisons, collect the same fields for each option. Capture each source's URL
   and the specific fact taken from it — you will cite them.
3. **Synthesise, don't dump.** Cross-check claims across sources; flag disagreements and
   uncertainty. Turn raw findings into an answer to the framed question, with concrete
   numbers where available.
4. **Write the report** (Markdown) in this structure, in the user's language:
   - **Executive summary** — the answer + the recommendation, up front.
   - **Findings** — organised by sub-question; tables for comparisons.
   - **Risks / open questions** — what's uncertain or needs verification.
   - **Sources** — a numbered list of URLs actually used (every key claim traceable).
5. **Render & deliver.** Produce a PDF via the `create-documents` HTML→PDF approach; the
   report + sources are an artifact. Offer `save_artifact`. Lead the reply with the
   recommendation, not the process.

## Quality bar

- Every non-obvious claim is traceable to a source in the list — no unsourced assertions.
- Multiple sources, not a single page; note when sources conflict.
- Recommendation-first: the reader gets the decision-relevant answer immediately.
- Honest about gaps — say what couldn't be confirmed rather than guessing.
