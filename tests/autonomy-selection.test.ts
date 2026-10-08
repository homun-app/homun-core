import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPreferences, type AutonomyLevel } from "../apps/web/src/components/builder/conversation-preferences.ts";
import { handleEngineSend } from "../apps/web/src/lib/engine-send-handler.ts";
import type { Work } from "../apps/web/src/components/builder/conversation-types.ts";
import type { EngineWorkspaceState } from "../apps/web/src/hooks/useEngineWorkspace.ts";

test("defaultPreferences specifies guarded autonomyLevel", () => {
  assert.equal(defaultPreferences.autonomyLevel, "guarded");
});

test("handleEngineSend propagates autonomyLevel to engine postMessage", async () => {
  let capturedAutonomy: AutonomyLevel | undefined;
  let postedText = "";

  const mockWork: Work = {
    id: "work_engine_1",
    scenario: 0,
    title: "Incarico autonomo",
    phase: "execution",
    due: "",
    messages: [],
    files: [],
    contribution: "",
    revision: 1,
    feedback: "",
    source: "engine",
    engineConversationId: "conv_1",
  } as unknown as Work;

  const mockEngine: Partial<EngineWorkspaceState> = {
    backend: "engine",
    gateError: null,
    busy: false,
    postMessage: async (_work, text, _attachments, autonomyLevel) => {
      postedText = text;
      capturedAutonomy = autonomyLevel;
    },
  };

  let bumped = false;
  let noticeMsg = "";

  const handled = handleEngineSend({
    engine: mockEngine as EngineWorkspaceState,
    work: mockWork,
    text: "Esegui questo compito in autonomia",
    attachments: [],
    open: () => {},
    setNotice: (msg) => { noticeMsg = msg; },
    bumpOwnSend: () => { bumped = true; },
    autonomyLevel: "autonomous",
  });

  assert.equal(handled, true);
  assert.equal(bumped, true);
  assert.equal(postedText, "Esegui questo compito in autonomia");
  assert.equal(capturedAutonomy, "autonomous");
  assert.equal(noticeMsg, "");
});
