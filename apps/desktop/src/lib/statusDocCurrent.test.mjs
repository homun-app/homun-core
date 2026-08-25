import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const statusDoc = readFileSync(resolve(here, "../../../../docs/STATO.md"), "utf8");

test("status doc records the merged legacy lifecycle cleanup", () => {
  assert.match(statusDoc, /#375/);
  assert.doesNotMatch(statusDoc, /cleanup legacy UI lifecycle in corso/);
  assert.doesNotMatch(statusDoc, /Chiudere la cleanup legacy UI lifecycle/);
});

test("status doc records a concrete current main baseline without stale slice branch", () => {
  assert.match(
    statusDoc,
    /\| HEAD codice verificato \| `main` aggiornato a #[0-9]+ \(`[0-9a-f]{8}`\) \|/,
  );
  assert.doesNotMatch(statusDoc, /fabio\/status-after-ui-lifecycle-retirement/);
});

test("status doc records the merged runtime view model turn contract", () => {
  assert.match(statusDoc, /#377/);
  assert.match(statusDoc, /#379/);
  assert.match(statusDoc, /#381/);
  assert.match(statusDoc, /#383/);
  assert.match(statusDoc, /#384/);
  assert.match(statusDoc, /main` aggiornato a #398 \(`7e0d6318`\)/);
  assert.doesNotMatch(statusDoc, /slice runtimeViewModel turn status in corso/);
  assert.doesNotMatch(statusDoc, /fabio\/ui-runtime-view-model-turn-contract/);
});

test("status doc records the merged composer-mode presenter cleanup slice", () => {
  assert.match(statusDoc, /Slice UI composer-mode presenter contract mergeata #379/);
  assert.match(statusDoc, /Slice doc composer-mode owner cleanup mergeata #381/);
  assert.match(statusDoc, /\| Branch \| `main` \|/);
  assert.doesNotMatch(statusDoc, /fabio\/docs-composer-mode-owner-cleanup/);
  assert.doesNotMatch(statusDoc, /doc composer-mode owner cleanup in corso/);
  assert.doesNotMatch(statusDoc, /Slice locale UI composer-mode presenter contract in corso/);
  assert.doesNotMatch(statusDoc, /fabio\/ui-composer-mode-presenter-contract/);
  assert.doesNotMatch(statusDoc, /fabio\/status-after-composer-mode-presenter/);
  assert.match(statusDoc, /routeComposerSubmission` non deve piu' derivare localmente il composer mode/);
});

test("status doc records the merged selected task and task queue cleanup slices", () => {
  assert.match(statusDoc, /Slice retired selected task projection mergeata #383/);
  assert.match(statusDoc, /Slice task queue canonical empty mergeata #384/);
  assert.match(statusDoc, /selectedTaskProjection\.\{mjs,ts\}/);
  assert.match(statusDoc, /taskQueueProjection` non deve piu' ricevere `fallbackTasks`/);
  assert.doesNotMatch(statusDoc, /fabio\/remove-retired-selected-task-projection/);
  assert.doesNotMatch(statusDoc, /fabio\/task-queue-canonical-empty/);
});

test("status doc records the merged mock transcript cleanup slice", () => {
  assert.match(statusDoc, /Slice App mock transcript seed mergeata #386/);
  assert.match(statusDoc, /main` aggiornato a #398 \(`7e0d6318`\)/);
  assert.match(statusDoc, /mockData` non deve piu' esportare `chatMessages`/);
  assert.doesNotMatch(statusDoc, /fabio\/remove-app-mock-transcript-seed/);
});

test("status doc records the merged capability fallback cleanup slice", () => {
  assert.match(statusDoc, /Slice capability mock fallback mergeata #388/);
  assert.match(statusDoc, /main` aggiornato a #398 \(`7e0d6318`\)/);
  assert.match(statusDoc, /mockData` non deve piu' esportare `connections`/);
  assert.doesNotMatch(statusDoc, /fabio\/remove-capability-mock-fallback/);
});

test("status doc records the merged unused mock runtime export cleanup slice", () => {
  assert.match(statusDoc, /Cleanup unused mock runtime exports/);
  assert.match(statusDoc, /main` aggiornato a #398 \(`7e0d6318`\)/);
  assert.match(statusDoc, /computerSession`, `tasks`, `approvals`, `runtimeHealth`, `memorySummary`/);
  assert.doesNotMatch(statusDoc, /fabio\/remove-unused-mock-runtime-exports/);
});

test("status doc records the mock data owner split cleanup contract", () => {
  assert.match(statusDoc, /Slice mock data owner split/);
  assert.match(statusDoc, /main` aggiornato a #398 \(`7e0d6318`\)/);
  assert.match(statusDoc, /apps\/desktop\/src\/data\/mockData\.ts` e' stato rimosso/);
  assert.match(statusDoc, /navigationConfig\.ts/);
  assert.match(statusDoc, /demoWorkspaceData\.ts/);
  assert.match(statusDoc, /mockData\.ts` non deve essere ricreato/);
});

test("status doc records the merged preview thread fallback cleanup slice", () => {
  assert.match(statusDoc, /Slice preview thread fallback mergeata #395/);
  assert.match(statusDoc, /useChatThreadCreation` non deve tornare a creare thread sintetici/);
  assert.match(statusDoc, /thread_preview_\*/);
  assert.match(statusDoc, /starterMessages/);
  assert.doesNotMatch(statusDoc, /#395 preview fallback aperta/);
});

test("status doc records the merged initial thread loader fallback cleanup slice", () => {
  assert.match(statusDoc, /Slice initial thread loader starter fallback mergeata #397/);
  assert.match(statusDoc, /useInitialChatThreadsLoader` non deve importare `starterMessages`/);
  assert.doesNotMatch(statusDoc, /#397 `Remove initial thread starter fallback`, slice non-browser aperta/);
});

test("status doc records the read-model starter helper cleanup contract", () => {
  assert.match(statusDoc, /useChatReadModelController` non deve importare `starterMessages`/);
  assert.match(statusDoc, /appCoreMappers` non deve esportarlo/);
  assert.match(statusDoc, /threadMessages` oppure restare vuoto/);
});
