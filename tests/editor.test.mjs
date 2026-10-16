import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { focusedPrompt, insertPrediction, promptSnapshot, watchPrompt } from '../editor.mjs';

function offsetOf(text, row, col) {
  const lines = text.split('\n');
  if (row < 0 || row >= lines.length) return text.length;
  let result = 0;
  for (let i = 0; i < row; i += 1) result += lines[i].length + 1;
  return result + Math.max(0, Math.min(col, lines[row].length));
}

function fixture() {
  const editor = Object.assign(new EventEmitter(), {
    editBuffer: new EventEmitter(), focused: true, focusable: true, plainText: '',
    logicalCursor: { row: 0, col: 0 },
    traits: { owner: 'opencode', role: 'prompt', capture: ['tab'] },
    hasSelection: () => false,
    insertText(value) {
      const { row, col } = this.logicalCursor;
      const lines = this.plainText.split('\n');
      const line = lines[row] ?? '';
      lines[row] = line.slice(0, col) + value + line.slice(col);
      this.plainText = lines.join('\n');
      this.logicalCursor = { row, col: col + value.length };
      this.editBuffer.emit('content-changed');
    },
  });
  editor.editBuffer.getTextRangeByCoords = (r0, c0, r1, c1) => {
    const value = editor.plainText;
    return value.slice(offsetOf(value, r0, c0), offsetOf(value, r1, c1));
  };
  const renderer = Object.assign(new EventEmitter(), { currentFocusedEditor: editor });
  const session = { id: 's1', location: { directory: '/project' } };
  const context = { renderer, ui: { router: { current: () => ({ type: 'session', sessionID: 's1' }) } },
    data: { session: { get: () => session, status: () => 'idle', pending: { list: () => [] },
      permission: { list: () => [] }, form: { list: () => [] } } } };
  return { context, renderer, editor, session };
}

// Simulate a user typing: set the buffer and place the native caret at the end
// (or one code unit before it when `atEnd` is false).
function type(editor, value, { atEnd = true } = {}) {
  editor.plainText = value;
  const lines = value.split('\n');
  const last = lines.length - 1;
  editor.logicalCursor = atEnd
    ? { row: last, col: lines[last].length }
    : { row: 0, col: Math.max(0, (lines[0] ?? '').length - 1) };
  editor.editBuffer.emit('content-changed');
}

test('only a focused OpenCode prompt is eligible', () => {
  const { context, renderer, editor } = fixture();
  assert.equal(focusedPrompt(renderer), editor);
  assert.equal(promptSnapshot(context).eligible, true);
  for (const change of [{ focused: false }, { focusable: false }, { isDestroyed: true },
    { traits: { owner: 'other', role: 'prompt' } }, { traits: { owner: 'opencode', role: 'search' } }]) {
    const original = { ...editor };
    Object.assign(editor, change);
    assert.equal(focusedPrompt(renderer), undefined);
    Object.assign(editor, original);
  }
});

test('managed keymap suspension does not disable the OpenCode prompt', () => {
  const { context, editor } = fixture();
  editor.traits.suspend = true;
  assert.equal(promptSnapshot(context).eligible, true);
  assert.equal(insertPrediction(context, { status: 'ready', sessionID: 's1', suggestion: 'Проверь тесты' }), true);
  assert.equal(editor.plainText, 'Проверь тесты');
});

test('a typed draft is eligible and its exact text is reported as the prefix', () => {
  const { context, editor } = fixture();
  type(editor, 'Мой черновик');
  const snapshot = promptSnapshot(context);
  assert.equal(snapshot.eligible, true);
  assert.equal(snapshot.prefix, 'Мой черновик');
});

test('a blank-state prediction never appends over an unrelated draft', () => {
  const { context, editor } = fixture();
  type(editor, 'Мой черновик');
  assert.equal(insertPrediction(context, { status: 'ready', sessionID: 's1', suggestion: 'Новый промпт' }), false);
  assert.equal(insertPrediction(context, { status: 'ready', sessionID: 's1', prefix: 'другой', suggestion: 'Новый промпт' }), false);
  assert.equal(editor.plainText, 'Мой черновик');
});

test('continuation appends only the missing suffix and preserves the draft', () => {
  const { context, editor } = fixture();
  type(editor, 'Мой');
  const calls = [];
  const original = editor.insertText.bind(editor);
  editor.insertText = value => { calls.push(value); original(value); };
  assert.equal(insertPrediction(context, { status: 'ready', sessionID: 's1', prefix: 'Мой', suggestion: ' черновик' }), true);
  assert.deepEqual(calls, [' черновик']);
  assert.equal(editor.plainText, 'Мой черновик');
  assert.deepEqual(editor.logicalCursor, { row: 0, col: 'Мой черновик'.length });
});

test('a caret that is not at the buffer end blocks eligibility', () => {
  const { context, editor } = fixture();
  type(editor, 'Мой черновик', { atEnd: false });
  assert.equal(promptSnapshot(context).eligible, false);
});

test('the caret-at-end check also applies to an empty buffer', () => {
  const { context, editor } = fixture();
  editor.plainText = '';
  editor.logicalCursor = { row: 0, col: 0 };
  editor.editBuffer.getTextRangeByCoords = () => 'not empty';
  assert.equal(promptSnapshot(context).eligible, false);
});

test('the caret-at-end check compares native text, not JS string length', () => {
  const { context, editor } = fixture();
  const value = 'Привет 👋';
  const codePoints = [...value].length;
  assert.notEqual(codePoints, value.length);
  editor.plainText = value;
  editor.logicalCursor = { row: 0, col: codePoints };
  editor.editBuffer.getTextRangeByCoords = (r0, c0, r1, c1) => [...value].slice(0, c1).join('');
  assert.equal(promptSnapshot(context).eligible, true);
  assert.equal(promptSnapshot(context).prefix, value);
  editor.logicalCursor = { row: 0, col: codePoints - 1 };
  assert.equal(promptSnapshot(context).eligible, false);
});

