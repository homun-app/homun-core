/**
 * Engine mock for the multilingual error scenario: intercepted with
 * page.route like every browser test. The 413 body is the engine's real
 * shape — code + stable reason + params (docs/development/2026-10-15-errori-multilingua.md).
 */
import type { Page, Route } from "@playwright/test";

export const CONVERSATION_ID = "conv-listini";
export const WORK_ID = "work-listini";
export const PROJECT_ID = "proj-listini";
export const MAX_BYTES = 52_428_800;

export async function mockEngine(page: Page): Promise<void> {
  await page.route("**/v1/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ json: body as object, status });

    if (path === "/v1/health") {
      return json({ status: "ok", version: "test", uptime_seconds: 5 });
    }
    if (path === "/v1/capabilities") {
      return json({
        api_version: "v1",
        version: "test",
        features: {
          domain: true,
          agents: true,
          materials: true,
          memory: true,
          automations: true,
          peers: true,
          backup: true,
          models: true,
        },
      });
    }
    if (path === "/v1/models/providers") {
      return json({
        items: [
          {
            id: "ollama",
            kind: "ollama",
            configured: true,
            credential_present: false,
            base_url: "http://127.0.0.1:11434",
          },
        ],
        active_provider_id: "ollama",
      });
    }
    if (path.endsWith("/language")) {
      return json({ language: "it" });
    }
    if (path.endsWith("/conversations")) {
      return json({
        items: [
          {
            id: CONVERSATION_ID,
            title: "Listini",
            project_id: PROJECT_ID,
            version: 1,
            followups: [],
          },
        ],
      });
    }
    if (path.endsWith("/works")) {
      return json({
        items: [
          {
            id: WORK_ID,
            title: "Listini",
            objective: "Aggiornare i listini",
            status: "running",
            version: 1,
            primary_conversation_id: CONVERSATION_ID,
          },
        ],
      });
    }
    if (path.includes(`/conversations/${CONVERSATION_ID}/messages`)) {
      return json({
        items: [
          {
            id: "m-0",
            text: "Domanda della conversazione sui listini.",
            author_id: "person_fabio",
          },
        ],
        cursor: 1,
        has_more: false,
      });
    }
    if (path.includes("/events")) {
      return route.fulfill({ contentType: "text/event-stream", body: ": quiet\n\n" });
    }
    if (path.endsWith("/projects")) {
      return json({
        items: [
          {
            id: PROJECT_ID,
            workspace_id: "ws_local",
            name: "Listini",
            description: "",
            version: 1,
            team_ids: [],
            member_ids: [],
            conversation_ids: [],
            status: "active",
          },
        ],
      });
    }
    if (path.endsWith(`/projects/${PROJECT_ID}/materials`) && route.request().method() === "GET") {
      return json({ items: [] });
    }
    if (path.endsWith(`/projects/${PROJECT_ID}/materials/ingest`)) {
      return json(
        {
          detail: {
            code: "material_too_large",
            reason: "materials.upload.too_large",
            params: { max_bytes: MAX_BYTES },
            message: `Material exceeds ${MAX_BYTES} bytes`,
          },
        },
        413,
      );
    }
    return json({ items: [] });
  });
}
