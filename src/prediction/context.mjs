import { createHash } from 'node:crypto';

const MAX_MESSAGES = 4;
const DEFAULT_MAX_CHARACTERS = 10000;

// Only textual parts of user and assistant messages are eligible. Tool calls,
// tool results, reasoning, files, images and system/instruction messages are
// never selected, so transient execution events cannot change the context.
const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text', 'message']);

function asList(messages) {
  if (Array.isArray(messages)) return messages;
  if (messages instanceof Map) return Array.from(messages.values());
  if (messages != null && typeof messages === 'object') return Object.values(messages);
  return [];
}

function roleOf(message) {
  const raw = message?.role ?? message?.info?.role ?? message?.payload?.role ?? message?.author?.role ?? message?.type;
  if (typeof raw !== 'string') return null;
  const role = raw.toLowerCase();
  return role === 'user' || role === 'assistant' ? role : null;
}

function partText(part) {
  if (typeof part === 'string') return part;
  if (part == null || typeof part !== 'object') return '';
  const type = typeof part.type === 'string' ? part.type.toLowerCase()
    : typeof part.kind === 'string' ? part.kind.toLowerCase()
      : null;
  if (type != null && !TEXT_PART_TYPES.has(type)) return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  return '';
}

function textOf(message) {
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.payload?.text === 'string') return message.payload.text;
  if (typeof message?.content === 'string') return message.content;
  const parts = Array.isArray(message?.parts) ? message.parts
    : Array.isArray(message?.payload?.parts) ? message.payload.parts
      : Array.isArray(message?.content) ? message.content
        : null;
  if (parts == null) return '';
  return parts.map(partText).filter(Boolean).join('\n');
}

function select(messages, running) {
  const entries = [];
  for (const message of asList(messages)) {
    const role = roleOf(message);
    if (role == null) continue;
    const text = textOf(message).trim();
    if (text.length === 0) continue;
    entries.push({ role, text });
  }

  let filtered = entries;
  if (running) {
    // Drop assistant output produced after the most recent user message: it is
    // the still-running reply, not completed conversation.
    let lastUser = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].role === 'user') { lastUser = index; break; }
    }
    if (lastUser >= 0) {
      filtered = entries.filter((entry, index) => entry.role === 'user' || index < lastUser);
    }
  }

  // At most four messages, favouring the newest.
  return filtered.slice(-MAX_MESSAGES);
}

function bound(selected, maxCharacters) {
  const limit = Number.isFinite(maxCharacters) && maxCharacters > 0
    ? Math.floor(maxCharacters)
    : DEFAULT_MAX_CHARACTERS;
  let list = selected.map(({ role, text }) => ({ role, text }));

  // Keep the newest conversation, not the older messages that happen to fit.
  while (list.length > 1 && JSON.stringify(list).length > limit) list.shift();

  for (;;) {
    const json = JSON.stringify(list);
    if (json.length <= limit || list.length === 0) return json;

    const last = list[list.length - 1];
    const head = list.slice(0, -1);
    if (last.text.length === 0) { list = head; continue; }

    const emptyJson = JSON.stringify([...head, { role: last.role, text: '' }]);
    if (emptyJson.length > limit) { list = head; continue; }

    // Truncate the oversized newest message by code points so a surrogate pair
    // is never split, and binary-search the largest cut that still fits.
    const points = [...last.text];
    let lo = 0;
    let hi = points.length;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = JSON.stringify([...head, { role: last.role, text: points.slice(0, mid).join('') }]);
      if (candidate.length <= limit) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    list = [...head, { role: last.role, text: points.slice(0, best).join('') }];
    return JSON.stringify(list);
  }
}

/**
 * Build the bounded JSON conversation context for a stateless prediction
 * request. Only recent user and assistant text is selected; tools, tool
 * results, reasoning, files, images and system messages are ignored. The
 * revision hashes the selected bounded data so transient events during a
 * running execution do not change it.
 *
 * @param {unknown} messages messages in chronological order (oldest first)
 * @param {{maxCharacters?: number, running?: boolean}} [options]
 * @returns {{text: string, revision: string}}
 */
export function buildContext(messages, { maxCharacters = DEFAULT_MAX_CHARACTERS, running = false } = {}) {
  const selected = select(messages, running === true);
  const text = bound(selected, maxCharacters);
  const revision = createHash('sha256').update(text, 'utf8').digest('hex');
  return { text, revision };
}
