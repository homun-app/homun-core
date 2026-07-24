/**
 * Split markdown into top-level blocks so a streaming message can re-render ONLY
 * its growing tail. The full unified pipeline used to run over the whole
 * accumulated text on every rAF flush — O(len) per frame, O(len²) per message.
 *
 * THE INVARIANT: a block must parse the same ALONE as it does inside the whole
 * document, because each block becomes its own independent remark/rehype run.
 * Blank lines are the candidate cut points, but several markdown structures span
 * them. Note the asymmetry that drives every rule below: *not* splitting is
 * always safe (a block is a verbatim contiguous slice, so merging two of them
 * reproduces the source exactly and costs only performance), while splitting
 * where a structure continues silently changes the rendering. When in doubt,
 * keep the lines together.
 */

// A fence opener/closer. CommonMark allows up to 3 leading spaces, ``` or ~~~,
// and a closer must use the same character and be at least as long — a naive
// "toggle on any ```" breaks on a ```` fence that legitimately contains ```.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// Bullet or ordered marker at top level (a blank line between two of these makes
// the list "loose": every item gains a <p>, which a split would silently undo).
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

// A list marker with nothing after it yet: mid-stream this is half a line, and
// remark parses it differently alone than in context (an empty <li> vs a literal
// paragraph). Never cut in front of one — a frame later it becomes a real item.
const BARE_LIST_MARKER_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]*$/;

const BLOCKQUOTE_RE = /^ {0,3}>/;

const TABLE_ROW_RE = /^ {0,3}\|/;

// Link reference definitions and GFM footnote definitions ([foo]: url, [^1]: …).
// These resolve across the WHOLE document: the reference and its definition are
// normally separated by a blank line, so splitting would put them in two
// independent remark runs and the reference would render as literal text.
const DEFINITION_RE = /^ {0,3}\[[^\]]*\]:/;

function fenceAt(line) {
  const match = FENCE_RE.exec(line);
  if (!match) return null;
  return { char: match[1][0], length: match[1].length, rest: match[2] };
}

/**
 * Decide whether the blank line at `blankIndex` is a real top-level boundary or
 * just interior whitespace of a structure that keeps going.
 */
function structureContinues(lines, blankIndex, lastNonBlank, hasListItem) {
  if (lastNonBlank === null) return false;

  let next = null;
  for (let i = blankIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== "") {
      next = lines[i];
      break;
    }
  }
  // Nothing but blank lines follows: this is the end of the stream so far, not a
  // boundary. Let the blanks accumulate into the tail block, where the final push
  // decides whether they are code (keep) or padding (trim) — closing here instead
  // would trim blank lines that the next chunk may reveal as code.
  if (next === null) return true;

  // Indentation after a blank line is load-bearing: it marks either a list-item
  // continuation paragraph or an indented (4-space) code block. A split would
  // hand remark a block whose first line is indented with no container above it.
  if (/^[ \t]/.test(next)) return true;

  // Half-typed list marker: wait for the rest of the line.
  if (BARE_LIST_MARKER_RE.test(next)) return true;

  // Loose list: "- a\n\n- b" is ONE list with <p> items; split it and each half
  // becomes its own tight <ul> (and an ordered list restarts its numbering).
  if (hasListItem && LIST_ITEM_RE.test(next)) return true;

  // Consecutive blockquotes / table rows across a blank line. Defensive: keeping
  // them together can only reproduce the source document.
  if (BLOCKQUOTE_RE.test(lastNonBlank) && BLOCKQUOTE_RE.test(next)) return true;
  if (TABLE_ROW_RE.test(lastNonBlank) && TABLE_ROW_RE.test(next)) return true;

  return false;
}

/**
 * Drop the blank lines at both ends of a block but KEEP each line's indentation:
 * a plain `.trim()` would de-indent a 4-space code block into a paragraph.
 *
 * `keepTrailingBlanks` guards the tail block mid-stream: when the stream stops
 * inside a code block its trailing blank lines are code, not padding, and
 * dropping them makes the growing <pre> lose a line for one frame and regain it
 * on the next — visible as a jitter. Closed blocks always trim, which is what
 * CommonMark does with blank lines that follow a finished code block.
 */
function trimBoundaryBlankLines(lines, keepTrailingBlanks) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  if (!keepTrailingBlanks) {
    while (end > start && lines[end - 1].trim() === "") end -= 1;
  }
  return lines.slice(start, end);
}

// True when the block's last real line is an indented (4-space / tab) code line,
// i.e. the stream may still be sitting inside an indented code block.
function endsInsideIndentedCode(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() === "") continue;
    return /^(?: {4}|\t)/.test(lines[i]);
  }
  return false;
}

function toBlocks(texts) {
  return texts.map((blockText, index) => ({
    key: `b${index}`,
    text: blockText,
    closed: index < texts.length - 1,
  }));
}

export function splitMarkdownBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let current = [];
  let openFence = null;
  let lastNonBlank = null;
  let hasListItem = false;
  let hasDefinition = false;

  // `isTail` is true only for the final push: only there can trailing blank
  // lines still turn out to be the interior of a code block that keeps growing.
  const push = (isTail = false) => {
    const keepTrailingBlanks =
      isTail && (openFence !== null || endsInsideIndentedCode(current));
    const kept = trimBoundaryBlankLines(current, keepTrailingBlanks);
    if (kept.length > 0) blocks.push(kept.join("\n"));
    current = [];
    lastNonBlank = null;
    hasListItem = false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = fenceAt(line);

    if (fence) {
      if (openFence === null) {
        // A backtick opener may not carry a backtick in its info string.
        if (!(fence.char === "`" && fence.rest.includes("`"))) {
          openFence = fence;
        }
      } else if (
        fence.char === openFence.char &&
        fence.length >= openFence.length &&
        fence.rest.trim() === ""
      ) {
        openFence = null;
      }
      current.push(line);
      lastNonBlank = line;
      continue;
    }

    if (openFence === null && line.trim() === "") {
      if (structureContinues(lines, i, lastNonBlank, hasListItem)) {
        // Interior blank line: keep it, it is what makes a list loose.
        current.push(line);
        continue;
      }
      push();
      continue;
    }

    if (openFence === null) {
      if (LIST_ITEM_RE.test(line)) hasListItem = true;
      if (DEFINITION_RE.test(line)) hasDefinition = true;
    }
    current.push(line);
    lastNonBlank = line;
  }

  push(true);

  // Fail-safe: a document that defines references cannot be split at all, since
  // resolution is document-wide. Correct, just no faster than before.
  if (hasDefinition) {
    const whole = trimBoundaryBlankLines(
      lines,
      openFence !== null || endsInsideIndentedCode(lines),
    ).join("\n");
    return toBlocks(whole.length > 0 ? [whole] : []);
  }

  return toBlocks(blocks);
}
