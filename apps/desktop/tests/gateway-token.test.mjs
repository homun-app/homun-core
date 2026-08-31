import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { resolveGatewayToken } = await import("../electron/lib/gateway-token.cjs");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "homun-gateway-token-"));
}

test("explicit gateway token wins without touching the persisted token file", () => {
  const home = tempHome();
  const homunDir = join(home, ".homun");
  const tokenPath = join(homunDir, "desktop-gateway-token");
  mkdirSync(homunDir, { recursive: true });
  writeFileSync(tokenPath, "persisted-token", { mode: 0o600 });

  const token = resolveGatewayToken({ explicitToken: " env-token ", homeDir: home });

  assert.equal(token, "env-token");
  assert.equal(readFileSync(tokenPath, "utf8"), "persisted-token");
});

test("gateway token is reused from the canonical private file", () => {
  const home = tempHome();
  const homunDir = join(home, ".homun");
  mkdirSync(homunDir, { recursive: true });
  writeFileSync(join(homunDir, "desktop-gateway-token"), " persisted-token \n", {
    mode: 0o600,
  });

  assert.equal(resolveGatewayToken({ homeDir: home }), "persisted-token");
});

test("gateway token is generated and persisted privately when no token exists", () => {
  const home = tempHome();

  const token = resolveGatewayToken({
    homeDir: home,
    randomHex: () => "generated-token",
  });
  const tokenPath = join(home, ".homun", "desktop-gateway-token");

  assert.equal(token, "generated-token");
  assert.equal(readFileSync(tokenPath, "utf8"), "generated-token");
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
});
