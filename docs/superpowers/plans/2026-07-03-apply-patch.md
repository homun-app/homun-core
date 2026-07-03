# apply_patch — Codex-faithful multi-file structured edit tool — Implementation Plan

> Subagent-driven + TDD. Grammar extracted verbatim from the real Codex `codex-cli 0.142.5` binary
> (`/Users/fabio/Projects/codex/Contents/Resources/codex`).

**Goal:** A new builtin tool `apply_patch` that applies Codex-format multi-file patches (`*** Begin Patch` …
`*** End Patch`) — Add/Update/Delete/Move — with context-based (line-number-free) hunk matching, atomically,
confined by the EXISTING sandbox chokepoint + `jail_in_root` (apply_patch owns parse+match+edit, NOT confinement —
exactly Codex's split).

**Architecture:** A focused module `crates/desktop-gateway/src/apply_patch.rs` (like `seatbelt.rs`/`tool_safety.rs`/
`landlock_fence.rs` — converge, don't grow `main.rs`) with a PURE parser + PURE applier (operate on a `read(path)`
closure + return computed changes; no direct IO), unit-tested in isolation. The gateway wires it: resolve each path via
`jail_in_root`, read current contents, apply (pure), gate via the sandbox axis, write atomically, emit a diff card.

**Tech Stack:** Rust (gateway), reuse `jail_in_root` / `project_root_for_thread` / the sandbox `tool_footprint` +
`resolved_sandbox_mode` + escalation machinery, and the existing DiffCard/`‹‹DIFF››` frontend part.

## Grammar (authoritative, from the Codex binary)

```
*** Begin Patch
*** Add File: <path>            + <content line>  (each body line MUST start with '+'; reject if path exists)
*** Delete File: <path>         (nothing follows)
*** Update File: <path>         optional next line: *** Move to: <newpath>
@@                              or  @@ <context hint>   (NO line numbers)
 <context line>                 (leading single space = unchanged context, must match file)
-<removed line>
+<added line>
*** End of File                 (EOF sentinel; disambiguates end-of-file context)
*** End Patch                   (trailing LF optional)
```
- Multiple `@@` hunks per Update File; a new `*** ` header or `*** End Patch` ends the current file.
- **Context matching (no line numbers):** locate each hunk by matching its context + `-` lines against the file,
  3-pass fuzzy: (1) exact, (2) ignore trailing whitespace, (3) ignore all leading/trailing whitespace. The optional
  `@@ <hint>` anchors/disambiguates when the snippet repeats.
- **Atomic:** parse the WHOLE patch first (validate envelope first/last line), compute all changes, apply all-or-nothing.
- Parser-level guards apply_patch owns: Add-over-existing → reject; target is a directory → reject; unresolvable
  hunk context → reject. Path confinement (jail) + writable-root enforcement are the SANDBOX layer's job, not here.

---

## Task A: pure parser — grammar → structured `Patch`

**Files:** Create `crates/desktop-gateway/src/apply_patch.rs`; register `mod apply_patch;` in `main.rs`.

Data model:
```rust
#[derive(Debug, Clone, PartialEq)]
pub enum PatchLine { Context(String), Removed(String), Added(String) }

#[derive(Debug, Clone, PartialEq)]
pub struct Hunk { pub context_hint: Option<String>, pub lines: Vec<PatchLine>, pub eof: bool }

#[derive(Debug, Clone, PartialEq)]
pub enum FileOp {
    Add { path: String, contents: String },
    Delete { path: String },
    Update { path: String, move_to: Option<String>, hunks: Vec<Hunk> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Patch { pub ops: Vec<FileOp> }

#[derive(Debug, Clone, PartialEq)]
pub enum ParseError { NoBegin, NoEnd, BadHeader(String), EmptyHunk, UnexpectedLine(String), AddLineMissingPlus(String) }
```

- [ ] **Step 1 (test first):** write parser tests from the verbatim Codex examples, run, confirm fail (fn missing):
```rust
#[test]
fn parses_add_update_move_delete() {
    let patch = "*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n\
*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print(\"Hi\")\n+print(\"Hello, world!\")\n\
*** Delete File: obsolete.txt\n*** End Patch\n";
    let p = parse_patch(patch).unwrap();
    assert_eq!(p.ops.len(), 3);
    assert_eq!(p.ops[0], FileOp::Add { path: "hello.txt".into(), contents: "Hello world\n".into() });
    match &p.ops[1] {
        FileOp::Update { path, move_to, hunks } => {
            assert_eq!(path, "src/app.py");
            assert_eq!(move_to.as_deref(), Some("src/main.py"));
            assert_eq!(hunks.len(), 1);
            assert_eq!(hunks[0].context_hint.as_deref(), Some("def greet():"));
            assert_eq!(hunks[0].lines, vec![
                PatchLine::Removed("print(\"Hi\")".into()),
                PatchLine::Added("print(\"Hello, world!\")".into()),
            ]);
        }
        _ => panic!("expected Update"),
    }
    assert_eq!(p.ops[2], FileOp::Delete { path: "obsolete.txt".into() });
}

#[test]
fn rejects_missing_envelope() {
    assert_eq!(parse_patch("*** Update File: x\n").unwrap_err(), ParseError::NoBegin);
    assert_eq!(parse_patch("*** Begin Patch\n*** Update File: x\n@@\n pass\n").unwrap_err(), ParseError::NoEnd);
}

#[test]
fn add_file_body_lines_must_start_with_plus() {
    let bad = "*** Begin Patch\n*** Add File: a.txt\nnot-plus\n*** End Patch\n";
    assert!(matches!(parse_patch(bad).unwrap_err(), ParseError::AddLineMissingPlus(_)));
}
```
- [ ] **Step 2:** implement `pub fn parse_patch(text: &str) -> Result<Patch, ParseError>` — a line-oriented recursive parser matching the grammar. `Add` contents = body `+`-lines with the `+` stripped, joined with `\n` and a trailing `\n` (each add_line ends with LF). `Update` collects `*** Move to:` (optional, immediately after header) then one-or-more `@@` hunks; each hunk's lines are `+`/`-`/` ` prefixed (strip the single prefix char); a body line without a valid prefix → `UnexpectedLine`; a hunk with zero lines → `EmptyHunk`. Track `*** End of File` → `Hunk.eof = true`. Ignore `*** Environment ID:` lines (Codex container extension, not relevant here).
- [ ] **Step 3:** run tests → green. Add more: multi-hunk single file; Update with no Move; Add empty file (single empty `+` line → contents `"\n"`); Delete then Add different paths.
- [ ] **Step 4:** commit `feat(gateway): apply_patch parser (Codex grammar) (ADR 0023 follow-up)`.

## Task B: pure applier — `Patch` + read-closure → computed `FileChange`s (context match, atomic)

**Files:** extend `apply_patch.rs`.

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum FileChange {
    Write { path: String, contents: String },   // Add or Update result (new full contents)
    Rename { from: String, to: String, contents: String }, // Update + Move to
    Delete { path: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ApplyError {
    AddExists(String), Missing(String), ContextNotFound { path: String, hint: Option<String> },
    IsDirectory(String),  // set by the caller (fs layer), reserved here
}

/// Pure: compute the file changes a patch would make, given a reader that returns the
/// current contents of a path (None = does not exist). Atomic: returns all changes or the
/// FIRST error; performs NO IO. Context matching is 3-pass fuzzy (exact → trim-trailing-ws
/// → trim-all-ws), anchored by the optional @@ hint when the snippet repeats.
pub fn compute_changes(patch: &Patch, read: &dyn Fn(&str) -> Option<String>) -> Result<Vec<FileChange>, ApplyError>
```

- [ ] **Step 1 (test first):** applier tests:
```rust
#[test]
fn update_applies_hunk_by_context_not_line_number() {
    let patch = parse_patch("*** Begin Patch\n*** Update File: a.py\n@@\n def f():\n-    return 1\n+    return 2\n*** End Patch\n").unwrap();
    let files = |p: &str| (p == "a.py").then(|| "def f():\n    return 1\n".to_string());
    let changes = compute_changes(&patch, &files).unwrap();
    assert_eq!(changes, vec![FileChange::Write { path: "a.py".into(), contents: "def f():\n    return 2\n".into() }]);
}

#[test]
fn add_over_existing_is_rejected() {
    let patch = parse_patch("*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n").unwrap();
    let files = |p: &str| (p == "a.txt").then(|| "already".to_string());
    assert_eq!(compute_changes(&patch, &files).unwrap_err(), ApplyError::AddExists("a.txt".into()));
}

#[test]
fn update_missing_file_is_rejected() {
    let patch = parse_patch("*** Begin Patch\n*** Update File: nope.txt\n@@\n-a\n+b\n*** End Patch\n").unwrap();
    assert_eq!(compute_changes(&patch, &(|_: &str| None)).unwrap_err(), ApplyError::Missing("nope.txt".into()));
}

#[test]
fn context_fuzzy_matches_trailing_whitespace() {
    // File has trailing spaces the patch omits; pass-2 (trim trailing ws) should still match.
    let patch = parse_patch("*** Begin Patch\n*** Update File: a.txt\n@@\n-hello\n+world\n*** End Patch\n").unwrap();
    let files = |p: &str| (p == "a.txt").then(|| "hello   \n".to_string());
    assert_eq!(compute_changes(&patch, &files).unwrap(), vec![FileChange::Write { path: "a.txt".into(), contents: "world\n".into() }]);
}

#[test]
fn move_to_produces_rename() {
    let patch = parse_patch("*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-a\n+A\n*** End Patch\n").unwrap();
    let files = |p: &str| (p == "a.txt").then(|| "a\n".to_string());
    assert_eq!(compute_changes(&patch, &files).unwrap(), vec![FileChange::Rename { from: "a.txt".into(), to: "b.txt".into(), contents: "A\n".into() }]);
}
```
- [ ] **Step 2:** implement `compute_changes`: for each op — Add → `AddExists` if read()≠None else `Write{path, contents}`; Delete → `Missing` if read()==None else `Delete{path}`; Update → read (Missing if None), apply each hunk by locating its context+removed lines in the current contents via the 3-pass fuzzy matcher, splice in the added lines, then `Rename` if move_to else `Write`. All-or-nothing: return the first error before emitting any change (compute into a Vec, return Err on first failure). Newline handling: preserve the file's existing trailing-newline convention; honor `*** End of File`.
- [ ] **Step 3:** implement the fuzzy matcher as a private `find_hunk_location(file_lines, hunk) -> Option<usize>` (3 passes). Tests: exact, trailing-ws, leading-ws; repeated-snippet disambiguated by `@@ hint`; not-found → `ContextNotFound`.
- [ ] **Step 4:** run all → green. Commit `feat(gateway): apply_patch applier — context match + atomic changes (ADR 0023 follow-up)`.

## Task C: wire into the gateway (tool schema, dispatch, jail, sandbox gate, diff card)

**Files:** `crates/desktop-gateway/src/main.rs` (tool schema + `base_tools` + `execute_chat_tool` dispatch + `tool_footprint` in `tool_safety.rs`).

- [ ] **Step 1:** add `apply_patch_tool_schema()` — a function tool named `apply_patch`, one required string arg `input` (the full patch text). Description: mirror Codex ("Use apply_patch to edit files. Provide a patch in the `*** Begin Patch` … `*** End Patch` format. Add File body lines start with `+`; Update hunks use `@@` context and `+`/`-`/space line prefixes; no line numbers."). Push it into `base_tools` next to `write_file_tool_schema()`/`edit_file_tool_schema()`.
- [ ] **Step 2:** in `tool_safety.rs` `tool_footprint`, classify `"apply_patch"` as `ToolFootprint::Write { path: "<multiple>".into() }` (it writes; the specific paths are internal). This makes `write_needs_read_only_escalation("apply_patch", …)` true under read-only.
- [ ] **Step 3:** dispatch in `execute_chat_tool` (`} else if name == "apply_patch" {`): 
  - parse `input`; on `ParseError` return a clear model-facing error string (do not execute).
  - **sandbox gate:** if `resolved_sandbox_mode() == ReadOnly` → return a deny message: "apply_patch is blocked by the read-only sandbox — switch the sandbox mode in Settings to allow writes." (Escalation-card support for apply_patch is a follow-up; read-only is opt-in, the message guides the user.) Under workspace-write/danger → proceed.
  - resolve project root via `project_root_for_thread`; build a `read` closure that maps a relative path through `jail_in_root(&root, path)` then reads the file (None if absent). `jail_in_root` rejects `..`/absolute/symlink-escape → surface as an error string (never write outside root).
  - `compute_changes(&patch, &read)`; on `ApplyError` return a clear message (nothing written).
  - apply the `FileChange`s to disk **atomically-ish**: since std::fs isn't transactional, first re-validate all target paths jail cleanly, then perform writes/renames/deletes; if a write fails mid-way, report which succeeded (best-effort; compute_changes already guaranteed context matched, so failures here are IO-level). Reuse `write_project_file`-style jailing. Directory-target → `IsDirectory` error.
  - register artifact memory for written paths (mirror `register_project_file_artifact_memory` used by write_file).
  - emit a **diff card**: reuse the existing `‹‹DIFF››`/`DiffCard` part (grep how write/edit emit `‹‹ACT››`/diff; if a structured diff event exists, emit old-vs-new per file; else emit a concise summary "apply_patch: +N/-M across K files: a.py, b.py"). Keep it informative but bounded.
  - return a success string listing the files changed (Codex: "Applied patch"/"Success. Updated the following files: …").
- [ ] **Step 4:** tests — a gateway-level test that drives `execute_chat_tool` is heavy; instead unit-test the pure pieces (done in A/B) and add ONE integration test that builds a temp project dir, calls the dispatch helper (or a thin `apply_patch_to_root(root, input) -> Result<Vec<FileChange>,String>` extracted for testability) and asserts files on disk changed. Also test: read-only mode returns the deny message; a `..` path in the patch is rejected by jail.
- [ ] **Step 5:** `cargo test -p local-first-desktop-gateway apply_patch` + `cargo check`. Commit `feat(gateway): wire apply_patch tool — jail + sandbox gate + diff card (ADR 0023 follow-up)`.

## Task D: frontend affordance (diff card) + docs

- [ ] **Step 1:** ensure the emitted diff/summary renders. If apply_patch reuses the existing `‹‹DIFF››` DiffCard, verify the marker parse handles a multi-file summary (grep `DIFF` in ChatView.tsx); if a small extension is needed, add it. `npm run build` + `npm run test:ui-contract` green. Don't touch check-ui-contract.mjs.
- [ ] **Step 2:** docs: new `architecture/` note or extend the tool docs with apply_patch (grammar + the Codex-faithful split: apply_patch owns parse/match/edit, sandbox owns confinement); STATO ⭐ RIPRESA (apply_patch shipped; read-only escalation for apply_patch = follow-up; next = subagent orchestration). Commit `docs: apply_patch tool (Codex-faithful) + STATO`.

---

## Self-review
- Coverage: parser (A) + applier (B) + wiring/gate/diff (C) + frontend/docs (D). Grammar fidelity anchored to the real binary. Confinement delegated to jail_in_root + sandbox chokepoint (Codex's split), NOT re-implemented.
- Deferred (noted, not gaps): read-only ESCALATION card for apply_patch (initial cut denies-with-message; escalation is a follow-up mirroring Task 4's write escalation, marker tool=apply_patch, arguments={input}); precise per-file old-vs-new diff rendering if only a summary ships first.
- Risk: the fuzzy context matcher is the subtle part → covered by targeted unit tests (exact/trailing-ws/leading-ws/repeat-disambiguation/not-found). Atomicity is guaranteed at compute time (pure), best-effort at fs write time (documented).
