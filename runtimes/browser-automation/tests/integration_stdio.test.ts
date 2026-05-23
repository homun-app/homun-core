import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

describe("browser sidecar stdio integration", () => {
  it("responds to browser.health over JSON lines", async () => {
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const lines = createInterface({ input: child.stdout });
      child.stdin.write(JSON.stringify({ id: "req_1", method: "browser.health" }) + "\n");
      const [line] = (await once(lines, "line")) as [string];

      expect(JSON.parse(line)).toEqual({
        id: "req_1",
        ok: true,
        result: {
          status: "ready",
          transport: "stdio",
        },
      });
    } finally {
      child.kill();
    }
  });
});
