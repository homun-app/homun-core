import { test } from "node:test";
import assert from "node:assert/strict";
import { componentRenderer } from "./helpers/render-component.ts";

const searchPath = "apps/web/src/components/builder/ConversationSearch.tsx";

test("engine mode footer declares Fonte: motore, with no demo wording", async () => {
  const { render, close } = await componentRenderer(searchPath, "ConversationSearch");
  try {
    const html = render({ search: { entries: [] }, onClose: () => {}, backend: "engine" });
    assert.match(html, /Fonte: motore/);
    assert.doesNotMatch(html, /dati della demo/);
  } finally {
    await close();
  }
});

test("simulation mode footer declares Fonte: simulazione", async () => {
  const { render, close } = await componentRenderer(searchPath, "ConversationSearch");
  try {
    const html = render({ search: { entries: [] }, onClose: () => {}, backend: "simulation" });
    assert.match(html, /Fonte: simulazione/);
    assert.doesNotMatch(html, /dati della demo/);
  } finally {
    await close();
  }
});

test("engine mode footer warns when the materials source is unavailable, with HomunErrorNotice mapping", async () => {
  const { render, close, loadModule } = await componentRenderer(searchPath, "ConversationSearch");
  try {
    // Build the error inside the component's module graph: an instanceof from
    // this test file would be a different HomunClientError realm.
    const { HomunClientError } = await loadModule("apps/web/src/lib/homun-errors.ts");
    const html = render({
      backend: "engine",
      search: {
        entries: [],
        sources: {
          materials: {
            status: "unavailable",
            error: new HomunClientError(
              "engine_unavailable",
              "Engine unreachable at http://127.0.0.1:8000.",
            ),
          },
        },
      },
      onClose: () => {},
    });
    assert.match(html, /Materiali non disponibili:/);
    assert.match(html, /App locale non raggiungibile/);
    assert.match(html, /role="alert"/);
    assert.match(html, /data-error-code="engine_unavailable"/);
    assert.match(html, /Fonte: motore/);
  } finally {
    await close();
  }
});

test("no source warning when the engine answers", async () => {
  const { render, close } = await componentRenderer(searchPath, "ConversationSearch");
  try {
    const html = render({
      backend: "engine",
      search: { entries: [], sources: { materials: { status: "ok" } } },
      onClose: () => {},
    });
    assert.doesNotMatch(html, /Materiali non disponibili/);
    assert.match(html, /Fonte: motore/);
  } finally {
    await close();
  }
});

test("simulation never shows engine source warnings", async () => {
  const { render, close } = await componentRenderer(searchPath, "ConversationSearch");
  try {
    const html = render({
      backend: "simulation",
      search: { entries: [], sources: { materials: null } },
      onClose: () => {},
    });
    assert.doesNotMatch(html, /Materiali non disponibili/);
  } finally {
    await close();
  }
});
