/**
 * Il banner operativo non esiste più: ogni stato del motore vive nel thread.
 * Questo file aggancia l'invariante allo shell — la logica di «cosa mostrare»
 * è testata in chat-status-notices.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { access, constants } from "node:fs/promises";

test("il banner operativo e il suo involucro nello shell sono stati rimossi", async () => {
  const gone = async (path: string) => {
    await access(path, constants.F_OK).then(
      () => assert.fail(`${path} deve essere stato rimosso`),
      () => undefined,
    );
  };
  await gone("apps/web/src/components/builder/ConversationEngineBanner.tsx");
  await gone("apps/web/src/components/builder/ConversationWorkspaceEngineNotices.tsx");

  const shell = await readFile("apps/web/src/components/builder/ConversationWorkspace.tsx", "utf8");
  assert.doesNotMatch(
    shell,
    /ConversationEngineBanner|ConversationWorkspaceEngineNotices|cw-engine-banner/,
  );
});

test("lo stage motore passa gli stati del client agli slot del thread, non ai messaggi", async () => {
  const stage = await readFile("apps/web/src/components/builder/chat/EngineChatStage.tsx", "utf8");
  assert.match(stage, /chatStatusNotices/);
  const chat = await readFile("apps/web/src/components/builder/chat/EngineAgentChat.tsx", "utf8");
  assert.match(chat, /chatStatusLayout/);
  assert.match(chat, /ComposerStatusNotices/);
  assert.match(chat, /ThreadEndStatusNotices/);
  // il canale messaggi del runtime riceve solo lo stream: mai gli avvisi
  const agentChatTag = chat.match(/<AgentChat[\s\S]*?\/>/);
  assert.ok(agentChatTag, "EngineAgentChat rende il thread tramite <AgentChat/>");
  assert.match(agentChatTag[0], /messages=\{messages\}/);
  assert.doesNotMatch(agentChatTag[0], /statusNotices|chatStatus/);
  const slots = await readFile(
    "apps/web/src/components/builder/chat/ChatStatusNotices.tsx",
    "utf8",
  );
  assert.match(slots, /data-chat-status-slot/);
});
