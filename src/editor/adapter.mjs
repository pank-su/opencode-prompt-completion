const MAX_PREFIX_LENGTH = 2000;

export function focusedPrompt(renderer) {
  const editor = renderer.currentFocusedEditor;
  if (!editor || editor.isDestroyed || !editor.focused || !editor.focusable) return;
  if (editor.traits?.owner !== 'opencode' || editor.traits?.role !== 'prompt') return;
  return editor;
}

// Native cursor coordinates need not match JS UTF-16 indices. Compare text
// before the cursor against the whole buffer instead of comparing offsets.
function caretAtEnd(editor) {
  const cursor = editor.logicalCursor;
  const buffer = editor.editBuffer;
  if (!cursor || typeof buffer?.getTextRangeByCoords !== 'function') return false;
  return buffer.getTextRangeByCoords(0, 0, cursor.row, cursor.col) === editor.plainText;
}

export function promptSnapshot(context) {
  const route = context.ui.router.current();
  const editor = focusedPrompt(context.renderer);
  const sessionID = route.type === 'session' ? route.sessionID : undefined;
  const session = sessionID ? context.data.session.get(sessionID) : undefined;
  const prefix = editor?.plainText ?? '';
  const trimmed = prefix.trimStart();
  const capture = editor?.traits?.capture ?? [];
  // `suspend` disables native key handling while OpenCode's managed keymap owns the textarea.
  // It is not a disabled-input flag; disabled prompts lose focus/focusability instead.
  const presentable = Boolean(session && !session.parentID && editor
    && !editor.hasSelection() && caretAtEnd(editor)
    && prefix.length <= MAX_PREFIX_LENGTH
    && !trimmed.startsWith('/') && !trimmed.startsWith('!')
    && editor.traits.status !== 'SHELL'
    && !capture.some(value => ['submit', 'navigate', 'escape'].includes(value)));
  const requestable = Boolean(presentable && !context.data.session.pending.list(sessionID)?.length
    && !context.data.session.permission.list(sessionID)?.length
    && !context.data.session.form.list(sessionID, session.location)?.length);
  return { sessionID, editor, eligible: presentable, presentable, requestable, prefix };
}

export function insertPrediction(context, state) {
  const snapshot = promptSnapshot(context);
  if (!snapshot.eligible || state.status !== 'ready' || state.sessionID !== snapshot.sessionID
    || typeof state.suggestion !== 'string' || !state.suggestion
    || snapshot.prefix !== (state.prefix ?? '')) return false;
  snapshot.editor.insertText(state.suggestion);
  return true;
}

export function watchPrompt(renderer, changed) {
  let editor, disposed = false;
  const notify = () => { if (!disposed) changed(); };
  const content = () => { if (!disposed) changed('content'); };
  const cursor = () => { if (!disposed) changed('cursor'); };
  const detach = () => {
    editor?.editBuffer.off('content-changed', content);
    editor?.editBuffer.off('cursor-changed', cursor);
    editor?.off('traits-changed', notify);
    editor?.off('destroyed', notify);
  };
  const focus = () => {
    detach();
    // The host focuses a new textarea before assigning its owner/role traits.
    // Observe the raw editor so that later trait assignment is not missed;
    // promptSnapshot still gates requests and insertion by ownership.
    editor = renderer.currentFocusedEditor ?? undefined;
    editor?.editBuffer.on('content-changed', content);
    editor?.editBuffer.on('cursor-changed', cursor);
    editor?.on('traits-changed', notify);
    editor?.on('destroyed', notify);
    notify();
  };
  renderer.on('focused_editor', focus);
  focus();
  return () => {
    disposed = true;
    renderer.off('focused_editor', focus);
    detach();
    editor = undefined;
  };
}
