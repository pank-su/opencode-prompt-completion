import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PredictionController } from '../src/prediction/controller.mjs';

test('a manually extended complete candidate is visible instead of hidden by the shorter cached candidate', async () => {
  let calls = 0;
  const controller = new PredictionController({ generate: async () => ({ text: JSON.stringify({ suggestion: ++calls === 1 ? ' тесты' : ' и lint' }) }) });
  const snapshot = { sessionID: 's1', editor: {}, prefix: 'Проверь', presentable: true, requestable: true,
    revision: 'revision', model: { providerID: 'test', id: 'fast' }, context: '[]' };
  try {
    await controller.request(snapshot, 'first');
    await new Promise(resolve => setImmediate(resolve));
    controller.update({ ...snapshot, prefix: 'Проверь тесты' });
    assert.equal(controller.state.reason, 'complete');
    await controller.request({ ...snapshot, prefix: 'Проверь тесты' }, 'retry', { manual: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.state.status, 'ready');
    assert.equal(controller.state.suggestion, ' и lint');
  } finally { controller.dispose(); }
});
