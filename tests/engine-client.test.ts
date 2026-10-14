import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertEngineReadyForDomain,
  fetchEngineHealth,
  resolveWorkspaceBackend,
  resolveWorkspaceMode,
  type EngineCapabilities,
} from "../apps/web/src/lib/engine-client.ts";
import { isHomunClientError } from "../apps/web/src/lib/homun-errors.ts";

const capsOff: EngineCapabilities = {
  api_version: "v1",
  version: "0.1.0",
  features: {
    domain: false,
    agents: false,
    materials: false,
    memory: false,
    automations: false,
    peers: false,
    backup: false,
    models: false,
  },
};

const capsOn: EngineCapabilities = {
  ...capsOff,
  features: { ...capsOff.features, domain: true, agents: true },
};

describe("engineFetch", () => {
  it("surfaces HomunClientError engine_unavailable, retryable, when the engine is unreachable", async () => {
    await assert.rejects(
      () => fetchEngineHealth("http://127.0.0.1:1"),
      (error: unknown) => {
        assert.ok(isHomunClientError(error));
        assert.equal(error.code, "engine_unavailable");
        assert.equal(error.retryable, true);
        // esattamente HomunClientError: le sottoclassi deprecate non esistono più
        assert.equal(error.name, "HomunClientError");
        return true;
      },
    );
  });
});

describe("assertEngineReadyForDomain", () => {
  it("allows simulation without an online engine", () => {
    assert.doesNotThrow(() => assertEngineReadyForDomain("simulation", false, null));
  });

  it("rejects engine source when the process is absent", () => {
    assert.throws(
      () => assertEngineReadyForDomain("engine", false, null),
      (error: unknown) => isHomunClientError(error) && error.code === "engine_unavailable",
    );
  });

  it("rejects engine source when domain capability is false", () => {
    assert.throws(
      () => assertEngineReadyForDomain("engine", true, capsOff),
      (error: unknown) => isHomunClientError(error) && error.code === "engine_capability_missing",
    );
  });

  it("accepts engine source when connected and domain is ready", () => {
    assert.doesNotThrow(() => assertEngineReadyForDomain("engine", true, capsOn));
  });
});

describe("resolveWorkspaceBackend", () => {
  it("returns simulation when selected", () => {
    assert.equal(resolveWorkspaceBackend("simulation", false, null), "simulation");
  });

  it("returns engine only when online and domain-ready", () => {
    assert.equal(resolveWorkspaceBackend("engine", true, capsOn), "engine");
  });
});

describe("resolveWorkspaceMode", () => {
  it("keeps engine backend when Fonte=motore but engine is down", () => {
    const mode = resolveWorkspaceMode("engine", false, null);
    assert.equal(mode.backend, "engine");
    assert.equal(mode.engineReady, false);
    assert.ok(isHomunClientError(mode.gateError) && mode.gateError.code === "engine_unavailable");
  });

  it("never selects simulation when Fonte=motore", () => {
    const mode = resolveWorkspaceMode("engine", true, capsOff);
    assert.equal(mode.backend, "engine");
    assert.equal(mode.engineReady, false);
  });

  it("marks engine ready when connected with domain", () => {
    const mode = resolveWorkspaceMode("engine", true, capsOn);
    assert.equal(mode.backend, "engine");
    assert.equal(mode.engineReady, true);
    assert.equal(mode.gateError, null);
  });
});
