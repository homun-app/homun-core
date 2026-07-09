//! Pure parser for Codex-format patches.
//!
//! This module implements ONLY parsing (Task A). The applier (which resolves
//! hunks against real file contents) and the gateway wiring come in later tasks,
//! so everything here is deliberately IO-free: no `std::fs`, no side effects.
//! `parse_patch` turns a patch string into an in-memory [`Patch`] value.
//!
//! # Why the grammar has no line numbers
//!
//! Unlike a classic unified diff, the Codex patch format does NOT carry `@@ -a,b
//! +c,d @@` line-number ranges. A hunk header is either a bare `@@` or `@@ <hint>`
//! where `<hint>` is a free-form "section" string (e.g. a function signature) that
//! merely helps a human/applier locate the region. The applier is expected to
//! match the *context lines* (the ` ` / `-` prefixed lines) against the current
//! file rather than trusting absolute offsets. This makes patches robust to a
//! file that drifted by a few lines since the model read it — there are no offsets
//! to invalidate. Consequently the parser stores the hint verbatim and never tries
//! to interpret it as a location; positional resolution is entirely the applier's
//! job.

// Symbols are consumed by the applier + gateway wiring landing in the following
// tasks (B/C). Until then some public items look unused to the compiler; this is
// expected and intentional, so silence dead-code noise for the whole module.
#![allow(dead_code)]

/// A single line inside an `Update` hunk, tagged by its role.
///
/// The leading prefix char (` `, `-`, `+`) has already been stripped; the stored
/// string is the raw content with all other whitespace preserved exactly.
#[derive(Debug, Clone, PartialEq)]
pub enum PatchLine {
    /// Unchanged context line (source line began with a single space).
    Context(String),
    /// Line removed by the patch (source line began with `-`).
    Removed(String),
    /// Line added by the patch (source line began with `+`).
    Added(String),
}

/// One `@@` hunk within an `Update File` operation.
#[derive(Debug, Clone, PartialEq)]
pub struct Hunk {
    /// The free-form section hint after `@@ `, or `None` for a bare `@@`.
    /// Never a line number — see the module docs for why.
    pub context_hint: Option<String>,
    /// Ordered body lines (context / removed / added).
    pub lines: Vec<PatchLine>,
    /// Whether the hunk ended with the `*** End of File` sentinel, meaning the
    /// hunk reaches the end of the target file.
    pub eof: bool,
}

/// A single file-level operation described by the patch.
#[derive(Debug, Clone, PartialEq)]
pub enum FileOp {
    /// Create a new file. `contents` already has the `+` prefixes stripped and a
    /// trailing `\n` on every body line.
    Add { path: String, contents: String },
    /// Delete an existing file.
    Delete { path: String },
    /// Modify (and optionally rename) an existing file via one-or-more hunks.
    Update {
        path: String,
        move_to: Option<String>,
        hunks: Vec<Hunk>,
    },
}

/// A fully parsed patch: an ordered list of file operations.
#[derive(Debug, Clone, PartialEq)]
pub struct Patch {
    pub ops: Vec<FileOp>,
}

/// Everything that can go wrong while parsing. Carries the offending line where
/// useful so callers can surface a precise diagnostic.
#[derive(Debug, Clone, PartialEq)]
pub enum ParseError {
    /// The text did not start with `*** Begin Patch`.
    NoBegin,
    /// No `*** End Patch` line was found.
    NoEnd,
    /// A `*** ...` header we did not recognise.
    BadHeader(String),
    /// An `Update File` hunk had zero body lines.
    EmptyHunk,
    /// A line inside a hunk had none of the valid ` `/`-`/`+` prefixes.
    UnexpectedLine(String),
    /// An `Add File` body line did not start with `+`.
    AddLineMissingPlus(String),
}

const BEGIN: &str = "*** Begin Patch";
const END: &str = "*** End Patch";
const ADD: &str = "*** Add File: ";
const DELETE: &str = "*** Delete File: ";
const UPDATE: &str = "*** Update File: ";
const MOVE: &str = "*** Move to: ";
const ENV_ID: &str = "*** Environment ID:";
const END_OF_FILE: &str = "*** End of File";
const HEADER_PREFIX: &str = "*** ";

/// Parse a Codex-format patch into a [`Patch`].
///
/// Pure and IO-free: the input is a full patch string, the output is either the
/// structured representation or a [`ParseError`]. The parser is line-oriented and
/// dispatches on `*** ` header lines; see the grammar in the module docs.
pub fn parse_patch(text: &str) -> Result<Patch, ParseError> {
    // Split into lines without keeping the terminators. We reconstruct the single
    // `\n` we need ourselves (Add File bodies), and never depend on whether the
    // input used a trailing newline — the grammar says the final LF is optional.
    let lines: Vec<&str> = text.lines().collect();

    // Envelope: first meaningful line must be Begin, and End must exist somewhere.
    let first = lines.first().copied().ok_or(ParseError::NoBegin)?;
    if first != BEGIN {
        return Err(ParseError::NoBegin);
    }
    if !lines.iter().any(|l| *l == END) {
        return Err(ParseError::NoEnd);
    }

    let mut ops = Vec::new();
    // Index cursor over `lines`, starting just after `*** Begin Patch`.
    let mut i = 1usize;

    while i < lines.len() {
        let line = lines[i];

        if line == END {
            // End of the patch envelope; ignore anything after it.
            break;
        }

        if let Some(path) = line.strip_prefix(ADD) {
            // Add File: consume following lines until the next `*** ` header.
            // Every consumed line must begin with `+`.
            let mut contents = String::new();
            i += 1;
            while i < lines.len() && !lines[i].starts_with(HEADER_PREFIX) {
                let body = lines[i];
                let stripped = body
                    .strip_prefix('+')
                    .ok_or_else(|| ParseError::AddLineMissingPlus(body.to_string()))?;
                // Each body line keeps its own LF; an empty `+` yields just "\n".
                contents.push_str(stripped);
                contents.push('\n');
                i += 1;
            }
            ops.push(FileOp::Add {
                path: path.to_string(),
                contents,
            });
            continue;
        }

        if let Some(path) = line.strip_prefix(DELETE) {
            ops.push(FileOp::Delete {
                path: path.to_string(),
            });
            i += 1;
            continue;
        }

        if let Some(path) = line.strip_prefix(UPDATE) {
            i += 1;

            // Optional `*** Move to:` on the immediately-next line.
            let mut move_to = None;
            if i < lines.len() {
                if let Some(newpath) = lines[i].strip_prefix(MOVE) {
                    move_to = Some(newpath.to_string());
                    i += 1;
                }
            }

            // Parse one-or-more hunks until a new header or End Patch.
            let (hunks, next) = parse_hunks(&lines, i)?;
            i = next;
            ops.push(FileOp::Update {
                path: path.to_string(),
                move_to,
                hunks,
            });
            continue;
        }

        if line.starts_with(ENV_ID) {
            // Codex container extension; irrelevant to a local applier.
            i += 1;
            continue;
        }

        if line.starts_with(HEADER_PREFIX) {
            // A `*** ...` line we don't know how to handle.
            return Err(ParseError::BadHeader(line.to_string()));
        }

        // A non-header line appearing where a header was expected (e.g. stray text
        // between file ops) is malformed.
        return Err(ParseError::UnexpectedLine(line.to_string()));
    }

    Ok(Patch { ops })
}

