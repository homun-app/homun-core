import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRemoteMcpConnectInput,
  remoteMcpReady,
} from "./mcpConnection.mjs";

test("bearer auth becomes an Authorization header", () => {
  assert.deepEqual(
    buildRemoteMcpConnectInput({
      name: "Orion Moon",
      url: "https://orion-moon.pinkfloyd.competitoor.com/mcp",
      authMode: "bearer",
      bearerToken: " secret-token ",
    }),
    {
      name: "Orion Moon",
      url: "https://orion-moon.pinkfloyd.competitoor.com/mcp",
      headers: { Authorization: "Bearer secret-token" },
    },
  );
});

test("bearer mode requires a non-empty token", () => {
  assert.equal(
    remoteMcpReady({
      name: "Orion Moon",
      url: "https://example.com/mcp",
      authMode: "bearer",
      bearerToken: "",
    }),
    false,
  );
  assert.equal(
    remoteMcpReady({
      name: "Orion Moon",
      url: "https://example.com/mcp",
      authMode: "bearer",
      bearerToken: " token ",
    }),
    true,
  );
});

test("no-auth mode sends no credential header", () => {
  assert.deepEqual(
    buildRemoteMcpConnectInput({
      name: "Public",
      url: "https://example.com/mcp",
      authMode: "none",
      bearerToken: "ignored",
    }),
    {
      name: "Public",
      url: "https://example.com/mcp",
      headers: {},
    },
  );
});
