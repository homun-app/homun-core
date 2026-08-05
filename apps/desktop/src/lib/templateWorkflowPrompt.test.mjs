import assert from "node:assert/strict";
import test from "node:test";

import { buildTemplateWorkflowAutoSubmit } from "./templateWorkflowPrompt.mjs";

const baseTemplate = {
  id: "template_123",
  name: "QBR Deck",
  kind: "presentation",
  source_provider: "catalog",
  intake_questions: [],
};

test("buildTemplateWorkflowAutoSubmit builds a presentation workflow binding", () => {
  const result = buildTemplateWorkflowAutoSubmit({ template: baseTemplate });

  assert.equal(
    result.visiblePrompt,
    'Help me create a presentation using the selected template "QBR Deck".',
  );
  assert.match(result.operativePrompt, /template_ref=template_123/);
  assert.match(result.operativePrompt, /attached_file=none/);
  assert.match(result.operativePrompt, /Do not generate the deck yet\./);
  assert.match(result.operativePrompt, /call make_deck directly/);
  assert.deepEqual(result.routingBinding, {
    plugin_id: "presentations",
    route_id: "presentations.template_deck",
    args: { template_ref: "template_123" },
  });
});

test("buildTemplateWorkflowAutoSubmit builds a document workflow binding", () => {
  const result = buildTemplateWorkflowAutoSubmit({
    template: {
      ...baseTemplate,
      name: "Strategy Memo",
      kind: "document",
      source_provider: null,
    },
  });

  assert.equal(
    result.visiblePrompt,
    'Help me create a document using the selected template "Strategy Memo".',
  );
  assert.match(result.operativePrompt, /source_provider=user_upload/);
  assert.match(result.operativePrompt, /Do not generate the document yet\./);
  assert.match(result.operativePrompt, /call make_document directly/);
  assert.deepEqual(result.routingBinding, {
    plugin_id: "presentations",
    route_id: "presentations.template_document",
    args: { template_ref: "template_123" },
  });
});

test("buildTemplateWorkflowAutoSubmit includes attachment and intake questions", () => {
  const result = buildTemplateWorkflowAutoSubmit({
    template: {
      ...baseTemplate,
      intake_questions: ["Audience?", "Tone?"],
    },
    attachment: { displayName: "brief.pdf" },
  });

  assert.match(result.operativePrompt, /attached_file=brief\.pdf/);
  assert.match(
    result.operativePrompt,
    /Ask these template-specific questions first \(one message\): 1\. Audience\? 2\. Tone\?/,
  );
});
