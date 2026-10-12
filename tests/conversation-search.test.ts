import { test } from "node:test";
import assert from "node:assert/strict";
import { componentRenderer } from "./helpers/render-component.ts";

const searchPath = "apps/web/src/components/builder/ConversationSearch.tsx";

const entry = {
  id: "w1",
  title: "Preventivo Rossi",
  kind: "Lavori",
  context: "Homun · in corso",
  text: "controllo listini",
  open: () => {},
};

test("the search renders no footer: no counts, shortcuts or Fonte label", async () => {
  const { render, close } = await componentRenderer(searchPath, "ConversationSearch");
  try {
    const html = render({ search: { entries: [entry] }, onClose: () => {} });
    assert.doesNotMatch(html, /<footer/);
    assert.doesNotMatch(html, /Fonte:/);
    assert.doesNotMatch(html, /risultati ·/);
  } finally {
    await close();
  }
});

test("unavailable source with zero results explains it in the empty state, with the typed-error reason", async () => {
  const { render, close, loadModule } = await componentRenderer(searchPath, "ConversationSearch");
  try {
    // Build the error inside the component's module graph: an instanceof from
    // this test file would be a different HomunClientError realm.
    const { HomunClientError } = await loadModule("apps/web/src/lib/homun-errors.ts");
    const html = render({
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
    assert.match(html, /Nessun risultato\. I materiali non sono raggiungibili in questo momento\./);
    assert.match(html, /App locale non raggiungibile/);
    assert.match(html, /role="alert"/);
    assert.match(html, /data-error-code="engine_unavailable"/);
    assert.doesNotMatch(html, /Prova un nome o una parola/);
  } finally {
    await close();
  }
});

test("unavailable source with results shows one discreet line on top of the results", async () => {
  const { render, close, loadModule } = await componentRenderer(searchPath, "ConversationSearch");
  try {
    const { HomunClientError } = await loadModule("apps/web/src/lib/homun-errors.ts");
    const html = render({
      search: {
        entries: [entry],
        sources: {
          materials: {
            status: "unavailable",
            error: new HomunClientError("engine_unavailable", "Engine unreachable."),
          },
        },
      },
      onClose: () => {},
    });
    assert.match(html, /Alcuni materiali mancano:/);
    assert.match(html, /App locale non raggiungibile/);
    assert.match(html, /data-error-code="engine_unavailable"/);
    // IN CIMA: the warning precedes the first result button.
    assert.ok(
      html.indexOf("Alcuni materiali mancano:") < html.indexOf("Preventivo Rossi"),
      "the missing-materials line must come before the results",
    );
    // Not the empty state: results are there.
    assert.match(html, /Preventivo Rossi/);
    assert.doesNotMatch(html, /Nessun risultato/);
  } finally {
    await close();
  }
});

test("healthy sources show neither warning, and the plain empty state stays", async () => {
  const { render, close } = await componentRenderer(searchPath, "ConversationSearch");
  try {
    const empty = render({
      search: { entries: [], sources: { materials: { status: "ok" } } },
      onClose: () => {},
    });
    assert.doesNotMatch(empty, /I materiali non sono raggiungibili/);
    assert.doesNotMatch(empty, /Alcuni materiali mancano/);
    assert.match(empty, /Nessun risultato\. Prova un nome o una parola presente nel contenuto\./);
    const withResults = render({
      search: { entries: [entry], sources: { materials: { status: "ok" } } },
      onClose: () => {},
    });
    assert.doesNotMatch(withResults, /Alcuni materiali mancano/);
    assert.match(withResults, /Preventivo Rossi/);
  } finally {
    await close();
  }
});

test("simulation has no engine sources and never shows engine source warnings", async () => {
  const { render, close } = await componentRenderer(searchPath, "ConversationSearch");
  try {
    const html = render({
      search: { entries: [], sources: { materials: null } },
      onClose: () => {},
    });
    assert.doesNotMatch(html, /Materiali non disponibili/);
    assert.doesNotMatch(html, /Alcuni materiali mancano/);
    assert.doesNotMatch(html, /Fonte:/);
  } finally {
    await close();
  }
});
