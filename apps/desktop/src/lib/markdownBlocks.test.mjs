import assert from "node:assert/strict";
import test from "node:test";
import { splitMarkdownBlocks } from "./markdownBlocks.mjs";

test("splits on blank lines and marks every block but the last as closed", () => {
  const blocks = splitMarkdownBlocks("First para.\n\nSecond para.\n\nThird");
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => b.closed), [true, true, false]);
  assert.equal(blocks[0].text, "First para.");
  assert.equal(blocks[2].text, "Third");
});

test("never splits inside a fenced code block", () => {
  const text = "Intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro";
  const blocks = splitMarkdownBlocks(text);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[1].text.includes("const a = 1;"));
  assert.ok(blocks[1].text.includes("const b = 2;"), "the blank line inside the fence is kept");
});

test("an unterminated fence keeps everything after it in one growing block", () => {
  // Mid-stream the fence is still open: splitting it would render broken markup
  // for a frame and then re-flow, which reads as flicker.
  const blocks = splitMarkdownBlocks("Intro\n\n```js\nconst a = 1;\n\nconst b = 2;");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].closed, false);
});

test("stable keys let already-closed blocks keep their identity as text grows", () => {
  const first = splitMarkdownBlocks("A\n\nB");
  const later = splitMarkdownBlocks("A\n\nB\n\nC");
  assert.equal(first[0].key, later[0].key);
  assert.equal(first[0].text, later[0].text);
});

// --- Structures that must survive the split -------------------------------
// Each block is rendered by its OWN remark run, so a block must parse the same
// alone as it does inside the whole document. The cases below all render
// differently once cut, and were verified against the real react-markdown
// pipeline (remark-gfm -> rehype-sanitize) before being pinned here.

test("a loose bullet list stays in one block", () => {
  // Split, each half becomes its own tight <ul>: the <p> wrappers that make the
  // list loose disappear and the spacing changes.
  const blocks = splitMarkdownBlocks("Intro\n\n- alpha\n\n- beta\n\nOutro");
  assert.equal(blocks.length, 3);
  assert.equal(blocks[1].text, "- alpha\n\n- beta");
});

test("a loose ordered list stays in one block", () => {
  // Split, the second half renders as <ol start="2">: two lists, not one.
  const blocks = splitMarkdownBlocks("1. one\n\n2. two\n\n3. three");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "1. one\n\n2. two\n\n3. three");
});

test("a list item continuation paragraph stays with its item", () => {
  // The indent is what keeps "more" inside the <li>; on its own it is a
  // top-level paragraph sitting after the list.
  const blocks = splitMarkdownBlocks("- alpha\n\n  more about alpha\n\n- beta");
  assert.equal(blocks.length, 1);
});

test("an indented code block keeps its indentation and its interior blank line", () => {
  // A block-wide .trim() would de-indent the first line and turn the code into
  // a paragraph; splitting on the interior blank line would split the <pre>.
  // Indented content after a blank line pulls the preceding lines along: merging
  // costs only performance, cutting would change the rendering.
  const blocks = splitMarkdownBlocks("Intro\n\n    line one\n\n    line two\n\nOutro");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "Intro\n\n    line one\n\n    line two");
  assert.equal(blocks[1].text, "Outro");
});

test("consecutive blockquotes and table rows are not cut apart", () => {
  const quote = splitMarkdownBlocks("> one\n\n> two\n\nAfter.");
  assert.equal(quote.length, 2);
  assert.equal(quote[0].text, "> one\n\n> two");

  const table = splitMarkdownBlocks("| h | i |\n| --- | --- |\n| 1 | 2 |\n\n| 3 | 4 |\n\nAfter.");
  assert.equal(table.length, 2);
  assert.ok(table[0].text.includes("| 3 | 4 |"));
});

test("a table followed by a blank line still splits from the paragraph after it", () => {
  // The perf win must survive: a finished table IS an independent block.
  const blocks = splitMarkdownBlocks("| h | i |\n| --- | --- |\n| 1 | 2 |\n\nAfter the table.");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].text, "After the table.");
});

test("reference and footnote definitions disable splitting entirely", () => {
  // [foo]: / [^1]: resolve document-wide: in separate remark runs the reference
  // renders as literal text and the definition is orphaned.
  const link = splitMarkdownBlocks("See [foo] here.\n\n[foo]: https://example.com");
  assert.equal(link.length, 1);

  const note = splitMarkdownBlocks("Text[^1].\n\n[^1]: The note.");
  assert.equal(note.length, 1);
});

test("a definition-looking line inside a fence does not disable splitting", () => {
  const blocks = splitMarkdownBlocks("Intro\n\n```\n[foo]: not a definition\n```\n\nOutro");
  assert.equal(blocks.length, 3);
});

test("tilde fences and longer fences are tracked like backtick fences", () => {
  const tilde = splitMarkdownBlocks("Intro\n\n~~~py\nx = 1\n\ny = 2\n~~~\n\nOutro");
  assert.equal(tilde.length, 3);
  assert.ok(tilde[1].text.includes("y = 2"));

  // The inner ``` must not be mistaken for the closer of the ```` fence.
  const nested = splitMarkdownBlocks("````md\n```js\nx\n```\n\nstill inside\n````\n\nOutro");
  assert.equal(nested.length, 2);
  assert.ok(nested[0].text.includes("still inside"));
});

test("a half-typed list marker at the stream tail is not cut off", () => {
  // Mid-stream "-" alone renders as an empty <li> that turns into a real item a
  // frame later; keeping it attached avoids that flicker.
  const blocks = splitMarkdownBlocks("    code\n\n-");
  assert.equal(blocks.length, 1);
});

test("trailing blank lines inside an open fence are preserved, elsewhere trimmed", () => {
  const inFence = splitMarkdownBlocks("```js\nconst a = 1;\n\n");
  assert.equal(inFence[0].text, "```js\nconst a = 1;\n\n");

  const plain = splitMarkdownBlocks("a\n\nb\n\n\n");
  assert.equal(plain.length, 2);
  assert.equal(plain[1].text, "b");
});

test("empty and blank-only text produce no blocks", () => {
  assert.deepEqual(splitMarkdownBlocks(""), []);
  assert.deepEqual(splitMarkdownBlocks("\n\n\n"), []);
});
