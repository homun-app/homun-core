import test from "node:test";
import assert from "node:assert/strict";

import { projectMemoryArtifact } from "./artifactProjection.mjs";

function memoryArtifact(overrides = {}) {
  return {
    name: "deck.pdf",
    thread: "thread-managed",
    size: 31860,
    updated: false,
    storage: "managed",
    managed_path: "/Users/test/.homun/artifacts/thread-managed/deck.pdf",
    project_path: "/Users/test/project/deck.pdf",
    project_relative_path: null,
    ...overrides,
  };
}

test("managed memory artifacts keep the managed thread and never inherit project authorization", () => {
  assert.deepEqual(projectMemoryArtifact(memoryArtifact(), "thread-current"), {
    name: "deck.pdf",
    thread: "thread-managed",
    size: 31860,
    updated: false,
    source: "managed",
    managed_path: "/Users/test/.homun/artifacts/thread-managed/deck.pdf",
  });
});

test("project memory artifacts retain their jailed project path", () => {
  assert.deepEqual(
    projectMemoryArtifact(
      memoryArtifact({
        name: "report.md",
        thread: "thread-project",
        storage: "project",
        managed_path: null,
        project_path: "/Users/test/project/docs/report.md",
        project_relative_path: "docs/report.md",
      }),
      "thread-current",
    ),
    {
      name: "docs/report.md",
      thread: "thread-project",
      size: 31860,
      updated: false,
      source: "project",
      projectPath: "/Users/test/project/docs/report.md",
      projectRelativePath: "docs/report.md",
    },
  );
});

test("legacy catalog rows infer managed storage only when the managed contract is complete", () => {
  assert.equal(projectMemoryArtifact(memoryArtifact({ storage: undefined }), "thread-current").source, "managed");
  assert.equal(
    projectMemoryArtifact(
      memoryArtifact({ storage: undefined, thread: "", managed_path: "/tmp/orphan.pdf" }),
      "thread-current",
    ).source,
    "project",
  );
});
