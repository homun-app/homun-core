import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

/** Every .ts/.tsx file under src/, so the invariant covers new call sites too. */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

test("no component opens the legacy NDJSON event stream", () => {
  // Two live transports meant two connections, two reconnect loops and a double
  // dispatch of every handler. The WebSocket is the canonical one.
  const chatView = readFileSync(join(src, "components", "ChatView.tsx"), "utf8");
  assert.doesNotMatch(chatView, /subscribeAppEvents\(/, "ChatView must use the WebSocket");
});

test("the legacy NDJSON transport has no callers left anywhere in src", () => {
  // Converge, don't duplicate: once the last caller is on the WS, the parallel
  // transport must be retired, not left dormant for the next contributor to wire back.
  // Only CODE references count — `subscribeAppEvents(` (call or definition) and
  // `subscribeAppEvents,` (import entry). Prose mentions in doc comments name what the
  // WS replaced and are deliberately kept; they always have a space before the paren.
  const offenders = sourceFiles(src).filter((file) =>
    /subscribeAppEvents[(,]/.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(
    offenders.map((f) => f.slice(src.length + 1)),
    [],
    "subscribeAppEvents must be gone: the WS is the single event transport",
  );
});

test("the project graph listens for its events on the WebSocket", () => {
  // The gateway fans project_graph.* out through publish_app_event, which writes to
  // BOTH the NDJSON channel and the WS registry as an `app.event` envelope. Reading
  // them off the WS therefore requires unwrapping msg.event — asserting the envelope
  // guards against a "fix" that subscribes but reads the raw message.
  const graphPanel = readFileSync(join(src, "components", "MemoryGraphPanel.tsx"), "utf8");
  const graphEffect = graphPanel.slice(
    Math.max(0, graphPanel.indexOf("project_graph.ready") - 4000),
    graphPanel.indexOf("project_graph.ready"),
  );
  assert.match(graphEffect, /wsSubscription\.subscribe\(/, "must subscribe on the WS");
  assert.match(graphEffect, /"app\.event"/, "must unwrap the app.event envelope");
});
