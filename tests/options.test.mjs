import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOptions, predictionModel } from '../src/opencode/options.mjs';

test('options keep existing defaults and clamp numeric settings', () => {
  assert.deepEqual(readOptions({}), { automatic: true, debounceMs: 500, cooldownMs: 1500, timeoutMs: 7000 });
  assert.deepEqual(readOptions({ automatic: false, typingDebounceMs: -1, cooldownMs: 20000, timeoutMs: 1 }), {
    automatic: false, debounceMs: 100, cooldownMs: 10000, timeoutMs: 1000,
  });
  assert.deepEqual(readOptions({ typingDebounceMs: NaN, cooldownMs: '0', timeoutMs: Infinity }), readOptions({}));
});

function context(options = {}, variants = ['high', 'low', 'minimal']) {
  const selected = { providerID: 'test', modelID: 'fast', variant: 'high' };
  return { options, selected, ui: { model: { current: () => selected, variant: { list: () => variants } } } };
}

test('prediction model prefers minimal then low without changing the selected variant', () => {
  for (const [variants, expected] of [[['low', 'minimal'], 'minimal'], [['high', 'low'], 'low'], [['high'], undefined]]) {
    const host = context({}, variants);
    assert.deepEqual(predictionModel(host), { providerID: 'test', id: 'fast', variant: expected });
    assert.equal(host.selected.variant, 'high');
  }
});

test('explicit prediction model is used as-is; incomplete configuration does not fall back', () => {
  const model = { providerID: 'other', id: 'small', variant: 'custom' };
  assert.deepEqual(predictionModel(context({ predictionModel: model })), model);
  assert.equal(predictionModel(context({ predictionModel: { providerID: 'other' } })), undefined);
  const host = context();
  host.ui.model.current = () => undefined;
  assert.equal(predictionModel(host), undefined);
});

test('OpenCode string selectors support variants and nested model IDs', () => {
  for (const [selector, expected] of [
    ['openai/gpt-5.2', { providerID: 'openai', id: 'gpt-5.2', variant: undefined }],
    ['openai/gpt-5.2#low', { providerID: 'openai', id: 'gpt-5.2', variant: 'low' }],
    ['openrouter/anthropic/claude-sonnet-4.5#high', { providerID: 'openrouter', id: 'anthropic/claude-sonnet-4.5', variant: 'high' }],
    ['vllm/Qwen/Qwen3-Coder-30B-A3B-Instruct', { providerID: 'vllm', id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', variant: undefined }],
  ]) {
    const host = context({ predictionModel: selector });
    assert.deepEqual(predictionModel(host), expected);
    assert.equal(host.selected.variant, 'high');
  }
});

test('OpenCode expanded selectors use model, while legacy id stays supported', () => {
  for (const selector of [
    { providerID: 'openai', model: 'gpt-5.2', variant: 'low' },
    { providerID: 'openai', id: 'gpt-5.2', variant: 'low' },
  ]) {
    assert.deepEqual(predictionModel(context({ predictionModel: selector })), {
      providerID: 'openai', id: 'gpt-5.2', variant: 'low',
    });
  }
  assert.deepEqual(predictionModel(context({ predictionModel: { providerID: 'test', model: 'native', id: 'legacy' } })), {
    providerID: 'test', id: 'native', variant: undefined,
  });
});

test('malformed explicit selectors never silently switch to the session model', () => {
  for (const selector of [
    '', 'openai', '/model', 'openai/', 'openai/model#', 'openai/model#low#extra', 'open#ai/model',
    false, 42, [], {}, { providerID: 'test' }, { providerID: '/bad', model: 'model' },
    { providerID: 'test', model: '' }, { providerID: 'test', model: 42 },
    { providerID: 'test', model: 'model#low' }, { providerID: 'test', model: 'model', variant: '' },
    { providerID: 'test', model: 'model', variant: null }, { providerID: 'test', model: 'model', variant: 'low#extra' },
    { providerID: 'test', model: '', id: 'legacy' }, { providerID: 'test', id: true },
  ]) {
    assert.equal(predictionModel(context({ predictionModel: selector })), undefined, JSON.stringify(selector));
  }
});

test('unset model uses session defaults; explicit models do not borrow session variants', () => {
  assert.deepEqual(predictionModel(context({ predictionModel: null })), predictionModel(context()));
  assert.deepEqual(predictionModel(context({ predictionModel: { providerID: 'other', model: 'small' } })), {
    providerID: 'other', id: 'small', variant: undefined,
  });
  const host = context({ predictionModel: 'other/small#low' });
  host.ui.model.current = () => undefined;
  assert.deepEqual(predictionModel(host), { providerID: 'other', id: 'small', variant: 'low' });
});
