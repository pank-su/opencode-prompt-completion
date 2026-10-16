import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Model } from '@opencode/plugin';
import { predictionModel } from '../src/opencode/options.mjs';

// Compare against the real OpenCode SDK without adding a runtime dependency.
// An explicit selector must not inspect or change the current session model.
function resolve(selector) {
  return predictionModel({ options: { predictionModel: selector }, ui: {} });
}

test('string selectors match the OpenCode SDK model-reference parser', () => {
  for (const selector of [
    'openai/gpt-5.2',
    'openai/gpt-5.2#low',
    'openrouter/anthropic/claude-sonnet-4.5#high',
    'ollama/gemma3:4b',
    'vllm/Qwen/Qwen3-Coder-30B-A3B-Instruct',
    'Provider/Model/Submodel#Variant',
    'test//nested',
  ]) {
    const native = Model.Ref.parse(selector);
    assert.deepEqual(resolve(selector), { providerID: native.providerID, id: native.id, variant: native.variant });
    assert.deepEqual(resolve({ providerID: native.providerID, model: native.id, variant: native.variant }), resolve(selector));
  }
});

test('malformed string selectors are rejected by both the SDK and plugin', () => {
  for (const selector of ['', 'openai', '/model', 'openai/', 'openai/model#', 'open#ai/model', 'openai/model#low#extra']) {
    assert.throws(() => Model.Ref.parse(selector));
    assert.equal(resolve(selector), undefined, selector);
  }
});
