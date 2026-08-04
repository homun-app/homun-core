# ODT Chat Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a valid ODT attachment directly analyzable in chat and stop presenting extraction errors as ready text.

**Architecture:** Extend the canonical attachment ingestor with a bounded native ODT ZIP/XML extractor. Keep persistence unchanged, but classify persisted warning notes as unavailable when assembling the model prompt and place their diagnostics outside attachment content.

**Tech Stack:** Rust, `zip`, SQLite-backed thread attachments, Cargo unit tests.

---

### Task 1: Native ODT extraction

**Files:**
- Modify: `crates/desktop-gateway/src/attachments.rs`
- Test: `crates/desktop-gateway/src/attachments.rs`

- [x] **Step 1: Write the failing ODT tests**

Create a synthetic ODT ZIP containing `content.xml`; assert that headings, paragraphs, repeated
spaces, tabs, line breaks, table cells and XML entities become readable text. Add MIME-only and
extension-only recognition tests plus invalid-package tests.

- [x] **Step 2: Run the focused test and observe the unsupported-format failure**

Run: `cargo test -p local-first-desktop-gateway attachments::tests::odt -- --nocapture`

Expected: FAIL because the current ingestor returns `type not yet supported`.

- [x] **Step 3: Implement the bounded extractor**

Add `is_opendocument_text`, `ingest_opendocument_text` and `opendocument_text_content`. Reuse
`read_file_capped`, `zip::ZipArchive`, `decode_xml_text` and `truncate_chars`; never invoke an
external process.

- [x] **Step 4: Run all attachment tests**

Run: `cargo test -p local-first-desktop-gateway attachments::tests -- --nocapture`

Expected: every non-ignored attachment test passes.

### Task 2: Truthful prompt representation

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/main.rs`

- [x] **Step 1: Write the failing prompt classification test**

Build stored attachments with normal text, images and a `⚠️` extraction note. Assert that the
manifest labels them `text`, `images/scan` and `unavailable`, and that the warning is absent from
the content section but present in a separate extraction-issues section.

- [x] **Step 2: Run the focused test and observe the warning classified as text**

Run: `cargo test -p local-first-desktop-gateway attachment_prompt -- --nocapture`

Expected: FAIL until prompt assembly is extracted into the tested helper.

- [x] **Step 3: Implement the prompt helper and wire the canonical path**

Move only attachment prompt assembly into a pure helper. Preserve text/image budgets and ordering;
do not change memory, routing or tool policy.

- [x] **Step 4: Run the focused gateway tests**

Run: `cargo test -p local-first-desktop-gateway attachment_prompt -- --nocapture`

Expected: PASS.

### Task 3: Documentation and release gates

**Files:**
- Modify: `docs/architecture/agent-loop.md`
- Modify: `docs/STATO.md`

- [x] **Step 1: Document the attachment contract**

Record that broker file inputs are extracted once, persisted per thread and injected only when
ready; ODT uses bounded local ZIP/XML extraction and failures remain diagnostics.

- [x] **Step 2: Run deterministic gates**

Run:

```bash
cargo test -p local-first-desktop-gateway
(cd apps/desktop && npm run test:ui-contract && npm run build)
git diff --check
```

Expected: all commands exit 0; pre-existing compiler warnings may remain unchanged. Formatting is
kept scoped to the touched code because the current workspace has an unrelated dirty baseline.

- [x] **Step 3: Verify the original document**

Run the ignored/local smoke test or a small gateway fixture against
`/Users/fabio/Desktop/chat_2026-07-20.odt` and assert extracted text is non-empty and the
unsupported warning is absent.
