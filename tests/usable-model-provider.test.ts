import assert from "node:assert/strict";
import { test } from "node:test";
import { hasUsableModelProvider } from "../apps/web/src/lib/usable-model-provider.ts";

test("hasUsableModelProvider rejects fake and unconfigured providers", () => {
  assert.equal(
    hasUsableModelProvider(
      [{ id: "fake", kind: "fake", configured: true, credential_present: true }],
      "fake",
    ),
    false,
  );
  assert.equal(
    hasUsableModelProvider(
      [{ id: "openai_compatible", kind: "openai", configured: false, credential_present: false }],
      "openai_compatible",
    ),
    false,
  );
});

test("hasUsableModelProvider accepts credentialed cloud or local ollama", () => {
  assert.equal(
    hasUsableModelProvider(
      [
        {
          id: "openai_compatible",
          kind: "openai",
          configured: true,
          credential_present: true,
        },
      ],
      "openai_compatible",
    ),
    true,
  );
  assert.equal(
    hasUsableModelProvider(
      [
        {
          id: "ollama",
          kind: "ollama",
          configured: true,
          credential_present: false,
          base_url: "http://127.0.0.1:11434",
        },
      ],
      "ollama",
    ),
    true,
  );
});
