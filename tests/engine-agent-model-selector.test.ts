import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import {
  KNOWN_MODEL_PRESETS,
  findModelPreset,
  getProviderDisplayName,
} from '../apps/web/src/lib/known-model-presets.ts';

test('known model presets cover all supported providers with active defaults', () => {
  const ids = KNOWN_MODEL_PRESETS.map((p) => p.id);
  assert.ok(ids.includes('openai_compatible'));
  assert.ok(ids.includes('anthropic'));
  assert.ok(ids.includes('gemini'));
  assert.ok(ids.includes('ollama'));
  assert.ok(ids.includes('deepseek'));
  assert.ok(ids.includes('openrouter'));

  for (const preset of KNOWN_MODEL_PRESETS) {
    assert.ok(preset.name.length > 0);
    assert.ok(preset.defaultModel.length > 0);
    assert.ok(preset.availableModels.length > 0);
    assert.ok(preset.availableModels.includes(preset.defaultModel));
  }
});

test('findModelPreset resolves base and scoped connection IDs', () => {
  const anthropic = findModelPreset('anthropic');
  assert.equal(anthropic?.name, 'Anthropic Claude');

  const scoped = findModelPreset('anthropic:claude-3-5-haiku-20241022');
  assert.equal(scoped?.name, 'Anthropic Claude');

  const geminiScoped = findModelPreset('gemini:gemini-2.0-flash');
  assert.equal(geminiScoped?.name, 'Google Gemini');

  assert.equal(getProviderDisplayName('deepseek'), 'DeepSeek');
  assert.equal(getProviderDisplayName('deepseek:deepseek-reasoner'), 'DeepSeek');
});

test('AgentModelSelector and BrandIcons modules exist', () => {
  assert.ok(existsSync('apps/web/src/components/builder/AgentModelSelector.tsx'));
  assert.ok(existsSync('apps/web/src/components/builder/ProviderBrandIcon.tsx'));
  assert.ok(existsSync('apps/web/src/components/builder/agent-model-selector.css'));
});
