import { promptSnapshot } from '../editor/adapter.mjs';
import { buildContext } from '../prediction/context.mjs';
import { predictionModel } from './options.mjs';

/** Events that dismiss a shown or in-flight prediction for the active session. */
export const INVALIDATING_EVENTS = new Set([
  'session.inbox.enqueued',
  'session.execution.started',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.model.selected',
  'session.agent.selected',
  'session.moved',
  'session.revert.staged',
  'session.revert.committed',
  'session.compaction.started',
  'session.deleted',
]);

// The host adapter is the only layer that assembles OpenCode/editor data into
// the plain snapshot consumed by prediction and scheduling.
export function completionSnapshot(context, foreground) {
  const field = promptSnapshot(context);
  const id = field.sessionID;
  const running = Boolean(id && context.data.session.status(id) === 'running');
  const model = predictionModel(context);
  const recent = buildContext(id ? context.data.session.message.list(id) : [], { running, maxCharacters: 10000 });
  return {
    ...field,
    presentable: field.presentable && foreground,
    requestable: field.requestable && foreground && Boolean(model),
    model,
    context: recent.text,
    revision: recent.revision,
    running,
  };
}