/// Parse the run of `@@` hunks that follow an `*** Update File:` header.
///
/// `start` is the index of the first candidate hunk line. Returns the parsed
/// hunks and the index of the line that terminated the run (a new `*** ` header
/// or `*** End Patch`), which the caller resumes from.
fn parse_hunks(lines: &[&str], start: usize) -> Result<(Vec<Hunk>, usize), ParseError> {
    let mut hunks = Vec::new();
    let mut i = start;

    while i < lines.len() {
        let line = lines[i];

        // A new file header or the end sentinel terminates this file's hunks.
        if line.starts_with(HEADER_PREFIX) && !is_end_of_file(line) {
            break;
        }

        // Every hunk must open with `@@` (bare) or `@@ <hint>`.
        let context_hint = if line == "@@" {
            None
        } else if let Some(hint) = line.strip_prefix("@@ ") {
            Some(hint.to_string())
        } else {
            // Not a hunk header and not a terminator → malformed body line.
            return Err(ParseError::UnexpectedLine(line.to_string()));
        };
        i += 1;

        // Collect the hunk body: ` `/`-`/`+` lines, optionally closed by
        // `*** End of File`. A new `@@` or `*** ` header ends the body.
        let mut body = Vec::new();
        let mut eof = false;
        while i < lines.len() {
            let bl = lines[i];

            if is_end_of_file(bl) {
                eof = true;
                i += 1;
                break; // sentinel closes this hunk
            }
            if bl == "@@" || bl.starts_with("@@ ") || bl.starts_with(HEADER_PREFIX) {
                // Start of the next hunk or a terminating header — stop here
                // without consuming it.
                break;
            }

            if let Some(rest) = bl.strip_prefix('+') {
                body.push(PatchLine::Added(rest.to_string()));
            } else if let Some(rest) = bl.strip_prefix('-') {
                body.push(PatchLine::Removed(rest.to_string()));
            } else if let Some(rest) = bl.strip_prefix(' ') {
                body.push(PatchLine::Context(rest.to_string()));
            } else {
                return Err(ParseError::UnexpectedLine(bl.to_string()));
            }
            i += 1;
        }

        if body.is_empty() {
            return Err(ParseError::EmptyHunk);
        }

        hunks.push(Hunk {
            context_hint,
            lines: body,
            eof,
        });
    }

    Ok((hunks, i))
}

/// True for the `*** End of File` sentinel (which is a header-shaped line but is
/// part of a hunk, not a file terminator).
fn is_end_of_file(line: &str) -> bool {
    line == END_OF_FILE
}

// ============================================================================
// Applier (Task B): resolve a parsed [`Patch`] against current file contents.
// ============================================================================

/// A concrete file mutation the patch resolves to. This is the applier's output;
/// actually touching the filesystem is the gateway's job (Task C), keeping this
/// module pure.
#[derive(Debug, Clone, PartialEq)]
pub enum FileChange {
    /// Create or overwrite `path` with `contents` — the full new file body.
    /// Covers both `Add File` and an in-place `Update File`.
    Write { path: String, contents: String },
    /// An `Update File` that also had `*** Move to:` — write `contents` to `to`
    /// and drop the old `from` path.
    Rename {
        from: String,
        to: String,
        contents: String,
    },
    /// Remove `path`.
    Delete { path: String },
}

/// Everything that can make applying a (well-formed) patch impossible against the
/// current tree state.
#[derive(Debug, Clone, PartialEq)]
pub enum ApplyError {
    /// `Add File` targets a path that already exists.
    AddExists(String),
    /// `Update`/`Delete File` targets a path that does not exist.
    Missing(String),
    /// A hunk's context/removed lines could not be located in the current file.
    ContextNotFound { path: String, hint: Option<String> },
}

/// Compute the file changes a patch makes, PURELY.
///
/// `read(path)` returns the current contents of a file (`None` = absent); the
/// applier performs no IO of its own. The result is atomic in spirit: it either
/// returns ALL changes or the FIRST [`ApplyError`]. Because each op resolves
/// independently through `read` (ops never observe each other's not-yet-written
/// output), returning on the first error before pushing is sufficient — nothing
/// partial escapes.
///
/// # Why context matching instead of line numbers
///
/// The Codex format carries no `@@ -a,b +c,d @@` offsets (see the module docs).
/// A patch may have been generated against a file that has since drifted by a few
/// lines, so we cannot trust positions. Instead we locate each hunk by matching
/// its context + removed lines against the current file. Matching is done in three
/// increasingly-lenient passes so that whitespace-only drift (a reformatted file,
/// trailing spaces the model didn't reproduce, re-indentation) does not defeat an
/// otherwise-correct patch:
///   * pass 1 — exact equality (fast path, no surprises);
///   * pass 2 — equality ignoring trailing whitespace (`trim_end`), the common case
///     where the model dropped or added trailing spaces;
///   * pass 3 — equality ignoring all leading+trailing whitespace (`trim`), which
///     also survives indentation changes.
/// We try each pass across ALL positions before loosening, so a stricter match is
/// always preferred over a looser one elsewhere in the file.
///
/// The optional `@@ <hint>` is an anchor, not a coordinate: when the same snippet
/// repeats (e.g. an identical body under two functions), we first restrict the
/// search to the region at/after the line that mentions the hint, and only fall
/// back to an unrestricted search if that yields nothing. This keeps the hint
/// helpful without making it a hard requirement for files where it's stale.
pub fn compute_changes(
    patch: &Patch,
    read: &dyn Fn(&str) -> Option<String>,
) -> Result<Vec<FileChange>, ApplyError> {
    let mut changes = Vec::with_capacity(patch.ops.len());

    for op in &patch.ops {
        match op {
            FileOp::Add { path, contents } => {
                if read(path).is_some() {
                    return Err(ApplyError::AddExists(path.clone()));
                }
                changes.push(FileChange::Write {
                    path: path.clone(),
                    contents: contents.clone(),
                });
            }
            FileOp::Delete { path } => {
                if read(path).is_none() {
                    return Err(ApplyError::Missing(path.clone()));
                }
                changes.push(FileChange::Delete { path: path.clone() });
            }
            FileOp::Update {
                path,
                move_to,
                hunks,
            } => {
                let current = read(path).ok_or_else(|| ApplyError::Missing(path.clone()))?;
                let contents = apply_hunks(path, &current, hunks)?;
                match move_to {
                    Some(to) => changes.push(FileChange::Rename {
                        from: path.clone(),
                        to: to.clone(),
                        contents,
                    }),
                    None => changes.push(FileChange::Write {
                        path: path.clone(),
                        contents,
                    }),
                }
            }
        }
    }

    Ok(changes)
}

