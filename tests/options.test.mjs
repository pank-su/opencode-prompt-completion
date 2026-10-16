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
