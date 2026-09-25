import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listGatewayPairings,
  requestGatewayPairing,
  approveGatewayPairing,
  declineGatewayPairing,
  revokeGatewayPairing,
} from "../apps/web/src/lib/engine-gateway-client.ts";

test("listGatewayPairings queries engine and filters by platform", async () => {
  const original = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return Response.json({
      requests: [
        {
          code: "ABCDEFGH",
          platform: "telegram",
          user_id: "user_123",
          username: "sara",
          status: "pending",
          created_at: 1000,
          expires_at: 4600,
        },
      ],
    });
  };
  try {
    const res = await listGatewayPairings({ platform: "telegram" });
    assert.match(requestedUrl, /\/v1\/gateway\/pairing\?platform=telegram$/);
    assert.equal(res.length, 1);
    assert.equal(res[0].code, "ABCDEFGH");
    assert.equal(res[0].platform, "telegram");
  } finally {
    globalThis.fetch = original;
  }
});

test("requestGatewayPairing sends platform and credentials and returns generated code", async () => {
  const original = globalThis.fetch;
  let requestBody: any = null;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      status: "requested",
      pairing: {
        code: "XYZ12345",
        platform: "telegram",
        user_id: "user_999",
        status: "pending",
        created_at: 1000,
        expires_at: 4600,
      },
    });
  };
  try {
    const res = await requestGatewayPairing({ platform: "telegram", userId: "user_999", username: "marco" });
    assert.equal(requestBody.platform, "telegram");
    assert.equal(requestBody.user_id, "user_999");
    assert.equal(requestBody.username, "marco");
    assert.equal(res.code, "XYZ12345");
  } finally {
    globalThis.fetch = original;
  }
});

test("approveGatewayPairing uppercases and trims code and marks approved", async () => {
  const original = globalThis.fetch;
  let requestBody: any = null;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      status: "approved",
      pairing: {
        code: "H7KL9MNP",
        platform: "slack",
        user_id: "slack_user_42",
        status: "approved",
        created_at: 1000,
        expires_at: 4600,
      },
    });
  };
  try {
    const res = await approveGatewayPairing("  h7kl9mnp  ");
    assert.equal(requestBody.code, "H7KL9MNP");
    assert.equal(res.status, "approved");
  } finally {
    globalThis.fetch = original;
  }
});

test("declineGatewayPairing and revokeGatewayPairing handle denial and removal", async () => {
  const original = globalThis.fetch;
  let lastAction = "";
  globalThis.fetch = async (url, init) => {
    const sUrl = String(url);
    if (sUrl.includes("/decline")) {
      lastAction = "decline";
      return Response.json({ pairing: { code: "ABC", status: "declined" } });
    }
    if (sUrl.includes("/revoke")) {
      lastAction = "revoke";
      return Response.json({ status: "revoked", platform: "telegram", user_id: "u1" });
    }
    return Response.json({});
  };
  try {
    const dec = await declineGatewayPairing("ABC");
    assert.equal(lastAction, "decline");
    assert.equal(dec.status, "declined");

    const rev = await revokeGatewayPairing({ platform: "telegram", userId: "u1" });
    assert.equal(lastAction, "revoke");
    assert.equal(rev.status, "revoked");
  } finally {
    globalThis.fetch = original;
  }
});