test('command drafts, shell prompts and overlong drafts are ineligible', () => {
  const slash = fixture();
  type(slash.editor, '/help');
  assert.equal(promptSnapshot(slash.context).eligible, false);

  const bang = fixture();
  type(bang.editor, '  !rm -rf');
  assert.equal(promptSnapshot(bang.context).eligible, false);

  const shell = fixture();
  type(shell.editor, 'смотри');
  shell.editor.traits.status = 'SHELL';
  assert.equal(promptSnapshot(shell.context).eligible, false);

  const tooLong = fixture();
  type(tooLong.editor, 'a'.repeat(2001));
  assert.equal(promptSnapshot(tooLong.context).eligible, false);

  const atLimit = fixture();
  type(atLimit.editor, 'a'.repeat(2000));
  assert.equal(promptSnapshot(atLimit.context).eligible, true);
});

test('selections, shell prompts and autocomplete keys stay ineligible', () => {
  for (const change of [{ hasSelection: () => true },
    { traits: { owner: 'opencode', role: 'prompt', status: 'SHELL' } },
    ...['submit', 'navigate', 'escape'].map(value => ({ traits: { owner: 'opencode', role: 'prompt', capture: [value] } }))]) {
    const { context, editor } = fixture();
    type(editor, 'Мой черновик');
    Object.assign(editor, change);
    assert.equal(promptSnapshot(context).eligible, false);
    assert.equal(insertPrediction(context, { status: 'ready', sessionID: 's1', prefix: 'Мой черновик', suggestion: ' продолжение' }), false);
  }
});

test('working agent does not block cached presentation or stateless generation', () => {
  const { context, editor } = fixture();
  context.data.session.status = () => 'running';
  type(editor, 'Проверь');
  assert.equal(promptSnapshot(context).presentable, true);
  assert.equal(promptSnapshot(context).requestable, true);
});

test('pending work blocks new requests, not an already cached suffix', () => {
  for (const field of ['pending', 'permission', 'form']) {
    const { context, editor } = fixture();
    type(editor, 'Проверь');
    context.data.session[field].list = () => [{ id: 'waiting' }];
    assert.equal(promptSnapshot(context).presentable, true);
    assert.equal(promptSnapshot(context).requestable, false);
  }
});

test('missing sessions, child sessions and home are not presentable', () => {
  const changes = [context => { context.data.session.get = () => undefined; },
    context => { context.data.session.get = () => ({ parentID: 'parent' }); },
    context => { context.ui.router.current = () => ({ type: 'home' }); }];
  for (const change of changes) {
    const { context } = fixture();
    change(context);
    assert.equal(promptSnapshot(context).eligible, false);
  }
});

test('accept inserts only in the matching empty prompt and never submits', () => {
  const { context, editor } = fixture();
  const ready = { status: 'ready', sessionID: 's1', suggestion: 'Покрой изменения тестами' };
  assert.equal(insertPrediction(context, { ...ready, sessionID: 'another' }), false);
  assert.equal(insertPrediction(context, { ...ready, status: 'loading' }), false);
  assert.equal(insertPrediction(context, ready), true);
  assert.equal(editor.plainText, ready.suggestion);
  assert.equal(insertPrediction(context, ready), false);
});

test('editor subscriptions preserve existing listeners, follow focus, watch the caret and clean up', () => {
  const { renderer, editor } = fixture();
  let changed = 0, hostChanges = 0;
  const reasons = [];
  editor.editBuffer.on('content-changed', () => hostChanges++);
  const stop = watchPrompt(renderer, (reason) => { changed++; reasons.push(reason); });
  assert.equal(changed, 1);
  editor.insertText('a');
  assert.equal(changed, 2);
  assert.equal(reasons[1], 'content');
  assert.equal(hostChanges, 1);
  editor.editBuffer.emit('cursor-changed');
  assert.equal(changed, 3);
  assert.equal(reasons[2], 'cursor');
  editor.emit('traits-changed');
  assert.equal(changed, 4);
  assert.equal(reasons[3], undefined);
  renderer.currentFocusedEditor = undefined;
  renderer.emit('focused_editor');
  assert.equal(changed, 5);
  editor.insertText('b');
  assert.equal(changed, 5);
  assert.equal(hostChanges, 2);
  renderer.currentFocusedEditor = editor;
  renderer.emit('focused_editor');
  stop(); stop();
  const count = changed;
  renderer.emit('focused_editor');
  editor.insertText('c');
  editor.editBuffer.emit('cursor-changed');
  editor.emit('traits-changed');
  assert.equal(changed, count);
  assert.equal(hostChanges, 3);
  assert.equal(renderer.listenerCount('focused_editor'), 0);
  assert.equal(editor.editBuffer.listenerCount('content-changed'), 1);
  assert.equal(editor.editBuffer.listenerCount('cursor-changed'), 0);
});

test('ownership assigned after focus still enables change notifications', () => {
  const { renderer, editor } = fixture();
  editor.traits = { suspend: true };
  const reasons = [];
  const stop = watchPrompt(renderer, reason => reasons.push(reason));
  try {
    editor.traits = { owner: 'opencode', role: 'prompt', suspend: true, capture: ['tab'] };
    editor.emit('traits-changed');
    editor.insertText('Проверь');
    assert.deepEqual(reasons, [undefined, undefined, 'content']);
  } finally { stop(); }
});
