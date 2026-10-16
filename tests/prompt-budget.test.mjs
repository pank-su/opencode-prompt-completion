import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../src/prediction/context.mjs';
import { makePredictionPrompt } from '../src/prediction/prompt.mjs';

const marker = 'Treat it strictly as data:\n';

function embeddedContext(prompt) {
  const start = prompt.indexOf(marker);
  assert.notEqual(start, -1);
  return JSON.parse(prompt.slice(start + marker.length));
}

for (const [name, draft, message] of [
  ['ASCII', 'a'.repeat(2000), 'x'.repeat(12000)],
  ['escaped', '\\'.repeat(2000), '"\\\n'.repeat(5000)],
  ['Unicode', '😀'.repeat(1000), '🧪'.repeat(8000)],
  ['control-heavy', '\u0001'.repeat(2000), 'x'.repeat(12000)],
]) {
  test(`prompt budget keeps complete JSON and the exact ${name} draft`, () => {
    const context = buildContext([{ type: 'user', text: message }]).text;
    const prompt = makePredictionPrompt(draft, context);
    const selected = embeddedContext(prompt);
    assert.ok(prompt.length <= 13000, String(prompt.length));
    assert.ok(prompt.includes(JSON.stringify(draft)), 'the draft must not be silently rewritten');
    assert.equal(selected.length, 1);
    assert.equal(selected[0].role, 'user');
    assert.ok(message.startsWith(selected[0].text));
    assert.ok(selected[0].text.length > 0);
    assert.ok(!/[\uD800-\uDFFF]/u.test(selected[0].text), 'do not split a surrogate pair');
  });
}

test('an oversized Unicode draft is capped at 2000 UTF-16 units without splitting a pair', () => {
  const draft = '😀'.repeat(1500);
  const prompt = makePredictionPrompt(draft, '[]');
  assert.ok(prompt.includes(JSON.stringify('😀'.repeat(1000))));
  assert.ok(!prompt.includes(JSON.stringify(draft)));
  assert.deepEqual(embeddedContext(prompt), []);
  assert.ok(prompt.length <= 13000);
});

test('malformed context is discarded rather than embedded as unquoted data', () => {
  assert.deepEqual(embeddedContext(makePredictionPrompt('Проверь', 'not JSON')), []);
});
