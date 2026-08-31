const { randomBytes } = require("node:crypto");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

function resolveGatewayToken({
  explicitToken = process.env.HOMUN_DESKTOP_GATEWAY_TOKEN,
  homeDir = homedir(),
  randomHex = () => randomBytes(32).toString("hex"),
} = {}) {
  const fromEnv = (explicitToken ?? "").trim();
  if (fromEnv) return fromEnv;

  const dir = join(homeDir, ".homun");
  const tokenPath = join(dir, "desktop-gateway-token");
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // No persisted token yet; generate one below.
  }

  const token = randomHex();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch {
    // Non-fatal: the Electron shell and gateway can still share this in-memory token.
  }
  return token;
}

module.exports = { resolveGatewayToken };