/// Apply every hunk of an `Update` to `current`, returning the new file body.
///
/// The file is split into lines (without terminators) while remembering whether it
/// ended with a `\n`, so the trailing-newline convention is preserved exactly on
/// reassembly — a file with no final newline must not gain one, and vice versa.
/// Hunks are applied in order; each searches the buffer starting after the previous
/// hunk's applied region so that later hunks never rematch text an earlier hunk
/// already consumed (important when hunks target identical-looking lines).
fn apply_hunks(path: &str, current: &str, hunks: &[Hunk]) -> Result<String, ApplyError> {
    let ends_with_newline = current.ends_with('\n');
    // `str::lines()` drops the terminators and the trailing empty segment, which is
    // exactly the line vector we want to splice on; the newline flag above records
    // what `lines()` throws away so we can rebuild faithfully.
    let mut lines: Vec<String> = current.lines().map(|l| l.to_string()).collect();

    let mut from_index = 0usize;
    for hunk in hunks {
        // Search only at/after the previous hunk's applied region (`from_index`).
        // Codex hunks are meant to appear in FILE ORDER (this mirrors codex-rs, whose
        // `compute_replacements` walks a monotonically-advancing `line_index` and
        // never rewinds), so ordered-or-error is the correct, safe semantics for a
        // file editor: if a later hunk cannot be placed at/after the current cursor we
        // fail loudly rather than silently re-anchoring earlier in the file. An
        // unrestricted fallback would misorder edits — e.g. a later hunk re-anchoring
        // a shared context line and inserting ahead of an earlier hunk's insertion —
        // which is why there is no such fallback.
        let (start, end, replacement) = find_and_apply(&lines, hunk, from_index)
            .ok_or_else(|| ApplyError::ContextNotFound {
                path: path.to_string(),
                hint: hunk.context_hint.clone(),
            })?;

        let replacement_len = replacement.len();
        lines.splice(start..end, replacement);
        // Next hunk searches strictly after this hunk's rewritten region.
        from_index = start + replacement_len;
    }

    let mut out = lines.join("\n");
    if ends_with_newline && (!out.is_empty() || !lines.is_empty()) {
        out.push('\n');
    }
    Ok(out)
}

/// Locate a hunk's match-window in `lines` and produce its replacement.
///
/// The "match window" is the hunk's context + removed lines in order (what must be
/// present in the file). The "replacement" is its context + added lines in order
/// (drop `Removed`, keep `Context`, insert `Added`). Returns `(start, end,
/// replacement_lines)` where `start..end` is the matched region to splice out, or
/// `None` if no position matches under any of the three fuzzy passes.
///
/// `from_index` is a hard floor: matches are only considered at positions
/// `>= from_index`, so hunks apply strictly in file order (see [`apply_hunks`]).
fn find_and_apply(
    lines: &[String],
    hunk: &Hunk,
    from_index: usize,
) -> Option<(usize, usize, Vec<String>)> {
    let window: Vec<&String> = hunk
        .lines
        .iter()
        .filter_map(|l| match l {
            PatchLine::Context(s) | PatchLine::Removed(s) => Some(s),
            PatchLine::Added(_) => None,
        })
        .collect();

    let replacement: Vec<String> = hunk
        .lines
        .iter()
        .filter_map(|l| match l {
            PatchLine::Context(s) | PatchLine::Added(s) => Some(s.clone()),
            PatchLine::Removed(_) => None,
        })
        .collect();

    // An empty window (a hunk with only Added lines and no Context) has no anchor to
    // locate; such a case is not produced by the format for a pure insertion, but
    // guard against a zero-length match spinning at position 0.
    if window.is_empty() {
        return None;
    }

    // If a hint is present, prefer matches at/after the file line that mentions it.
    // Never look before `from_index`, so the hint can only tighten the floor within
    // the already-ordered search region, never rewind it.
    let hint_floor = hunk
        .context_hint
        .as_deref()
        .and_then(|hint| hint_anchor_index(lines, hint))
        .map(|anchor| anchor.max(from_index));

    // Try each fuzzy pass across all positions before loosening (a stricter match
    // anywhere beats a looser one). When a hint anchored a floor, search that region
    // first, then fall back to the rest of the ordered region (still `>= from_index`).
    for pass in 0..3 {
        if let Some(floor) = hint_floor {
            if let Some(start) = match_window(lines, &window, pass, floor) {
                return Some((start, start + window.len(), replacement));
            }
        }
        if let Some(start) = match_window(lines, &window, pass, from_index) {
            return Some((start, start + window.len(), replacement));
        }
    }

    None
}

/// Find the first index `>= from` where `window` matches `lines` under the given
/// fuzzy pass (0 = exact, 1 = trim_end, 2 = trim).
fn match_window(lines: &[String], window: &[&String], pass: u8, from: usize) -> Option<usize> {
    if window.len() > lines.len() {
        return None;
    }
    let last_start = lines.len() - window.len();
    (from..=last_start).find(|&i| {
        window
            .iter()
            .enumerate()
            .all(|(k, w)| lines_eq(&lines[i + k], w, pass))
    })
}

