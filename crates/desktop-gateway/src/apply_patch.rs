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
}
