import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import test from "node:test"
import { HomunProvider } from "../src/index.ts"

test("initialize rejects every non-loopback gateway", async () => {
  const provider = new HomunProvider()
  await assert.rejects(
    provider.initialize({ apiKey: "token", baseUrl: "https://memory.example.com" }),
    /loopback/,
  )
  await assert.rejects(
    provider.initialize({ apiKey: "token", baseUrl: "http://127.evil.example" }),
    /loopback/,
  )
  await assert.rejects(
    provider.initialize({ apiKey: "", baseUrl: "http://127.0.0.1:18765" }),
    /token is required/,
  )
})

test("provider implements ingest, indexing, search, and governed clear", async (context) => {
  const calls: Array<{ path: string; body: unknown; authorization: string | undefined }> = []
  let statusCalls = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString("utf8")
    const body = raw ? JSON.parse(raw) : null
    calls.push({
      path: request.url || "",
      body,
      authorization: request.headers.authorization,
    })
    response.setHeader("content-type", "application/json")
    if (request.url === "/api/memory/bench/ingest") {
      response.end(
        JSON.stringify({
          workspace_id: "memorybench_alpha",
          document_ids: ["memory:user:memorybench_alpha:session-1"],
        }),
      )
    } else if (request.url === "/api/memory/bench/status") {
      statusCalls += 1
      response.end(
        JSON.stringify({
          completed_ids: statusCalls > 1 ? ["memory:user:memorybench_alpha:session-1"] : [],
          failed_ids: [],
          total: 1,
          pending: statusCalls === 1,
        }),
      )
    } else if (request.url === "/api/memory/bench/search") {
      response.end(
        JSON.stringify({
          results: [
            {
              reference: "memory:user:memorybench_alpha:session-1",
              summary: "The launch moved to Monday",
              score: 1,
              source_user_id: "user",
              source_workspace_id: "memorybench_alpha",
              source_label: "MemoryBench alpha",
              status: "confirmed",
              memory_type: "episode",
            },
          ],
        }),
      )
    } else if (request.url === "/api/workspaces/memorybench_alpha/delete") {
      response.end(JSON.stringify({ workspaces: [] }))
    } else {
      response.statusCode = 404
      response.end(JSON.stringify({ error: "not found" }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  context.after(() => server.close())
  const address = server.address()
  assert(address && typeof address !== "string")
  const provider = new HomunProvider()
  await provider.initialize({
    apiKey: "gateway-token",
    baseUrl: `http://127.0.0.1:${address.port}`,
    pollMs: 1,
    timeoutMs: 1_000,
  })
  const result = await provider.ingest(
    [
      {
        sessionId: "session-1",
        messages: [{ role: "user", content: "The launch moved to Monday" }],
      },
    ],
    { containerTag: "alpha" },
  )
  const progress: number[] = []
  await provider.awaitIndexing(result, "alpha", (value) => progress.push(value.completedIds.length))
  const results = await provider.search("When is launch?", { containerTag: "alpha", limit: 5 })
  await provider.clear("alpha")

  assert.deepEqual(progress, [0, 1])
  assert.equal(results[0]?.summary, "The launch moved to Monday")
  assert.equal(results[0]?.sourceWorkspaceId, "memorybench_alpha")
  assert.equal((calls[0]?.body as { sessions: unknown[] }).sessions.length, 1)
  assert(calls.every((call) => call.authorization === "Bearer gateway-token"))
  assert.equal(calls.at(-1)?.path, "/api/workspaces/memorybench_alpha/delete")
})

test("governance fixture covers Homun isolation and safety contracts", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/governance.json", import.meta.url), "utf8"),
  ) as string[]
  assert.deepEqual(fixture, [
    "project_isolation",
    "direct_grant_and_revoke",
    "update_history",
    "repeated_ingest",
    "temporal_expiry",
    "abstention",
    "vault_non_leakage",
  ])
})