/// Compare two lines under one fuzzy pass. See [`compute_changes`] for why three
/// increasingly-lenient passes exist.
fn lines_eq(a: &str, b: &str, pass: u8) -> bool {
    match pass {
        0 => a == b,
        1 => a.trim_end() == b.trim_end(),
        _ => a.trim() == b.trim(),
    }
}

/// Best-effort index of the file line an `@@ <hint>` refers to. Returns `None` if
/// the hint isn't found, in which case matching proceeds unrestricted (the anchor
/// is SOFT).
///
/// An exact (trimmed) match ANYWHERE outranks a `contains` match, even an earlier
/// one: a hint like `foo` must anchor to the actual `foo` section header, not to an
/// unrelated `foobar_unrelated` line that merely contains it as a substring. So we
/// scan for an exact-trim line first across the whole file, and only fall back to a
/// substring line if no exact-trim line exists at all.
fn hint_anchor_index(lines: &[String], hint: &str) -> Option<usize> {
    let needle = hint.trim();
    if needle.is_empty() {
        return None;
    }
    lines
        .iter()
        .position(|l| l.trim() == needle)
        .or_else(|| lines.iter().position(|l| l.contains(needle)))
}

// ============================================================================
// Gateway bridge (Task C): apply a patch under a project root.
// ============================================================================

/// Apply a patch under `root`, jailing every touched path. Returns the changed paths on
/// success. Confinement is via the injected `jail`+`fs` closures so it is unit-testable
/// without touching the real filesystem or the gateway. Atomic at compute time (pure
/// applier); best-effort at write time (documented).
///
/// SECURITY: every path a patch touches — an Add/Update/Delete target AND a Move
/// destination — is routed through `resolve` (the `jail_in_root` wrapper). A path that
/// fails `resolve` (outside the project, `..`/absolute/symlink escape) aborts the whole
/// operation BEFORE any write, so nothing partial escapes. `resolve` is applied twice
/// per path: once while building the `read` view for `compute_changes` (so the pure
/// applier never sees an out-of-jail file), and again just before each `write`/`remove`.
///
/// Atomicity: `compute_changes` is all-or-nothing (it returns every change or the first
/// error), so a patch that cannot apply cleanly writes NOTHING. The subsequent write
/// phase is best-effort: if the Nth file write fails after N-1 succeeded, earlier writes
/// are not rolled back (the same guarantee `write_file` gives today). This is acceptable
/// because compute-time validation catches the overwhelmingly common failure modes
/// (missing file, bad context, jail violation) before any byte is written.
pub fn apply_patch_under_root(
    input: &str,
    resolve: &dyn Fn(&str) -> Result<std::path::PathBuf, String>,
    read: &dyn Fn(&std::path::Path) -> Option<String>,
    write: &mut dyn FnMut(&std::path::Path, &str) -> Result<(), String>,
    remove: &mut dyn FnMut(&std::path::Path) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    let patch = parse_patch(input).map_err(format_parse_error)?;

    // Fail fast on any jail violation among the paths the patch references, BEFORE
    // computing or writing anything. `resolve` is the security boundary; a single
    // violation aborts. We keep the resolved paths so `read`/`write`/`remove` reuse the
    // exact same jailed target the check validated.
    let mut resolved: std::collections::HashMap<String, std::path::PathBuf> =
        std::collections::HashMap::new();
    for op in &patch.ops {
        match op {
            FileOp::Add { path, .. } | FileOp::Delete { path } => {
                resolve_into(&mut resolved, resolve, path)?;
            }
            FileOp::Update { path, move_to, .. } => {
                resolve_into(&mut resolved, resolve, path)?;
                if let Some(to) = move_to {
                    resolve_into(&mut resolved, resolve, to)?;
                }
            }
        }
    }

    // Build the `read` view for the pure applier over the jailed paths only. A patch
    // path that isn't in `resolved` cannot occur (every op path was resolved above).
    let read_by_rel = |rel: &str| -> Option<String> {
        let abs = resolved.get(rel)?;
        read(abs)
    };
    let changes = compute_changes(&patch, &read_by_rel).map_err(format_apply_error)?;

    // Write phase: every path resolved again through the same jailed map.
    let mut changed = Vec::with_capacity(changes.len());
    for change in changes {
        match change {
            FileChange::Write { path, contents } => {
                let abs = jailed(&resolved, &path)?;
                write(&abs, &contents)?;
                changed.push(path);
            }
            FileChange::Delete { path } => {
                let abs = jailed(&resolved, &path)?;
                remove(&abs)?;
                changed.push(path);
            }
            FileChange::Rename {
                from,
                to,
                contents,
            } => {
                // Both endpoints are jailed: write the destination, then drop the source.
                let to_abs = jailed(&resolved, &to)?;
                let from_abs = jailed(&resolved, &from)?;
                write(&to_abs, &contents)?;
                remove(&from_abs)?;
                changed.push(to);
            }
        }
    }

    Ok(changed)
}

/// Resolve `rel` once through the jail and remember it, so later phases reuse the exact
/// validated path. A jail failure propagates as `Err` (aborting the whole apply).
fn resolve_into(
    map: &mut std::collections::HashMap<String, std::path::PathBuf>,
    resolve: &dyn Fn(&str) -> Result<std::path::PathBuf, String>,
    rel: &str,
) -> Result<(), String> {
    if !map.contains_key(rel) {
        let abs = resolve(rel)?;
        map.insert(rel.to_string(), abs);
    }
    Ok(())
}

/// Look up the pre-resolved jailed path for `rel`. Every path reaching the write phase
/// was resolved up-front, so a miss is an internal invariant break, surfaced as an error
/// rather than a panic.
fn jailed(
    map: &std::collections::HashMap<String, std::path::PathBuf>,
    rel: &str,
) -> Result<std::path::PathBuf, String> {
    map.get(rel)
        .cloned()
        .ok_or_else(|| format!("internal: path '{rel}' was not jailed before write"))
}

