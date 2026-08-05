import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatMarkdown,
  chatExportRoleLabel,
  stripChatExportMarkers,
} from "./chatExportMarkdown.mjs";

test("stripChatExportMarkers preserves artifact file names and removes control markers", () => {
  assert.equal(
    stripChatExportMarkers(
      [
        "Intro",
        "‹‹ARTIFACT››{\"name\":\"report.md\"}‹‹/ARTIFACT››",
        "‹‹ACT››hidden activity‹‹/ACT››",
        "Done",
      ].join("\n"),
    ),
    "Intro\n\n_[file: report.md]_\n\nDone",
  );
});

test("stripChatExportMarkers tolerates malformed artifact metadata", () => {
  assert.equal(stripChatExportMarkers("‹‹ARTIFACT››nope‹‹/ARTIFACT››"), "_[file]_");
});

test("buildChatMarkdown labels known roles and keeps empty messages visible", () => {
  assert.equal(chatExportRoleLabel("assistant"), "Homun");
  assert.equal(chatExportRoleLabel("user"), "Utente");
  assert.equal(
    buildChatMarkdown("", [
      { role: "user", text: "ciao" },
      { role: "assistant", text: "" },
      { role: "system", text: "nota" },
    ]),
    [
      "# Chat",
      "",
      "## Utente",
      "",
      "ciao",
      "",
      "## Homun",
      "",
      "_(vuoto)_",
      "",
      "## system",
      "",
      "nota",
      "",
    ].join("\n"),
  );
});
