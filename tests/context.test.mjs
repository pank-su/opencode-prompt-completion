import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContext } from '../context.mjs';

test('native V2 message types are recognized without a role alias', () => {
  const value = buildContext([{ type: 'user', text: 'Task' }, { type: 'assistant', content: [{ type: 'text', text: 'Answer' }] }]);
  assert.deepEqual(JSON.parse(value.text), [{ role: 'user', text: 'Task' }, { role: 'assistant', text: 'Answer' }]);
});

test('a small context budget preserves the newest message instead of older ones that fit', () => {
  const value = buildContext([{ type: 'user', text: 'OLD' }, { type: 'assistant', content: [{ type: 'text', text: 'NEW'.repeat(1000) }] }], { maxCharacters: 150 });
  const selected = JSON.parse(value.text);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].role, 'assistant');
  assert.ok(selected[0].text.startsWith('NEW'));
  assert.ok(value.text.length <= 150);
});

const userText = (text) => ({ role: 'user', text });
const assistantText = (text) => ({ role: 'assistant', text });

test('selects only user and assistant text and ignores tools, reasoning, files and system', () => {
  const { text } = buildContext([
    { role: 'system', text: 'system instructions' },
    userText('hello'),
    assistantText('hi there'),
    {
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'private chain of thought' },
        { type: 'tool', text: 'tool call payload' },
        { type: 'tool-result', text: 'tool result payload' },
        { type: 'file', text: 'file contents' },
        { type: 'image', text: 'image bytes' },
        { type: 'text', text: 'visible answer' },
      ],
    },
  ]);

  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi there' },
    { role: 'assistant', text: 'visible answer' },
  ]);
  assert.ok(!text.includes('private chain of thought'));
  assert.ok(!text.includes('tool call payload'));
  assert.ok(!text.includes('tool result payload'));
  assert.ok(!text.includes('system instructions'));
});

test('keeps at most four messages, favouring the newest', () => {
  const messages = [];
  for (let i = 0; i < 10; i += 1) {
    messages.push(userText(`user-${i}`));
    messages.push(assistantText(`assistant-${i}`));
  }
  const parsed = JSON.parse(buildContext(messages).text);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map((entry) => entry.text), [
    'user-8', 'assistant-8', 'user-9', 'assistant-9',
  ]);
});

test('handles role info, payload text and part-based messages', () => {
  const { text } = buildContext([
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'first' }] },
    { payload: { role: 'assistant', text: 'second' } },
    { role: 'user', content: [{ type: 'text', text: 'third' }] },
  ]);
  assert.deepEqual(JSON.parse(text), [
    { role: 'user', text: 'first' },
    { role: 'assistant', text: 'second' },
    { role: 'user', text: 'third' },
  ]);
});

test('running excludes the assistant reply after the most recent user message', () => {
  const completed = [userText('do X'), assistantText('done X'), userText('now do Y')];
  const streaming = [...completed, assistantText('partial reply that is still streaming')];

  const running = buildContext(streaming, { running: true });
  assert.deepEqual(JSON.parse(running.text), [
    { role: 'user', text: 'do X' },
    { role: 'assistant', text: 'done X' },
    { role: 'user', text: 'now do Y' },
  ]);
  assert.ok(!running.text.includes('still streaming'));

  const idle = buildContext(streaming, { running: false });
  assert.deepEqual(JSON.parse(idle.text), [
    { role: 'user', text: 'do X' },
    { role: 'assistant', text: 'done X' },
    { role: 'user', text: 'now do Y' },
    { role: 'assistant', text: 'partial reply that is still streaming' },
  ]);

  assert.notEqual(running.revision, idle.revision);
});

test('revision is stable while running as transient assistant events grow', () => {
  const base = [userText('do X'), assistantText('done X'), userText('now do Y')];
  const first = buildContext([...base, assistantText('partial')], { running: true });
  const second = buildContext([
    ...base,
    {
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'more reasoning' },
        { type: 'tool', text: 'a tool call' },
        { type: 'text', text: 'partial and growing' },
      ],
    },
  ], { running: true });

  assert.equal(first.revision, second.revision);
  assert.equal(first.text, second.text);
});

test('revision changes when completed context changes but is deterministic', () => {
  const a = buildContext([userText('one'), assistantText('two')]);
  const b = buildContext([userText('one'), assistantText('two')]);
  const c = buildContext([userText('one'), assistantText('three')]);

  assert.equal(a.revision, b.revision);
  assert.notEqual(a.revision, c.revision);
  assert.equal(typeof a.revision, 'string');
  assert.equal(a.revision.length, 64);
});

test('bounds the serialized text to maxCharacters including escapes', () => {
  const long = 'x'.repeat(5000);
  const { text } = buildContext([userText(long), assistantText(long)], { maxCharacters: 1000 });
  assert.ok(text.length <= 1000, String(text.length));
  assert.doesNotThrow(() => JSON.parse(text));
});

test('bounds large Unicode text without splitting surrogate pairs', () => {
  const emoji = '😀'.repeat(4000);
  const { text } = buildContext([userText(emoji)], { maxCharacters: 500 });
  assert.ok(text.length <= 500, String(text.length));
  const parsed = JSON.parse(text);
  assert.equal(parsed.length, 1);
  for (const char of parsed[0].text) {
    assert.ok(char.codePointAt(0) <= 0x10FFFF);
  }
});

test('bounds escaped control-heavy text and stays valid JSON', () => {
  const noisy = `${'"\\\n\t'.repeat(2000)}`;
  const { text } = buildContext([userText(noisy)], { maxCharacters: 300 });
  assert.ok(text.length <= 300, String(text.length));
  assert.doesNotThrow(() => JSON.parse(text));
});

test('an empty or non-text input yields an empty JSON array and a stable revision', () => {
  const empty = buildContext([]);
  assert.equal(empty.text, '[]');
  const toolsOnly = buildContext([{ role: 'assistant', parts: [{ type: 'tool', text: 'x' }] }]);
  assert.equal(toolsOnly.text, '[]');
  assert.equal(empty.revision, toolsOnly.revision);
});