/// Render a [`ParseError`] as a concise, model-facing message.
fn format_parse_error(e: ParseError) -> String {
    match e {
        ParseError::NoBegin => "patch must start with '*** Begin Patch'".to_string(),
        ParseError::NoEnd => "patch is missing '*** End Patch'".to_string(),
        ParseError::BadHeader(l) => format!("unrecognized patch header: {l}"),
        ParseError::EmptyHunk => "a hunk (@@) had no body lines".to_string(),
        ParseError::UnexpectedLine(l) => format!("unexpected line in patch: {l}"),
        ParseError::AddLineMissingPlus(l) => {
            format!("'Add File' body lines must start with '+': {l}")
        }
    }
}

/// Render an [`ApplyError`] as a concise, model-facing message.
fn format_apply_error(e: ApplyError) -> String {
    match e {
        ApplyError::AddExists(p) => format!("cannot add '{p}': it already exists"),
        ApplyError::Missing(p) => format!("cannot update/delete '{p}': it does not exist"),
        ApplyError::ContextNotFound { path, hint } => match hint {
            Some(h) => format!("could not locate the patch context in '{path}' (near '{h}')"),
            None => format!("could not locate the patch context in '{path}'"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_add_update_move_delete() {
        let patch = "*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n\
*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print(\"Hi\")\n+print(\"Hello, world!\")\n\
*** Delete File: obsolete.txt\n*** End Patch\n";
        let p = parse_patch(patch).unwrap();
        assert_eq!(p.ops.len(), 3);
        assert_eq!(
            p.ops[0],
            FileOp::Add {
                path: "hello.txt".into(),
                contents: "Hello world\n".into()
            }
        );
        match &p.ops[1] {
            FileOp::Update {
                path,
                move_to,
                hunks,
            } => {
                assert_eq!(path, "src/app.py");
                assert_eq!(move_to.as_deref(), Some("src/main.py"));
                assert_eq!(hunks.len(), 1);
                assert_eq!(hunks[0].context_hint.as_deref(), Some("def greet():"));
                assert_eq!(
                    hunks[0].lines,
                    vec![
                        PatchLine::Removed("print(\"Hi\")".into()),
                        PatchLine::Added("print(\"Hello, world!\")".into()),
                    ]
                );
            }
            _ => panic!("expected Update"),
        }
        assert_eq!(
            p.ops[2],
            FileOp::Delete {
                path: "obsolete.txt".into()
            }
        );
    }

    #[test]
    fn rejects_missing_envelope() {
        assert_eq!(
            parse_patch("*** Update File: x\n").unwrap_err(),
            ParseError::NoBegin
        );
        assert_eq!(
            parse_patch("*** Begin Patch\n*** Update File: x\n@@\n pass\n").unwrap_err(),
            ParseError::NoEnd
        );
    }

    #[test]
    fn add_file_body_lines_must_start_with_plus() {
        let bad = "*** Begin Patch\n*** Add File: a.txt\nnot-plus\n*** End Patch\n";
        assert!(matches!(
            parse_patch(bad).unwrap_err(),
            ParseError::AddLineMissingPlus(_)
        ));
    }

    #[test]
    fn parses_multi_hunk_update_without_move() {
        let patch = "*** Begin Patch\n*** Update File: a.py\n@@ first\n-a\n+A\n@@ second\n-b\n+B\n*** End Patch\n";
        let p = parse_patch(patch).unwrap();
        match &p.ops[0] {
            FileOp::Update {
                move_to, hunks, ..
            } => {
                assert!(move_to.is_none());
                assert_eq!(hunks.len(), 2);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn context_and_prefixes_parsed() {
        let patch =
            "*** Begin Patch\n*** Update File: a.py\n@@\n unchanged\n-old\n+new\n*** End Patch\n";
        let p = parse_patch(patch).unwrap();
        if let FileOp::Update { hunks, .. } = &p.ops[0] {
            assert_eq!(
                hunks[0].lines,
                vec![
                    PatchLine::Context("unchanged".into()),
                    PatchLine::Removed("old".into()),
                    PatchLine::Added("new".into()),
                ]
            );
        } else {
            panic!()
        }
    }

    // --- Step 3 additions ---

    #[test]
    fn add_empty_file_single_empty_plus_line() {
        // A single bare `+` (empty added line) must yield contents "\n".
        let patch = "*** Begin Patch\n*** Add File: empty.txt\n+\n*** End Patch\n";
        let p = parse_patch(patch).unwrap();
        assert_eq!(
            p.ops[0],
            FileOp::Add {
                path: "empty.txt".into(),
                contents: "\n".into()
            }
        );
    }

    #[test]
    fn hunk_ends_with_end_of_file_sentinel() {
        let patch =
            "*** Begin Patch\n*** Update File: a.py\n@@\n context\n+added\n*** End of File\n*** End Patch\n";
        let p = parse_patch(patch).unwrap();
        if let FileOp::Update { hunks, .. } = &p.ops[0] {
            assert_eq!(hunks.len(), 1);
            assert!(hunks[0].eof);
            assert_eq!(
                hunks[0].lines,
                vec![
                    PatchLine::Context("context".into()),
                    PatchLine::Added("added".into()),
                ]
            );
        } else {
            panic!()
        }
    }

    #[test]
    fn bare_at_at_has_no_hint() {
        let patch = "*** Begin Patch\n*** Update File: a.py\n@@\n-x\n+y\n*** End Patch\n";
        let p = parse_patch(patch).unwrap();
        if let FileOp::Update { hunks, .. } = &p.ops[0] {
            assert_eq!(hunks[0].context_hint, None);
        } else {
            panic!()
        }
    }

    #[test]
    fn empty_hunk_is_rejected() {
        // A hunk header immediately followed by End Patch has zero body lines.
        let patch = "*** Begin Patch\n*** Update File: a.py\n@@\n*** End Patch\n";
        assert_eq!(parse_patch(patch).unwrap_err(), ParseError::EmptyHunk);
    }

    #[test]
    fn unrecognised_header_is_bad_header() {
        let patch = "*** Begin Patch\n*** Frobnicate File: a.py\n*** End Patch\n";
        assert!(matches!(
            parse_patch(patch).unwrap_err(),
            ParseError::BadHeader(_)
        ));
    }

    #[test]
    fn environment_id_line_is_ignored() {
        let patch =
            "*** Begin Patch\n*** Environment ID: abc-123\n*** Delete File: x\n*** End Patch\n";
        let p = parse_patch(patch).unwrap();
        assert_eq!(p.ops.len(), 1);
        assert_eq!(p.ops[0], FileOp::Delete { path: "x".into() });
    }

    #[test]
    fn bad_body_line_is_unexpected_line() {
        // A line inside a hunk with no valid prefix must error.
        let patch = "*** Begin Patch\n*** Update File: a.py\n@@\nnoprefix\n*** End Patch\n";
        assert!(matches!(
            parse_patch(patch).unwrap_err(),
            ParseError::UnexpectedLine(_)
        ));
    }

    #[test]
    fn trailing_newline_optional() {
        // Same patch without the final LF must parse identically.
        let patch = "*** Begin Patch\n*** Delete File: x\n*** End Patch";
        let p = parse_patch(patch).unwrap();
        assert_eq!(p.ops[0], FileOp::Delete { path: "x".into() });
    }

    // --- Task B: applier (compute_changes) tests ---

    #[test]
    fn update_applies_hunk_by_context_not_line_number() {
        let patch = parse_patch("*** Begin Patch\n*** Update File: a.py\n@@\n def f():\n-    return 1\n+    return 2\n*** End Patch\n").unwrap();
        let files = |p: &str| (p == "a.py").then(|| "def f():\n    return 1\n".to_string());
        let changes = compute_changes(&patch, &files).unwrap();
        assert_eq!(
            changes,
            vec![FileChange::Write {
                path: "a.py".into(),
                contents: "def f():\n    return 2\n".into()
            }]
        );
    }

    #[test]
    fn add_over_existing_is_rejected() {
        let patch =
            parse_patch("*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n").unwrap();
        let files = |p: &str| (p == "a.txt").then(|| "already".to_string());
        assert_eq!(
            compute_changes(&patch, &files).unwrap_err(),
            ApplyError::AddExists("a.txt".into())
        );
    }

    #[test]
    fn add_new_file_writes_contents() {
        let patch = parse_patch(
            "*** Begin Patch\n*** Add File: n.txt\n+line1\n+line2\n*** End Patch\n",
        )
        .unwrap();
        let changes = compute_changes(&patch, &(|_: &str| None)).unwrap();
        assert_eq!(
            changes,
            vec![FileChange::Write {
                path: "n.txt".into(),
                contents: "line1\nline2\n".into()
            }]
        );
    }

    #[test]
    fn update_missing_file_is_rejected() {
        let patch = parse_patch(
            "*** Begin Patch\n*** Update File: nope.txt\n@@\n-a\n+b\n*** End Patch\n",
        )
        .unwrap();
        assert_eq!(
            compute_changes(&patch, &(|_: &str| None)).unwrap_err(),
            ApplyError::Missing("nope.txt".into())
        );
    }

    #[test]
    fn delete_missing_file_is_rejected() {
        let patch = parse_patch(
            "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch\n",
        )
        .unwrap();
        assert_eq!(
            compute_changes(&patch, &(|_: &str| None)).unwrap_err(),
            ApplyError::Missing("gone.txt".into())
        );
    }

    #[test]
    fn context_fuzzy_matches_trailing_whitespace() {
        let patch = parse_patch(
            "*** Begin Patch\n*** Update File: a.txt\n@@\n-hello\n+world\n*** End Patch\n",
        )
        .unwrap();
        let files = |p: &str| (p == "a.txt").then(|| "hello   \n".to_string()); // file has trailing spaces
        assert_eq!(
            compute_changes(&patch, &files).unwrap(),
            vec![FileChange::Write {
                path: "a.txt".into(),
                contents: "world\n".into()
            }]
        );
    }

    #[test]
    fn move_to_produces_rename() {
        let patch = parse_patch("*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-a\n+A\n*** End Patch\n").unwrap();
        let files = |p: &str| (p == "a.txt").then(|| "a\n".to_string());
        assert_eq!(
            compute_changes(&patch, &files).unwrap(),
            vec![FileChange::Rename {
                from: "a.txt".into(),
                to: "b.txt".into(),
                contents: "A\n".into()
            }]
        );
    }

    #[test]
    fn context_not_found_is_rejected() {
        let patch = parse_patch(
            "*** Begin Patch\n*** Update File: a.txt\n@@\n-does not exist\n+x\n*** End Patch\n",
        )
        .unwrap();
        let files = |p: &str| (p == "a.txt").then(|| "totally different\n".to_string());
        assert!(matches!(
            compute_changes(&patch, &files).unwrap_err(),
            ApplyError::ContextNotFound { .. }
        ));
    }

    #[test]
    fn repeated_snippet_disambiguated_by_hint() {
        // "x" appears under two functions; the @@ hint selects which.
        let file = "def a():\n    x\ndef b():\n    x\n";
        let patch = parse_patch("*** Begin Patch\n*** Update File: f.py\n@@ def b():\n-    x\n+    y\n*** End Patch\n").unwrap();
        let files = |p: &str| (p == "f.py").then(|| file.to_string());
        let changes = compute_changes(&patch, &files).unwrap();
        assert_eq!(
            changes,
            vec![FileChange::Write {
                path: "f.py".into(),
                contents: "def a():\n    x\ndef b():\n    y\n".into()
            }]
        );
    }

    // --- Step 3 additions ---

    #[test]
    fn two_hunks_in_one_file_both_applied_in_order() {
        let file = "one\ntwo\nthree\nfour\n";
        let patch = parse_patch(
            "*** Begin Patch\n*** Update File: m.txt\n@@\n-one\n+ONE\n@@\n-four\n+FOUR\n*** End Patch\n",
        )
        .unwrap();
        let files = |p: &str| (p == "m.txt").then(|| file.to_string());
        assert_eq!(
            compute_changes(&patch, &files).unwrap(),
            vec![FileChange::Write {
                path: "m.txt".into(),
                contents: "ONE\ntwo\nthree\nFOUR\n".into()
            }]
        );
    }

    #[test]
    fn update_only_adds_lines() {
        // Context anchors, no Removed lines, one Added line inserted after context.
        let file = "alpha\nbeta\n";
        let patch = parse_patch(
            "*** Begin Patch\n*** Update File: a.txt\n@@\n alpha\n+inserted\n*** End Patch\n",
        )
        .unwrap();
        let files = |p: &str| (p == "a.txt").then(|| file.to_string());
        assert_eq!(
            compute_changes(&patch, &files).unwrap(),
            vec![FileChange::Write {
                path: "a.txt".into(),
                contents: "alpha\ninserted\nbeta\n".into()
            }]
        );
    }

    #[test]
    fn update_only_removes_lines() {
        let file = "keep\ndrop\nkeep2\n";
        let patch = parse_patch(
            "*** Begin Patch\n*** Update File: a.txt\n@@\n-drop\n*** End Patch\n",
        )
        .unwrap();
        let files = |p: &str| (p == "a.txt").then(|| file.to_string());
        assert_eq!(
            compute_changes(&patch, &files).unwrap(),
            vec![FileChange::Write {
                path: "a.txt".into(),
                contents: "keep\nkeep2\n".into()
            }]
        );
    }

    #[test]
    fn update_preserves_absent_trailing_newline() {
        // File has no trailing newline; result must not gain one.
        let file = "a\nb"; // no trailing \n
        let patch = parse_patch(
            "*** Begin Patch\n*** Update File: a.txt\n@@\n-b\n+B\n*** End Patch\n",
        )
        .unwrap();
        let files = |p: &str| (p == "a.txt").then(|| file.to_string());
        assert_eq!(
            compute_changes(&patch, &files).unwrap(),
            vec![FileChange::Write {
                path: "a.txt".into(),
                contents: "a\nB".into()
            }]
        );
    }

    // --- Task B code-review regression tests ---

    #[test]
    fn multi_hunk_no_backward_reanchor_to_earlier_duplicate() {
        // Fix 1 regression. The file has a duplicated line `dup` at index 0 and 2.
        // Hunk 1 edits `mid` (index 1), advancing the cursor past it. Hunk 2 targets
        // the SECOND `dup` (index 2, i.e. at/after the cursor).
        //
        // Before Fix 1 the applier searched unrestricted and only `.filter`ed the
        // result, with an `.or_else` that re-ran the unrestricted search on failure:
        // hunk 2's first `dup` match was index 0 (< cursor), the filter rejected it,
        // and the `.or_else` handed back that SAME index-0 match — so the edit landed
        // on the FIRST `dup` (backward re-anchor). Threading `from_index` into the
        // search makes hunk 2 find the `dup` at index 2 instead.
        let file = "dup\nmid\ndup\ntail\n";
        let patch = parse_patch(
            "*** Begin Patch\n*** Update File: f.txt\n@@\n-mid\n+MID\n@@\n-dup\n+CHANGED\n*** End Patch\n",
        )
        .unwrap();
        let files = |p: &str| (p == "f.txt").then(|| file.to_string());
        assert_eq!(
            compute_changes(&patch, &files).unwrap(),
            vec![FileChange::Write {
                path: "f.txt".into(),
                // The SECOND dup is edited, the first is untouched.
                contents: "dup\nMID\nCHANGED\ntail\n".into()
            }]
        );
    }

    #[test]
    fn hint_exact_trim_outranks_earlier_substring_line() {
        // The hint `foo` appears as a SUBSTRING of an unrelated earlier line
        // (`foobar_unrelated`) and as an EXACT-trim match later (`def foo():`... the
        // section header contains `foo`, but the real anchor is the exact `foo`? —
        // here we use a header line that trims exactly to the hint). Before Fix 2 the
        // `contains` branch anchored to `foobar_unrelated` and edited the wrong `x`.
        let file = "foobar_unrelated\n    x = 1\nfoo\n    x = 1\n";
        let patch = parse_patch(
            "*** Begin Patch\n*** Update File: f.py\n@@ foo\n-    x = 1\n+    x = 2\n*** End Patch\n",
        )
        .unwrap();
        let files = |p: &str| (p == "f.py").then(|| file.to_string());
        assert_eq!(
            compute_changes(&patch, &files).unwrap(),
            vec![FileChange::Write {
                path: "f.py".into(),
                // The x under the exact-trim `foo` line is edited, not the one under
                // `foobar_unrelated`.
                contents: "foobar_unrelated\n    x = 1\nfoo\n    x = 2\n".into()
            }]
        );
    }

    #[test]
    fn ambiguous_no_hint_first_exact_match_wins() {
        // With no hint and a window matching at multiple identical positions, the
        // FIRST exact match wins. This is Codex-faithful: without a hint the format
        // cannot express which occurrence is meant, so models are expected to supply
        // enough surrounding context (or a hint) to disambiguate. We lock this in so
        // the first-match behavior is intentional, not accidental.
        let file = "dup\ndup\n";
        let patch = parse_patch(
            "*** Begin Patch\n*** Update File: f.txt\n@@\n-dup\n+CHANGED\n*** End Patch\n",
        )
        .unwrap();
        let files = |p: &str| (p == "f.txt").then(|| file.to_string());
        assert_eq!(
            compute_changes(&patch, &files).unwrap(),
            vec![FileChange::Write {
                path: "f.txt".into(),
                contents: "CHANGED\ndup\n".into()
            }]
        );
    }

    #[test]
    fn out_of_order_hunks_are_rejected() {
        // The first hunk anchors on `second` (index 1); the next hunk's context
        // `first` occurs only BEFORE that applied region. With ordered-or-error (Fix
        // 1) the second hunk cannot be placed at/after `from_index`, so we fail loudly
        // instead of silently re-anchoring backwards.
        let file = "first\nsecond\n";
        let patch = parse_patch(
            "*** Begin Patch\n*** Update File: f.txt\n@@\n-second\n+SECOND\n@@\n-first\n+FIRST\n*** End Patch\n",
        )
        .unwrap();
        let files = |p: &str| (p == "f.txt").then(|| file.to_string());
        assert!(matches!(
            compute_changes(&patch, &files).unwrap_err(),
            ApplyError::ContextNotFound { .. }
        ));
    }

    // --- Task C: apply_patch_under_root (gateway bridge) tests ---
    //
    // These use an in-memory HashMap as the fake filesystem. `resolve` here mimics
    // jail_in_root: it rejects any path containing `..` (a stand-in for the real jail's
    // escape rules) and otherwise maps a relative path to a synthetic absolute PathBuf
    // under "/root".

    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    fn fake_resolve(rel: &str) -> Result<PathBuf, String> {
        if rel.split('/').any(|c| c == "..") {
            return Err(format!("'..' not allowed (outside the project): {rel}"));
        }
        Ok(Path::new("/root").join(rel))
    }

    /// Turn an absolute fake path back into its project-relative key ("/root/a.py" → "a.py").
    fn rel_of(abs: &Path) -> String {
        abs.strip_prefix("/root")
            .unwrap_or(abs)
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn apply_under_root_add_update_delete_success() {
        let mut fs: HashMap<String, String> = HashMap::new();
        fs.insert("upd.py".to_string(), "def f():\n    return 1\n".to_string());
        fs.insert("gone.txt".to_string(), "bye\n".to_string());

        let input = "*** Begin Patch\n\
*** Add File: new.txt\n+hello\n\
*** Update File: upd.py\n@@\n def f():\n-    return 1\n+    return 2\n\
*** Delete File: gone.txt\n\
*** End Patch\n";

        // read/write/remove close over `fs` via a RefCell so the &mut closures compose.
        let cell = std::cell::RefCell::new(fs);
        let read = |p: &Path| cell.borrow().get(&rel_of(p)).cloned();
        let mut write =
            |p: &Path, c: &str| -> Result<(), String> {
                cell.borrow_mut().insert(rel_of(p), c.to_string());
                Ok(())
            };
        let mut remove = |p: &Path| -> Result<(), String> {
            cell.borrow_mut().remove(&rel_of(p));
            Ok(())
        };

        let mut changed =
            apply_patch_under_root(input, &fake_resolve, &read, &mut write, &mut remove).unwrap();
        changed.sort();
        // All three touched paths are reported, including the deletion.
        assert_eq!(changed, vec!["gone.txt", "new.txt", "upd.py"]);

        let fs = cell.into_inner();
        assert_eq!(fs.get("new.txt").map(String::as_str), Some("hello\n"));
        assert_eq!(
            fs.get("upd.py").map(String::as_str),
            Some("def f():\n    return 2\n")
        );
        assert!(!fs.contains_key("gone.txt"), "deleted file must be gone");
    }

    #[test]
    fn apply_under_root_jail_violation_writes_nothing() {
        // A path escaping the project (`../escape`) must abort with a jail error and
        // leave the fake fs untouched — nothing written.
        let fs: HashMap<String, String> = HashMap::new();
        let cell = std::cell::RefCell::new(fs);
        let read = |p: &Path| cell.borrow().get(&rel_of(p)).cloned();
        let mut wrote = false;
        let mut write = |_p: &Path, _c: &str| -> Result<(), String> {
            wrote = true;
            Ok(())
        };
        let mut removed = false;
        let mut remove = |_p: &Path| -> Result<(), String> {
            removed = true;
            Ok(())
        };

        let input = "*** Begin Patch\n*** Add File: ../escape.txt\n+pwn\n*** End Patch\n";
        let err =
            apply_patch_under_root(input, &fake_resolve, &read, &mut write, &mut remove).unwrap_err();
        assert!(err.contains("not allowed"), "expected jail error, got: {err}");
        assert!(!wrote, "no write must happen on a jail violation");
        assert!(!removed, "no remove must happen on a jail violation");
        assert!(cell.borrow().is_empty(), "fs must be untouched");
    }

    #[test]
    fn apply_under_root_move_dest_is_jailed() {
        // The Move DESTINATION must go through the jail too: an escaping `Move to:`
        // aborts before any write.
        let mut fs: HashMap<String, String> = HashMap::new();
        fs.insert("a.txt".to_string(), "a\n".to_string());
        let cell = std::cell::RefCell::new(fs);
        let read = |p: &Path| cell.borrow().get(&rel_of(p)).cloned();
        let mut wrote = false;
        let mut write = |_p: &Path, _c: &str| -> Result<(), String> {
            wrote = true;
            Ok(())
        };
        let mut remove = |_p: &Path| -> Result<(), String> { Ok(()) };

        let input = "*** Begin Patch\n*** Update File: a.txt\n*** Move to: ../out.txt\n@@\n-a\n+A\n*** End Patch\n";
        let err =
            apply_patch_under_root(input, &fake_resolve, &read, &mut write, &mut remove).unwrap_err();
        assert!(
            err.contains("not allowed"),
            "move destination must be jailed, got: {err}"
        );
        assert!(!wrote, "no write must happen when the move dest escapes");
    }

    #[test]
    fn apply_under_root_context_not_found_writes_nothing() {
        // A well-formed patch whose context can't be located → error, nothing written.
        let mut fs: HashMap<String, String> = HashMap::new();
        fs.insert("a.txt".to_string(), "totally different\n".to_string());
        let cell = std::cell::RefCell::new(fs);
        let read = |p: &Path| cell.borrow().get(&rel_of(p)).cloned();
        let mut wrote = false;
        let mut write = |_p: &Path, _c: &str| -> Result<(), String> {
            wrote = true;
            Ok(())
        };
        let mut remove = |_p: &Path| -> Result<(), String> { Ok(()) };

        let input =
            "*** Begin Patch\n*** Update File: a.txt\n@@\n-does not exist\n+x\n*** End Patch\n";
        let err =
            apply_patch_under_root(input, &fake_resolve, &read, &mut write, &mut remove).unwrap_err();
        assert!(
            err.contains("could not locate"),
            "expected context error, got: {err}"
        );
        assert!(!wrote, "no write on a context-not-found failure");
        assert_eq!(
            cell.borrow().get("a.txt").map(String::as_str),
            Some("totally different\n"),
            "target file must be unchanged"
        );
    }

    #[test]
    fn apply_under_root_rename_writes_dest_removes_source() {
        let mut fs: HashMap<String, String> = HashMap::new();
        fs.insert("a.txt".to_string(), "a\n".to_string());
        let cell = std::cell::RefCell::new(fs);
        let read = |p: &Path| cell.borrow().get(&rel_of(p)).cloned();
        let mut write = |p: &Path, c: &str| -> Result<(), String> {
            cell.borrow_mut().insert(rel_of(p), c.to_string());
            Ok(())
        };
        let mut remove = |p: &Path| -> Result<(), String> {
            cell.borrow_mut().remove(&rel_of(p));
            Ok(())
        };

        let input = "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-a\n+A\n*** End Patch\n";
        let changed =
            apply_patch_under_root(input, &fake_resolve, &read, &mut write, &mut remove).unwrap();
        assert_eq!(changed, vec!["b.txt"]);
        let fs = cell.into_inner();
        assert!(!fs.contains_key("a.txt"), "source must be removed");
        assert_eq!(fs.get("b.txt").map(String::as_str), Some("A\n"));
    }
}
